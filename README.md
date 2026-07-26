# bosskit

Type-safe, user-scoped job queues for [pg-boss](https://github.com/timgit/pg-boss), powered by Zod.

Declare each queue once with a Zod schema. Get a typed `enqueue`, typed worker
handlers, runtime validation at both boundaries, and a compile error if you
forget who a job is for.

```ts
import { createBoss, createJobPlatform, defineQueues, UserScopedSchema } from "bosskit";
import { fromDrizzle } from "pg-boss";
import { sql } from "drizzle-orm";
import { z } from "zod";

const QUEUES = defineQueues([
  { name: "send-email-dlq", schema: UserScopedSchema.extend({ to: z.string() }), options: {} },
  {
    name: "send-email",
    schema: UserScopedSchema.extend({ to: z.string() }),
    options: { deadLetter: "send-email-dlq", notify: true, retryLimit: 3 },
  },
  // `global: true` opts a queue out of the user-scoped default — see below.
  {
    name: "nightly-cleanup",
    global: true,
    schema: z.object({ olderThanDays: z.number() }),
    options: {},
  },
]);

export const { enqueue, defineWorker, ensureQueues, applySchedules } = createJobPlatform({
  definitions: QUEUES,
  getBoss: async () => boss,
  getRuntime: async () => ({ db, mailer }),
  toBossDb: (handle: Db) => fromDrizzle(handle, sql),
  logger: console,
});

// Fully typed — the payload shape comes from the queue's schema:
await enqueue({ db, queue: "send-email", data: { to: "a@b.com", userId: "user_123" } });

// @ts-expect-error send-email-dlq is a dead-letter target, not enqueue-able
await enqueue({ db, queue: "send-email-dlq", data: { to: "a@b.com", userId: "user_123" } });
```

Call `ensureQueues(boss)` once on boot, before enqueuing to or working any
queue — it creates whatever queue in the registry pg-boss doesn't have yet,
and syncs options on the ones it does. See
[`createJobPlatform`](#createjobplatformoptions) below for what each of the
seven returned functions does.

## Install

```sh
pnpm add bosskit pg-boss zod
```

Requires Node `>=22.12`. This package is ESM-only — there is no CommonJS
build, so `require("bosskit")` will not work.

## Why

Most pg-boss setups end up with a hand-written type per queue, a hand-written
map from queue name to type, and a `boss.send`/`boss.work` call site that
trusts both. The map and the calls drift from the schema over time, silently.

bosskit collapses all of that into one Zod schema per queue:

- The payload **type** for `enqueue` and for worker handlers is inferred from
  the schema — no hand-written map to keep in sync.
- The payload is **validated at runtime** against the same schema, both when
  you enqueue and again when a worker picks the job up.
- A queue named as another queue's `deadLetter` is automatically excluded from
  the enqueue-able set — you cannot accidentally enqueue directly to a DLQ.
- Every payload schema is required to carry the acting user, so a queue with
  no notion of who it's for is a compile error, not a discovery made while
  reading a dead-letter row.
- Zero runtime dependencies. `pg-boss` and `zod` are peer dependencies you
  already have.

## User-scoped by default

Every queue is **user-scoped** unless it opts out. A user-scoped queue's
schema must produce `userId: string` — the easiest way is to extend the
`UserScopedSchema` base schema bosskit exports:

```ts
import { UserScopedSchema } from "bosskit";
import { z } from "zod";

const schema = UserScopedSchema.extend({ to: z.string() });
// z.infer<typeof schema> is { userId: string; to: string }
```

System work that genuinely has no acting user — cron sweeps, maintenance jobs
— opts out explicitly with `global: true` on the queue definition:

```ts
defineQueues([
  {
    name: "nightly-cleanup",
    global: true,
    schema: z.object({ olderThanDays: z.number() }),
    options: {},
  },
]);
```

`userId` lives in the job **payload**, not in pg-boss job metadata, for a
specific reason: `data` is the only user-controlled channel pg-boss offers,
and pg-boss's dead-letter hop copies `data` verbatim into the DLQ row. Putting
the acting user in the payload means it survives into dead-letter queues for
free — no separate plumbing needed to know who a failed job was running for.

## `defineQueues`

Declare a registry by calling `defineQueues`, not by writing a plain type
annotation:

```ts
const QUEUES = defineQueues([
  { name: "send-email", schema: UserScopedSchema.extend({ to: z.string() }), options: {} },
]);
```

`defineQueues`'s type parameter is declared `const D extends readonly
QueueDefinition[]`. The `const` modifier preserves the literal registry tuple
— each entry's exact `name` string and exact `schema` type — rather than
widening it to `QueueDefinition[]`. That literal tuple is what every derived
type (`QueueNameOf`, `QueuePayloadOf`, `SendableOf`) is computed from, so it's
what keeps `enqueue` and worker handlers precisely typed per queue.

Because the function itself does the `const` binding, there's no
`as const satisfies QueueDefinition[]` incantation to remember at the call
site.

### The widening trap

Three spellings keep the registry's types precise: `defineQueues([...])`, an
array literal passed straight into `createJobPlatform`, and
`[...] satisfies QueueDefinition[]`.

Two spellings destroy them, and both type-check:

```ts
// Both compile. Both throw the registry's precise types away.
const widened: QueueDefinition[] = [
  { name: "send-email", schema: UserScopedSchema.extend({ to: z.string() }), options: {} },
];
const alsoWidened: readonly QueueDefinition[] = [
  { name: "send-email", schema: UserScopedSchema.extend({ to: z.string() }), options: {} },
];
```

`readonly` does not save you. When a registry widens you lose two guarantees
at once, with no diagnostic anywhere:

- `QueuePayloadOf` collapses to the base user-scoped shape (`{ userId: string
  }`), so `enqueue` stops type-checking domain fields — the entire point of
  declaring a schema per queue.
- `SendableOf` collapses to `string`, so the dead-letter guard silently
  disappears and `enqueue({ queue: "a-queue-that-does-not-exist", ... })`
  compiles too.

If `enqueue` has stopped complaining about a payload you know is wrong, this
is why.

## Dead-letter queues

Point a queue's `deadLetter` option at another queue's name:

```ts
defineQueues([
  { name: "send-email-dlq", schema: UserScopedSchema.extend({ to: z.string() }), options: {} },
  {
    name: "send-email",
    schema: UserScopedSchema.extend({ to: z.string() }),
    options: { deadLetter: "send-email-dlq" },
  },
]);
```

Any queue named by some other queue's `deadLetter` is removed from the set
`enqueue` accepts — this is derived from the registry, not a separate list you
maintain, so a new DLQ is automatically protected the moment you declare it.
pg-boss populates a DLQ itself when a job exhausts its retries; application
code never sends to one directly.

## Workers

```ts
const worker = defineWorker({
  queue: "send-email",
  options: { pollingIntervalSeconds: 2 },
  handler: async ({ jobs, db, mailer }) => {
    for (const job of jobs) {
      await mailer.send({ to: job.data.to, userId: job.data.userId });
    }
  },
});

await worker.register(boss);
```

The handler's first argument is the runtime object returned by `getRuntime`
(`{ db, mailer }` in the opening example) merged with `jobs` — an array of
`JobWithMetadata<Payload>` whose `data` has already been run through the
queue's schema, so schema coercions and defaults are applied before the
handler sees them (a `z.coerce.date()` field arrives as a `Date`, not the
string jsonb gave back). A handler never opens its own connection or parses a
payload.

Payload schemas should stay JSON-round-trippable: `enqueue` types `data` as
the schema's output but feeds it to `.parse()` as input, so a non-idempotent
`.transform()` will not survive the round trip.

Validation happens per **batch**, not per job. If any payload in a batch fails
to parse, the whole batch throws, so it fails and retries/dead-letters like
any other handler error — including the healthy jobs that happened to be
fetched alongside the bad one. With the default `batchSize` of 1 that
distinction doesn't arise; with a larger one, a single poison payload can drag
its batch-mates to the dead-letter queue with it.

Every job is logged before the handler runs, with its queue, job id, retry
count, and the acting `userId` (when the queue is user-scoped) — so no
handler has to remember to trace who a job is for.

## Schedules

```ts
import type { QueueNameOf, ScheduleDefinition } from "bosskit";

// QUEUES is the registry from the opening example, which declares nightly-cleanup.
const schedules: ScheduleDefinition<QueueNameOf<typeof QUEUES>>[] = [
  { queue: "nightly-cleanup", cron: "0 3 * * *", data: { olderThanDays: 30 }, options: { tz: "UTC" } },
];

await applySchedules(boss, schedules);
```

`QueueNameOf<typeof QUEUES>` is the registry's set of queue names, so a typo
in `queue` is a compile error rather than a schedule that silently targets
nothing.

`applySchedules` (returned by `createJobPlatform`, alongside `enqueue` and
`defineWorker`) is an idempotent sync: it upserts every schedule you pass in,
then unschedules any schedule pg-boss still has recorded that you no longer
declare. Call it on every boot with your full, current list of schedules —
removing an entry from the list is how you turn a schedule off.

## Adapters

`enqueue` takes a `db` handle and adapts it to pg-boss's own database contract
via the `toBossDb` function you pass to `createJobPlatform`. bosskit ships no
adapter of its own and has no ORM dependency — pg-boss already exports one per
client: `fromDrizzle`, `fromKnex`, `fromKysely`, `fromPrisma` and `fromPglite`.

```ts
import { fromDrizzle } from "pg-boss";
import { sql } from "drizzle-orm";

toBossDb: (handle: Db) => fromDrizzle(handle, sql);
```

Annotate `toBossDb`'s parameter. `createJobPlatform` infers the type of every
`enqueue`'s `db` argument from it, so an unannotated `toBossDb: (handle) =>
...` infers `unknown` and `enqueue` will then accept any value as `db` without
complaint.

One version note if you use drizzle over
[postgres-js](https://github.com/porsager/postgres): pg-boss's `fromDrizzle`
only handles postgres-js's bare row-array result from **12.26.3** onward — on
12.21.0 through 12.26.2 it both rejects the handle at compile time and
mis-reads the rows at runtime. Other drivers (node-postgres and friends,
which return `{ rows }`) are fine across the whole supported range.

Pass a transaction handle (not a pooled client) to make job creation atomic
with your domain writes — see [Transactions](#transactions) below.

### Writing your own

pg-boss's `Db` contract is small: an object with one method,
`executeSql(text, values?)`, returning `{ rows: unknown[] }`. Any client can
satisfy it directly:

```ts
import type { Db } from "pg-boss";

function fromMyClient(client: { query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }> }): Db {
  return {
    executeSql: (text, values) => client.query(text, values),
  };
}
```

Pass the result as `toBossDb` in `createJobPlatform`. Give the parameter an
explicit type, as above — that type becomes `enqueue`'s `db` type.

## Transactions

`enqueue`'s `db` argument is whatever `toBossDb` accepts — typically a pool
handle, but it can just as well be a transaction handle. Passing a
transaction makes job creation atomic with the rest of that transaction's
writes: if the transaction rolls back, the job was never created. pg-boss's
NOTIFY (when `notify: true` is set on the queue) fires once the transaction
commits, so a worker never picks up a job whose surrounding write hasn't
landed yet.

```ts
await db.transaction(async (tx) => {
  await tx.insert(emails).values({ to, userId });
  await enqueue({ db: tx, queue: "send-email", data: { to, userId } });
});
```

For `tx` to typecheck as `enqueue`'s `db` argument, the type you use for `Db`
(the parameter type of your `toBossDb` function) must be drizzle's abstract
`PgDatabase` supertype, not the type `drizzle(...)` itself returns — that one
carries an extra `$client` property a transaction handle doesn't have, so it
rejects `tx`. With drizzle over postgres-js, the spelling that accepts both a
pool handle and a transaction handle is:

```ts
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { PostgresJsQueryResultHKT } from "drizzle-orm/postgres-js";

type Db = PgDatabase<PostgresJsQueryResultHKT, Record<string, unknown>>;
```

Both type arguments matter: leaving the schema parameter at its default
(`Record<string, never>`) rejects a handle created with a schema, and the
first one names the driver. Swap `PostgresJsQueryResultHKT` for your driver's
equivalent (`NodePgQueryResultHKT`, and so on).

## Testing / contributing

Unit tests need no external services:

```sh
pnpm test
```

Integration tests exercise real pg-boss + Postgres round trips (queue
creation, enqueue, worker delivery, schema validation) and need a Postgres
reachable at `TEST_DATABASE_URL` that the test run may freely `CREATE` and
`DROP` databases on. Point it at a disposable container, not anything you
care about:

```sh
docker run --rm -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgres:17
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres pnpm test:integration
```

Each integration test file creates its own throwaway database (named after
the test file) and drops it on teardown, so runs don't collide and leave
nothing behind on success.

Before sending a change:

```sh
pnpm check      # biome lint + format
pnpm typecheck
pnpm test
pnpm test:integration
pnpm build
```

`pnpm prepublishOnly` runs `check`, `typecheck`, `test`, and `build` — the
same steps CI runs, minus `test:integration`. That omission is deliberate:
cutting a release shouldn't require a disposable Postgres container on hand,
and by the time a release is cut, CI has already run the full suite —
including integration tests — against the commit being published. Integration
coverage lives in CI, not in the publish gate.

## API reference

### `createJobPlatform(options)`

The framework's entry point. Takes `definitions` (a registry from
`defineQueues`), `getBoss` (resolves a started `PgBoss` instance),
`getRuntime` (resolves the context object passed to every worker handler),
`toBossDb` (adapts your database handle to pg-boss's `Db` contract), and
`logger`.

Two things about the providers are easy to get wrong:

- **`toBossDb`'s parameter must be annotated.** `createJobPlatform` infers
  `TDb` — the type of every `enqueue`'s `db` argument — from it. Written
  unannotated (`toBossDb: (db) => fromDrizzle(db, sql)`), `TDb` falls back to
  `unknown` and `enqueue` will then accept literally any value as `db`,
  silently.
- **`getRuntime` resolves at most once.** It is memoized lazily on the first
  worker registration and re-run only if it rejected, so a value computed per
  call — a fresh request id, a `Date.now()` — is frozen at whatever the first
  call produced. The runtime also reaches handlers through the shallow spread
  `{ ...runtime, jobs }`, which drops the prototype: return plain data, not a
  class instance, or the handler gets an object with none of its methods.

Returns `{ enqueue, enqueueWith, cancelJobs, defineWorker, ensureQueues,
applySchedules, schemaFor }` bound to that registry:

- **`enqueue`** — the sanctioned way to create a job. See the opening example.
  Returns the new job's id, or `null` when pg-boss declined to create one
  because the send was de-duplicated (a `singletonKey` already has a job in
  flight, for instance). `null` is a normal outcome, not an error — check for
  it before treating the return value as an id.
- **`enqueueWith(boss, args)`** — the same as `enqueue`, but takes an explicit
  `PgBoss` instance instead of resolving one through `getBoss`. `enqueue` is
  just `enqueueWith` bound to `getBoss()`; the explicit-instance form exists
  so tests can pass a boss they control directly, without wiring a `getBoss`
  provider around it.
- **`cancelJobs(queue, jobIds)`** — best-effort cancellation by id (e.g. when
  the domain record a job represents gets cancelled). Already-settled ids are
  a no-op. Cancelling stops a queued job from starting and prevents a retry of
  an active one, but does **not** abort a job already running on a worker —
  interrupt that in-process.
- **`defineWorker`** — see [Workers](#workers).
- **`ensureQueues(boss)`** — creates any queue in the registry pg-boss doesn't
  have yet, and updates options on ones that already exist (`policy` and
  `partition` are immutable in pg-boss, so those are left alone on existing
  queues). Note: pg-boss's `update_queue` COALESCEs unspecified options to
  their current values, so removing an option from a definition does not
  reset it on an already-created queue — that needs a fresh queue or manual
  intervention. Call it on boot, before enqueuing to or working any queue.
- **`applySchedules`** — see [Schedules](#schedules).
- **`schemaFor(queue)`** — looks up a queue's payload schema at runtime, typed
  so `.parse()` returns that queue's payload. This is what `enqueue` and
  worker validation use internally to validate at both boundaries; exposed so
  application code can validate or parse a payload against the same schema
  outside those paths. Throws `JobPlatformError` for a name that is not in the
  registry — reachable when the registry type has widened, since the name type
  is then just `string`.

### `defineQueues(definitions)`

Declares a queue registry. See [`defineQueues`](#definequeues) above. Returns
the array unchanged — its only job is to pin the `const` type parameter.

### `UserScopedSchema`

`z.object({ userId: z.string() })`. The base schema every user-scoped queue's
payload schema should `.extend()`.

### `createBoss(options)`

A thin, opinionated `PgBoss` factory: sets `application_name`, a default
`max` pool size (`5`) and `schema` (`"pgboss"`), and wires the
`error`/`warning` events to your logger so an unhandled pg-boss `error` event
can't crash the process. Takes `connectionString`, `migrate`, and `logger`,
with optional `max`, `applicationName` (defaults to `"bosskit"`), and
`schema` (defaults to `"pgboss"`). Returns a plain `PgBoss` instance —
starting, stopping, and caching it is still your responsibility.

### `ScheduleDefinition<Name>` / `schedulesToRemove(declared, existing)`

`ScheduleDefinition` is the shape passed to `applySchedules`: `{ queue, cron,
data?, options? }`. `schedulesToRemove` is the pure diff `applySchedules` uses
internally — given a declared list and pg-boss's existing schedules, it
returns the ones no longer declared. Exported mainly for testing; application
code normally only calls `applySchedules`.

### `JobPlatformError`

Thrown by `createJobPlatform` itself when the registry is misconfigured (for
example, the same queue name declared twice) — a `JobPlatformError` means a
programming mistake in the registry, never a failed job. A plain `Error`
subclass, so `instanceof JobPlatformError` works without any application
error framework.

### Types

`JobLogger`, `JobOptions`, `QueueDefinition`, `QueueNameOf<D>`,
`QueuePayloadOf<D, Q>`, `SendableOf<D>`, `RegisteredWorker`, and `UserScoped`
are exported for typing your own helpers around `enqueue`/`defineWorker` — see
`src/types.ts` for the exact shapes.

## Requirements

- Node `>=22.12.0`
- `pg-boss` `>=12.21.0 <13` (peer dependency). 12.21.0 is the first release
  whose type surface this package compiles against (`useListenNotify` in
  `ConstructorOptions`); the upper bound is deliberate — pg-boss changed its
  types substantially across 11 → 12, so 13 needs a deliberate look.
- `zod` `^4` (peer dependency)
- A Postgres database (whatever `pg-boss` itself requires)
- Zero runtime dependencies otherwise

## License

MIT
