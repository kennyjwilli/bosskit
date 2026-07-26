import type { JobWithMetadata, PgBoss, Db as PgBossDb, WorkOptions } from "pg-boss";
import type { z } from "zod";
import { JobPlatformError } from "./errors";
import { type ScheduleDefinition, schedulesToRemove } from "./schedules";
import {
  $UserScoped,
  type JobLogger,
  type JobOptions,
  type QueueDefinition,
  type QueueNameOf,
  type QueuePayloadOf,
  type RegisteredWorker,
  type SendableOf,
} from "./types";

/**
 * Build a job platform bound to one queue registry.
 *
 * This is the framework's only entry point, and the reason `src/lib/jobs/`
 * knows nothing about this application. Everything app-shaped arrives through
 * arguments:
 *
 * - `definitions` — the queue registry. Both the compile-time payload types and
 *   the runtime boundary validation derive from it, so the app declares each
 *   queue exactly once.
 * - `getBoss` — resolves a *started* pg-boss instance. A provider rather than an
 *   instance because the boss is not started at module-evaluation time; the app
 *   owns creation, caching and config.
 * - `getRuntime` — resolves whatever context handlers should receive (this app
 *   passes `{ db, config }`). Its return type `R` is INFERRED, which is how the
 *   framework types handler context without importing the app's `Db`/`Config`.
 *   May be called once per worker registration, so it must be cheap and
 *   idempotent; the platform memoizes it (see below).
 * - `toBossDb` — adapts the app's database handle to pg-boss's `executeSql`
 *   contract. Its parameter type `TDb` is INFERRED and becomes the `db` every
 *   enqueue takes, so the core needs no ORM: pass `fromDrizzlePostgres` (shipped
 *   as an opt-in leaf module) or write three lines for any other client.
 * - `logger` — the platform never reaches for an app logger.
 *
 * All three type parameters are inferred from the call, so the app never writes
 * an explicit type argument. `const D` preserves the literal registry tuple,
 * which is what keeps `QueuePayloadOf` precise (see the note on
 * `QueueDefinition`).
 */
