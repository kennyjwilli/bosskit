import type { JobWithMetadata, PgBoss } from "pg-boss";
import { z } from "zod";

/**
 * Generic job-platform types. Nothing in this package knows anything about the
 * application using it: no concrete queue, no configuration shape, no database
 * type. A concrete instance is built by calling `createJobPlatform` with a
 * queue registry and providers — see the README.
 */

/** The minimal logging surface the platform needs; a pino logger satisfies it. */
export type JobLogger = {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
};

/**
 * The acting user a job runs on behalf of — the identity a worker resolves
 * credentials, tenancy or permissions from, and the one every job log line
 * carries. A user-scoped queue's payload extends this; see `QueueDefinition`
 * for the `global` opt-out used by system jobs that have no user.
 *
 * This lives in the payload (not pg-boss job metadata) because `data` is the
 * only user-controlled channel pg-boss offers — and because the DLQ hop copies
 * `data` verbatim, the acting user survives into dead-letter queues for free.
 */
export const UserScopedSchema = z.object({ userId: z.string() });
export type UserScoped = z.infer<typeof UserScopedSchema>;

type QueueOptions = NonNullable<Parameters<PgBoss["createQueue"]>[1]>;

type QueueDefinitionBase = {
  name: string;
  /** pg-boss queue options. Omit entirely for a queue with nothing to configure. */
  options?: Omit<QueueOptions, "name">;
};

/**
 * A queue definition. By DEFAULT a queue is user-scoped: its payload schema
 * must produce a `userId`, so forgetting the acting user on a new queue is a
 * compile error rather than a runtime surprise discovered in a worker. System
 * work that genuinely has no user on whose behalf it runs — cron sweeps,
 * maintenance jobs — opts out explicitly with `global: true`.
 *
 * Because `enqueue`'s `data` parameter is derived from this schema
 * (`QueuePayloadOf`), the constraint also makes it a compile error to enqueue
 * without a user, or to drop the user across a chain hop.
 *
 * IMPORTANT: never store a registry in a variable annotated `QueueDefinition[]`
 * or `readonly QueueDefinition[]`. Both spellings widen it, and widening costs
 * two guarantees at once, silently:
 *
 * - `QueuePayloadOf` collapses to this type's base user-scoped shape, so
 *   `enqueue` stops type-checking domain fields entirely.
 * - `SendableOf` collapses to `string`, so the dead-letter exclusion disappears
 *   and any queue name — including one that does not exist — compiles.
 *
 * Three spellings keep it precise: `defineQueues([...])`, an array literal
 * passed straight into `createJobPlatform`, and `[...] satisfies
 * QueueDefinition[]`. Prefer `defineQueues` — it checks each entry against this
 * constraint without widening what it stores.
 */
export type QueueDefinition =
  | (QueueDefinitionBase & {
      global?: false;
      /** Zod schema for this queue's job payload — the single source of truth
       * for both the compile-time payload type and the runtime boundary
       * validation. Must carry the acting user (see `UserScopedSchema`). */
      schema: z.ZodType<UserScoped>;
    })
  | (QueueDefinitionBase & {
      /** This queue's jobs run on behalf of no one — system work only. */
      global: true;
      /** Zod schema for this queue's job payload — the single source of truth
       * for both the compile-time payload type and the runtime boundary
       * validation. `object` because a pg-boss payload is always JSON. */
      schema: z.ZodType<object>;
    });

/** Every queue name in a registry. Broader than `SendableOf`: includes DLQs. */
export type QueueNameOf<D extends readonly QueueDefinition[]> = D[number]["name"];

/**
 * Payload type per queue, inferred from each declared Zod schema — the derived
 * contract for `enqueue` and worker handlers, with no hand-written map to keep
 * in sync. Modelled as an indexed access (not `Extract` + `z.infer`) so it
 * resolves to a concrete object type for a generic `Q`, e.g. inside `enqueue`.
 */
type QueuePayloadMapOf<D extends readonly QueueDefinition[]> = {
  [E in D[number] as E["name"]]: z.infer<E["schema"]>;
};
/**
 * The `& object` states what is already true — a pg-boss payload is JSON — and
 * is applied here rather than inside the map on purpose: with both `D` and `Q`
 * generic the map lookup stays deferred, so only an intersection at this level
 * keeps a payload provably assignable to `boss.send`'s `object` parameter.
 */
export type QueuePayloadOf<
  D extends readonly QueueDefinition[],
  Q extends QueueNameOf<D>,
