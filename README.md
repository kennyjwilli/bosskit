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
  { name: "send-email-dlq", schema: UserScopedSchema.extend({ to: z.string() }) },
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
  },
]);
```

`userId` lives in the job **payload**, not in pg-boss job metadata: put the
acting user in the schema and it travels with the job automatically — it's
still there on the row if the job ends up in a dead-letter queue, with no
separate plumbing needed to know who a failed job was running for.

## `defineQueues`

Declare a registry by calling `defineQueues`, not by writing a plain type
annotation:

```ts
const QUEUES = defineQueues([
  { name: "send-email", schema: UserScopedSchema.extend({ to: z.string() }) },
]);
```

This is what keeps `enqueue` and worker handlers precisely typed per queue —
and it means there's no `as const satisfies QueueDefinition[]` incantation to
remember at the call site.

### The widening trap

Three spellings keep the registry's types precise: `defineQueues([...])`, an
array literal passed straight into `createJobPlatform`, and
`[...] satisfies QueueDefinition[]`.

Two spellings destroy them, and both type-check:

```ts
// Both compile. Both throw the registry's precise types away.
const widened: QueueDefinition[] = [
  { name: "send-email", schema: UserScopedSchema.extend({ to: z.string() }) },
];
const alsoWidened: readonly QueueDefinition[] = [
  { name: "send-email", schema: UserScopedSchema.extend({ to: z.string() }) },
];
```

`readonly` does not save you. The symptom: `enqueue` stops catching wrong
payloads — every queue's payload collapses to the base `{ userId: string }`
shape — and stops rejecting dead-letter queue names, so
`enqueue({ queue: "a-queue-that-does-not-exist", ... })` compiles too.

If `enqueue` has stopped complaining about a payload you know is wrong, this
is why.

`ScheduleOf` collapses the same way: against a widened registry any string
queue and near-any `data` compile. `applySchedules` still catches it at boot —
an unknown queue throws `Unknown queue` and a bad payload fails validation —
but you lose the compile-time check.

## Dead-letter queues

Point a queue's `deadLetter` option at another queue's name:

```ts
defineQueues([
  { name: "send-email-dlq", schema: UserScopedSchema.extend({ to: z.string() }) },
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

Keep payload schemas JSON-round-trippable, and avoid `.transform()` on them —
a job's payload is written as JSON and read back as JSON, so a schema whose
parsed shape can't survive that round trip will fail validation on the way
back out.

Validation happens per **batch**, not per job: a payload that fails to parse
fails the whole batch, so the healthy jobs fetched alongside it retry and can
dead-letter along with it. This doesn't come up at the default `batchSize` of
1; with a larger `batchSize`, one bad payload can drag its batch-mates down
with it.

Every job is logged before the handler runs, with its queue, job id, retry
count, and the acting `userId` (when the queue is user-scoped) — so no
handler has to remember to trace who a job is for.

## Schedules

```ts
import type { ScheduleOf } from "bosskit";

// QUEUES is the registry from the opening example, which declares nightly-cleanup.
const schedules: ScheduleOf<typeof QUEUES>[] = [
  { cron: "0 3 * * *", data: { olderThanDays: 30 }, options: { tz: "UTC" }, queue: "nightly-cleanup" },
];

await applySchedules(boss, schedules);
```

`ScheduleOf<typeof QUEUES>` binds each schedule to one queue: a typo in `queue`
is a compile error, and `data` must be that queue's payload. Dead-letter queues
are excluded, as they are for `enqueue`.

`applySchedules` (returned by `createJobPlatform`, alongside `enqueue` and
`defineWorker`) first validates every schedule's payload, then upserts them all
and unschedules any schedule pg-boss still has recorded that you no longer
declare. Call it on every boot with your full, current list of schedules —
removing an entry from the list is how you turn a schedule off.

Validation matters more here than anywhere else in bosskit: pg-boss dispatches
scheduled jobs internally, so they never pass through `enqueue`. Without this
check an invalid payload surfaces as a job that fails at 03:00, retries,
dead-letters, and repeats every night, with nothing said at deploy time. An
invalid payload throws `JobPlatformError` and **no** schedule is applied — never
a partial sync from a bad payload. (This pre-flight only validates payloads: an
invalid cron expression or a queue pg-boss hasn't created yet is still caught
per-schedule inside the apply loop, so those can leave an earlier schedule in
the list applied.)

The check runs against the JSON round-tripped value, because that is what a
worker parses at fire time. A `z.date()` field handed a real `Date` is valid in
memory and invalid as the ISO string jsonb gives back — so it is rejected at
boot, which is the point. Keep schedule payloads plainly JSON-serializable.

`data` is required, and it is Zod's *output* type: a field declared with
`.default()` must still be supplied. It is stored exactly as you write it.

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

Annotate `toBossDb`'s parameter — that type becomes `enqueue`'s `db` type.
Left unannotated (`toBossDb: (handle) => ...`), `enqueue` will accept any
value as `db` without complaint.

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
`PgDatabase` supertype, not the type `drizzle(...)` itself returns — the
concrete type rejects a transaction handle. With drizzle over postgres-js, the
spelling that accepts both a pool handle and a transaction handle is:

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
docker run --rm -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgres:18
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

`pnpm prepublishOnly` runs `check`, `typecheck`, `test`, and `build` before
every release; `test:integration` is deliberately not part of it, so cutting a
release doesn't require a disposable Postgres container on hand.

## API reference

### `createJobPlatform(options)`

The framework's entry point. Takes `definitions` (a registry from
`defineQueues`), `getBoss` (resolves a started `PgBoss` instance),
`getRuntime` (resolves the context object passed to every worker handler),
`toBossDb` (adapts your database handle to pg-boss's `Db` contract), and
`logger`.

Two rules to follow when writing the providers:

- **Annotate `toBossDb`'s parameter.** That type becomes `enqueue`'s `db`
  type. Written unannotated (`toBossDb: (db) => fromDrizzle(db, sql)`),
  `enqueue` will accept literally any value as `db`, silently.
- **`getRuntime` runs once.** Don't compute per-call values in it (a fresh
  request id, `Date.now()`) — whatever it returns is what every handler gets
  for the life of the platform. Return plain data, not a class instance.

Returns `{ enqueue, enqueueWith, cancelJobs, defineWorker, ensureQueues,
applySchedules, schemaFor }` bound to that registry:

- **`enqueue`** — the sanctioned way to create a job. See the opening example.
  Returns the new job's id, or `null` when pg-boss declined to create one
  because the send was de-duplicated (a `singletonKey` already has a job in
  flight, for instance). `null` is a normal outcome, not an error — check for
  it before treating the return value as an id.
- **`enqueueWith(boss, args)`** — the same as `enqueue`, but takes an explicit
  `PgBoss` instance instead of resolving one through `getBoss`. Use it when
  you already have a boss instance in hand — most usefully in tests, where it
  avoids wiring a `getBoss` provider around the instance you already control.
- **`cancelJobs(queue, jobIds)`** — best-effort cancellation by id (e.g. when
  the domain record a job represents gets cancelled). Already-settled ids are
  a no-op. Cancelling stops a queued job from starting and prevents a retry of
  an active one, but does **not** abort a job already running on a worker —
  interrupt that in-process.
- **`defineWorker`** — see [Workers](#workers). `options` is optional —
  omit it entirely for a worker with nothing to configure.
- **`ensureQueues(boss)`** — creates any queue in the registry pg-boss doesn't
  have yet, and updates options on ones that already exist (`policy` and
  `partition` are immutable in pg-boss, so those are left alone on existing
  queues). Note: pg-boss's `update_queue` COALESCEs unspecified options to
  their current values, so removing an option from a definition does not
  reset it on an already-created queue — that needs a fresh queue or manual
  intervention. Call it on boot, before enqueuing to or working any queue.
- **`applySchedules`** — see [Schedules](#schedules).
- **`schemaFor(queue)`** — returns the queue's payload schema, typed so
  `.parse()` returns that queue's payload. Use it to validate or parse a
  payload yourself outside of `enqueue` or a worker handler. Throws
  `JobPlatformError` for a name that is not in the registry.

### `defineQueues(definitions)`

Declares a queue registry. See [`defineQueues`](#definequeues) above. Returns
the array unchanged — its only job is to pin the `const` type parameter. Each
entry is a `QueueDefinition`: `name`, `schema`, an optional `global`, and an
optional `options` (pg-boss's `createQueue` options minus `name`) — omit
`options` entirely for a queue with nothing to configure.

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

### `ScheduleOf<D>` / `ScheduleDefinition<Name>` / `schedulesToRemove(declared, existing)`

`ScheduleOf<D>` is the shape `applySchedules` takes for registry `D`: `{ queue,
cron, data, options? }`, with `queue` narrowed to the registry's sendable names
and `data` to that queue's payload. `ScheduleDefinition` is the loose,
registry-agnostic version of the same shape (`data` optional, any `queue`
string); `schedulesToRemove` consumes it, and `ScheduleOf<D>` is assignable to
it. `schedulesToRemove(declared, existing)` takes your declared schedule list
and pg-boss's existing schedules (from `boss.getSchedules()`) and returns the
ones that are no longer declared and would be turned off — useful for previewing
what a call to `applySchedules` would unschedule before you actually run it.
Application code normally only calls `applySchedules`, which does this diff for
you.

### `JobPlatformError`

Thrown by bosskit itself, never by a failed job: a misconfigured registry (the
same queue name declared twice) or a schedule whose declared payload doesn't
satisfy its queue's schema. Standard `Error` subclass: catch it with
`instanceof JobPlatformError`.

### Types

Exported for typing your own helpers around `enqueue`/`defineWorker`:

- **`JobLogger`** — the logging interface `createJobPlatform` expects;
  satisfied by a pino logger or `console`.
- **`JobOptions`** — the options `enqueue` accepts alongside `data` (pg-boss's
  own send options, minus `db`, which the platform supplies for you).
- **`QueueDefinition`** — one entry in a registry: `{ name, schema, global?,
  options? }`.
- **`QueueNameOf<D>`** — every queue name in a registry `D`, including
  dead-letter targets.
- **`QueuePayloadOf<D, Q>`** — the payload type for queue `Q` in registry `D`.
- **`SendableOf<D>`** — the queue names `enqueue` accepts, with dead-letter
  targets excluded; see [Dead-letter queues](#dead-letter-queues).
- **`ScheduleOf<D>`** — a schedule declaration bound to registry `D`, with
  `data` typed per queue; the parameter type of `applySchedules`.
- **`RegisteredWorker`** — the type `defineWorker` returns.
- **`UserScoped`** — `{ userId: string }`, the inferred type of
  `UserScopedSchema`.

## Requirements

- Node `>=22.12.0`
- `pg-boss` `>=12.21.0 <13` (peer dependency)
- `zod` `^4` (peer dependency)
- A Postgres database (whatever `pg-boss` itself requires)
- Zero runtime dependencies otherwise

## License

MIT
