# bosskit

Type-safe, user-scoped job queues for [pg-boss](https://github.com/timgit/pg-boss), powered by Zod.

Declare each queue once with a Zod schema. Get a typed `enqueue`, typed worker
handlers, runtime validation at both boundaries, and a compile error if you
forget who a job is for.

```ts
import { createBoss, createJobPlatform, defineQueues, $UserScoped } from "bosskit";
import { fromDrizzlePostgres } from "bosskit/drizzle";
import { sql } from "drizzle-orm";
import { z } from "zod";

const QUEUES = defineQueues([
  { name: "send-email-dlq", schema: $UserScoped.extend({ to: z.string() }), options: {} },
  {
    name: "send-email",
    schema: $UserScoped.extend({ to: z.string() }),
    options: { deadLetter: "send-email-dlq", notify: true, retryLimit: 3 },
  },
]);

export const { enqueue, defineWorker, ensureQueues } = createJobPlatform({
  definitions: QUEUES,
  getBoss: async () => boss,
  getRuntime: async () => ({ db, mailer }),
  toBossDb: (handle: Db) => fromDrizzlePostgres(handle, sql),
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

Requires Node `>=22.12`.

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
`$UserScoped` base schema bosskit exports:

```ts
import { $UserScoped } from "bosskit";
import { z } from "zod";

const schema = $UserScoped.extend({ to: z.string() });
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
  { name: "send-email", schema: $UserScoped.extend({ to: z.string() }), options: {} },
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
site — `defineQueues([...])` is the only spelling, and it's the correct one by
construction. Passing a plain array (`const QUEUES: QueueDefinition[] = [...]`)
type-checks but silently collapses every payload type down to the common
`QueueDefinition` shape, which stops `enqueue` from checking domain fields.

## Dead-letter queues

Point a queue's `deadLetter` option at another queue's name:

```ts
defineQueues([
  { name: "send-email-dlq", schema: $UserScoped.extend({ to: z.string() }), options: {} },
  {
    name: "send-email",
    schema: $UserScoped.extend({ to: z.string() }),
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
`JobWithMetadata<Payload>`, already validated against the queue's schema. A
handler never opens its own connection or parses a payload; if a payload
fails validation, the job throws, so it fails and retries/dead-letters like
any other handler error.

Every job is logged before the handler runs, with its queue, job id, retry
count, and the acting `userId` (when the queue is user-scoped) — so no
handler has to remember to trace who a job is for.

## Schedules

```ts
import type { ScheduleDefinition } from "bosskit";

const schedules: ScheduleDefinition<(typeof QUEUES)[number]["name"]>[] = [
  { queue: "nightly-cleanup", cron: "0 3 * * *", options: { tz: "UTC" } },
];

await applySchedules(boss, schedules);
```

`applySchedules` (returned by `createJobPlatform`, alongside `enqueue` and
`defineWorker`) is an idempotent sync: it upserts every schedule you pass in,
then unschedules any schedule pg-boss still has recorded that you no longer
declare. Call it on every boot with your full, current list of schedules —
removing an entry from the list is how you turn a schedule off.

## Adapters

`enqueue` takes a `db` handle and adapts it to pg-boss's own database contract
via the `toBossDb` function you pass to `createJobPlatform`. The core package
has no ORM dependency; adapters are opt-in leaf modules.

### `bosskit/drizzle`

For drizzle + [postgres-js](https://github.com/porsager/postgres):

```ts
import { fromDrizzlePostgres } from "bosskit/drizzle";
import { sql } from "drizzle-orm";

toBossDb: (handle: Db) => fromDrizzlePostgres(handle, sql);
```

This ships separately from the core because pg-boss's own built-in
`fromDrizzle` adapter assumes a node-postgres-shaped `{ rows }` result. It
breaks on postgres-js, whose query result is a bare `RowList` array — reading
`.rows` off each row of that array returns `undefined`. `fromDrizzlePostgres`
unwraps the postgres-js result correctly instead.

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

Pass the result as `toBossDb` in `createJobPlatform`.

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
`PgDatabase` supertype, not a concrete instantiation like the type
`drizzle(...)` itself returns — the concrete type carries an extra `$client`
property that a transaction handle doesn't have, so it rejects `tx`. Typing
`Db` as the `PgDatabase` supertype is exactly what lets one `enqueue` function
accept both a pool handle and a transaction handle.

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
`logger`. Returns `{ enqueue, enqueueWith, cancelJobs, defineWorker,
ensureQueues, applySchedules, schemaFor }` bound to that registry:

- **`enqueue`** — the sanctioned way to create a job. See the opening example.
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
  outside those paths.

### `defineQueues(definitions)`

Declares a queue registry. See [`defineQueues`](#definequeues) above. Returns
the array unchanged — its only job is to pin the `const` type parameter.

### `$UserScoped`

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

### `fromDrizzlePostgres(db, sql)` (`bosskit/drizzle`)

Adapts a drizzle postgres-js handle (pool or transaction) plus its `sql` tag
into pg-boss's `Db` contract. See [Adapters](#adapters) above.

### `parsePlaceholders(text, values)` (`bosskit/drizzle`)

Parses `$N`-style SQL placeholders out of `text` into literal string segments
plus the corresponding values in textual order (`{ parts, reordered }`),
duplicating a value at each occurrence if its placeholder index repeats. It
re-implements a helper pg-boss keeps as an unexported internal, and is used by
`fromDrizzlePostgres` to rebuild a tagged-template call for drizzle's `sql`
function. Exported because anyone writing their own drizzle-flavored adapter
(see [Writing your own](#writing-your-own)) needs the same parsing and would
otherwise have to duplicate it — it is not needed for ordinary usage of
`fromDrizzlePostgres`.

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
- `pg-boss` `>=12` (peer dependency)
- `zod` `^4.4` (peer dependency)
- A Postgres database (whatever `pg-boss` itself requires)
- Zero runtime dependencies otherwise

## License

MIT