> = QueuePayloadMapOf<D>[Q] & object;

/**
 * Per-slot `options`, defaulting to `undefined` for a definition that omits it
 * entirely. A plain `D[number]["options"]` indexed access does not work once
 * `options` is optional: a tuple entry that omits the key altogether has no
 * `options` property at all, and indexed access on a union requires every
 * member to carry the key, so the lookup would fail to compile the moment any
 * entry left `options` out. Distributing over `keyof D` (each tuple slot,
 * rather than the merged `D[number]` union) sidesteps that — an entry without
 * `options` just contributes `undefined` instead of breaking the type for
 * every other entry.
 */
type OptionsTupleOf<D extends readonly QueueDefinition[]> = {
  [K in keyof D]: "options" extends keyof D[K] ? D[K]["options"] : undefined;
};

/**
 * Every dead-letter target named by some queue's `deadLetter` option. You never
 * enqueue to a DLQ (pg-boss copies failed jobs into it automatically), so these
 * are excluded from the enqueue-able set below.
 */
type DeadLetterOf<D extends readonly QueueDefinition[]> = Extract<
  OptionsTupleOf<D>[number],
  { deadLetter: string }
>["deadLetter"];

/**
 * The queues application code may enqueue to: every defined queue minus the
 * dead-letter targets. Derived, so declaring a new DLQ automatically keeps it
 * off the enqueue surface.
 */
export type SendableOf<D extends readonly QueueDefinition[]> = Exclude<
  QueueNameOf<D>,
  DeadLetterOf<D>
>;

type SendOptionsOf = NonNullable<Parameters<PgBoss["send"]>[2]>;
/** pg-boss send options, minus `db` — the platform owns db threading. */
export type JobOptions = Omit<SendOptionsOf, "db">;

/**
 * A worker registered against a queue, type-erased for storage in a worker
 * list. `defineWorker` binds the queue → payload → handler types; `register`
 * closes over them so a heterogeneous worker list needs no shared handler type.
 */
export type RegisteredWorker = {
  queue: string;
  register: (boss: PgBoss) => Promise<string>;
};

/**
 * A hook wrapping every worker's run, for concerns that must not be
 * per-worker opt-in — tracing, alerting, log context. Registered once on the
 * platform, so it applies to every worker by construction.
 *
 * `jobs` is deliberately `unknown`: middleware runs OUTSIDE the parse loop, so
 * these payloads have not been validated — coercions and defaults are
 * unapplied and the data may not satisfy the schema at all. Typing them as the
 * queue's payload would be a lie. `queue` keeps its exact literal type, so
 * branching on queue name is fully checked.
 *
 * Properties that will bite you if you don't know them:
 *
 * 1. Runs once per BATCH, not once per job. Identical at the default
 *    `batchSize` of 1; not above it.
 * 2. Wraps payload validation as well as the handler, so a payload that fails
 *    `schema.parse` throws through `next()` and is observable here.
 * 3. Swallowing an error MARKS THE JOB COMPLETE. pg-boss completes a batch when
 *    the callback resolves and fails it when the callback throws, so catching
 *    without rethrowing suppresses the retry and the dead-letter hop.
 *    Middleware that reports errors must rethrow.
 * 4. Not calling `next()` skips the handler and completes the job.
 *
 * `next()` is not idempotent: calling it twice re-parses the batch and
 * re-runs the handler.
 *
 * The platform awaits this and discards whatever it resolves to, so its
 * signature returns `Promise<void>` — there is no channel back into pg-boss's
 * job output.
 */
export type JobMiddleware<TName extends string = string> = (
  ctx: { jobs: JobWithMetadata<unknown>[]; queue: TName },
  next: () => Promise<void>
) => Promise<void>;

/**
 * Declare a queue registry.
 *
 * The `const` type parameter preserves the literal tuple, so every derived type
 * (`QueueNameOf`, `QueuePayloadOf`, `SendableOf`) stays precise. This is the
 * recommended way to build a registry: the alternative spellings
 * `const QUEUES: QueueDefinition[] = [...]` and
 * `const QUEUES: readonly QueueDefinition[] = [...]` both type-check but widen,
 * which collapses every payload to `UserScoped` AND collapses the enqueue-able
 * name set to `string` — so domain fields stop being checked and the
 * dead-letter guard quietly stops guarding. Calling a function instead of
 * writing a type annotation makes that mistake unspellable.
 */
export function defineQueues<const D extends readonly QueueDefinition[]>(defs: D): D {
  return defs;
}