export function createJobPlatform<const D extends readonly QueueDefinition[], R, TDb>(platform: {
  definitions: D;
  getBoss: () => Promise<PgBoss>;
  getRuntime: () => Promise<R>;
  toBossDb: (db: TDb) => PgBossDb;
  logger: JobLogger;
}) {
  const { definitions, getBoss, getRuntime, logger, toBossDb } = platform;

  /**
   * Resolve the runtime at most once. `register` runs per worker, and a
   * provider that allocated a connection pool per call would quietly open one
   * per worker. Cleared on rejection so a transient failure at boot doesn't
   * poison a later retry — `startJobs` clears its own memo for the same reason.
   */
  let runtimePromise: Promise<R> | undefined;
  function resolveRuntime(): Promise<R> {
    if (!runtimePromise) {
      runtimePromise = getRuntime().catch((err: unknown) => {
        runtimePromise = undefined;
        throw err;
      });
    }
    return runtimePromise;
  }

  type Name = QueueNameOf<D>;
  type Sendable = SendableOf<D>;
  type Payload<Q extends Name> = QueuePayloadOf<D, Q>;

  // Runtime name → schema lookup, built from the definitions. Duplicate names
  // are rejected rather than last-write-wins: the payload TYPE for a repeated
  // name is the union of both schemas, but only one schema would do the
  // validating, so half the payloads would be checked against the wrong shape.
  // The type system can't catch this (a duplicated key just merges), so the
  // registry is verified here, once, at construction.
  const schemaByQueue = new Map<string, QueueDefinition["schema"]>();
  for (const d of definitions) {
    if (schemaByQueue.has(d.name)) {
      throw new JobPlatformError(`Queue "${d.name}" is declared more than once in the registry`);
    }
    schemaByQueue.set(d.name, d.schema);
  }

  /**
   * Look up a queue's payload schema at runtime, typed so `.parse()` returns the
   * queue's payload. Used when validating outgoing (enqueue) and incoming
   * (worker) payloads — both boundaries validate from this one schema.
   *
   * The single cast is unavoidable: a runtime lookup can't be correlated to the
   * compile-time payload type. It is sound because the map is built directly
   * from `definitions`, whose entry for `queue` carries exactly this schema.
   *
   * The miss is still checked. On the inferred path every name is present, but
   * `schemaFor` is exported and a caller whose registry type has widened to
   * `QueueDefinition[]` can reach it with any string. Without the guard that
   * surfaces as `Cannot read properties of undefined (reading 'parse')` from
   * somewhere else entirely.
   */
  function schemaFor<Q extends Name>(queue: Q): z.ZodType<Payload<Q>> {
    const schema = schemaByQueue.get(queue);
    if (!schema) {
      throw new JobPlatformError(`Unknown queue "${queue}"`);
    }
    return schema as z.ZodType<Payload<Q>>;
  }

  /**
   * Core enqueue, parameterized by boss instance for tests.
   * `db` is whatever `toBossDb` accepts — typically a pool handle or a
   * transaction handle. Pass the transaction to make job creation atomic with
   * your domain writes; the queue NOTIFY fires on commit.
   *
   * The payload is validated against the queue's schema before sending —
   * defense in depth: the worker validates again on the way out, both from the
   * one schema.
   */
  async function enqueueWith<Q extends Sendable & Name>(
    boss: PgBoss,
    args: { db: TDb; queue: Q; data: Payload<Q>; options?: JobOptions }
  ): Promise<string | null> {
    const data = schemaFor(args.queue).parse(args.data);
    return boss.send(args.queue, data, {
      ...args.options,
      db: toBossDb(args.db),
    });
  }

  /**
   * The one sanctioned way for application code to create a job.
   * Never call boss.send() directly. Payloads are thin references and must
   * never contain credentials — job rows persist in the database for days.
   */
  async function enqueue<Q extends Sendable & Name>(args: {
    db: TDb;
    queue: Q;
    data: Payload<Q>;
    options?: JobOptions;
  }): Promise<string | null> {
    return enqueueWith(await getBoss(), args);
  }

  /**
   * Cancel jobs on a queue by id (e.g. when their domain record is cancelled).
   * Best-effort: pg-boss updates only cancellable jobs, so already-settled ids
   * are a no-op. Cancelling stops a queued job from starting and prevents a
   * retry of an active one — it does NOT abort a job already running on a
   * worker; interrupt that in-process.
   */
  async function cancelJobs(queue: Name, jobIds: string[]): Promise<void> {
    if (jobIds.length === 0) return;
    const boss = await getBoss();
    await boss.cancel(queue, jobIds).catch((err: unknown) => {
      logger.warn({ err, jobIds, queue }, "job cancel failed (jobs may be settled)");
    });
  }

  /**
   * Define a worker for a queue. The handler receives the app runtime (`R`,
   * inferred from `getRuntime`) plus the validated, typed jobs — so handlers
   * never open a database connection or parse payloads themselves.
   *
   * Each job's payload is parsed through the queue's schema at this boundary and
   * the handler receives the PARSED jobs, so coercions and defaults declared in
   * the schema are already applied when it runs. A payload that fails validation
   * throws, so the job fails → pg-boss retries → dead-letters, like any other
   * handler error; parsing is per batch, so one bad payload fails the whole
   * batch it arrived in. Every job is also logged here with its queue, id, retry
   * count and acting user, so no handler has to remember to trace who a job is
   * for.
   */
  function defineWorker<Q extends Name>(w: {
    queue: Q;
    options: Omit<WorkOptions, "includeMetadata">;
    handler: (ctx: R & { jobs: JobWithMetadata<Payload<Q>>[] }) => Promise<void>;
  }): RegisteredWorker {
    return {
      queue: w.queue,
      register: async (boss) => {
        // Resolved at registration (boot) time, so neither depends on module
        // init order.
        const schema = schemaFor(w.queue);
        const runtime = await resolveRuntime();
        // boss.work uses `const O`, so the literal includeMetadata:true survives
        // inference → JobWithMetadata handler; ReqData infers from the annotated
        // `jobs` param. No explicit type args, no cast.
        return boss.work(
          w.queue,
          { ...w.options, includeMetadata: true },
          async (jobs: JobWithMetadata<Payload<Q>>[]) => {
            // The handler is handed the PARSED jobs, not the raw ones. `data`
            // arrives as jsonb, and the handler's type is the schema's OUTPUT
            // type — so a `z.coerce.date()` field must reach it as a Date and a
            // `.default()` field must be filled in, not left undefined.
            const parsed: JobWithMetadata<Payload<Q>>[] = [];
            for (const job of jobs) {
              const data = schema.parse(job.data);
              // Uniform actor trace for every queue. safeParse (not a cast) so
              // this also works for `global` queues, whose payloads carry no user.
              const actor = $UserScoped.safeParse(data);
              logger.info(
                {
                  jobId: job.id,
                  queue: w.queue,
                  retryCount: job.retryCount,
                  userId: actor.success ? actor.data.userId : undefined,
                },
                "job received"
              );
              parsed.push({ ...job, data });
            }
            await w.handler({ ...runtime, jobs: parsed });
          }
        );
      },
    };
  }

  /**
   * Create missing queues; update options on existing ones (policy/partition are
   * immutable in pg-boss). Note: pg-boss's `update_queue` COALESCEs unspecified
   * options to their current values, so removing an option from a definition
   * here does not reset it to default on an already-created queue — that needs
   * a fresh queue or manual intervention.
   */
  async function ensureQueues(boss: PgBoss): Promise<void> {
    for (const def of definitions) {
      // Widen the `as const` options back to the mutable, all-optional pg-boss
      // shape so we can strip the immutable fields without narrowing errors.
      const options: Omit<NonNullable<Parameters<PgBoss["createQueue"]>[1]>, "name"> = def.options;
      const existing = await boss.getQueue(def.name);
      if (existing) {
        const { policy: _policy, partition: _partition, ...updatable } = options;
        await boss.updateQueue(def.name, updatable);
      } else {
        await boss.createQueue(def.name, options);
        logger.info({ queue: def.name }, "queue created");
      }
    }
  }

  /** Idempotent sync: upsert every declared schedule, unschedule the rest. */
  async function applySchedules(boss: PgBoss, declared: ScheduleDefinition<Name>[]): Promise<void> {
    for (const s of declared) {
      await boss.schedule(s.queue, s.cron, s.data ?? null, s.options ?? {});
    }
    const toRemove = schedulesToRemove(declared, await boss.getSchedules());
    for (const r of toRemove) {
      if (r.key === undefined) {
        await boss.unschedule(r.name);
      } else {
        await boss.unschedule(r.name, r.key);
      }
    }
    // Log only when there's something to report (silent on the common empty
    // case). `applied` is a count — it's every declared schedule on every boot,
    // so the identities aren't news — but list the removed ones: a schedule
    // being turned off is the rare, notable event and you want to see which.
    if (declared.length > 0 || toRemove.length > 0) {
      logger.info({ applied: declared.length, removed: toRemove }, "schedules synced");
    }
  }

  return {
    applySchedules,
    cancelJobs,
    defineWorker,
    enqueue,
    enqueueWith,
    ensureQueues,
    schemaFor,
  };
}
