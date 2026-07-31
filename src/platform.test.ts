import {
  type JobWithMetadata,
  PgBoss,
  type Db as PgBossDb,
  type QueueResult,
  type Schedule,
} from "pg-boss";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { JobPlatformError } from "./errors";
import { createJobPlatform } from "./platform";
import {
  type JobLogger,
  type JobMiddleware,
  type QueueDefinition,
  type QueueNameOf,
  defineQueues,
} from "./types";

const $Payload = z.object({ userId: z.string() });

/** The providers are irrelevant to registry validation; these never run. */
const PROVIDERS = {
  getBoss: () => Promise.reject(new Error("unused")),
  getRuntime: () => Promise.reject(new Error("unused")),
  logger: console,
  toBossDb: (): PgBossDb => ({ executeSql: () => Promise.reject(new Error("unused")) }),
};

describe("createJobPlatform registry validation", () => {
  it("rejects a registry that declares the same queue twice", () => {
    // Two entries, same name, DIFFERENT schemas — the case that would otherwise
    // validate half the payloads against the wrong shape. TypeScript can't
    // catch it: the derived payload map just merges the duplicate key.
    const definitions = [
      { name: "dupe", schema: $Payload },
      { name: "dupe", schema: $Payload.extend({ extra: z.string() }) },
    ] as const satisfies readonly QueueDefinition[];

    expect(() => createJobPlatform({ ...PROVIDERS, definitions })).toThrow(JobPlatformError);
    expect(() => createJobPlatform({ ...PROVIDERS, definitions })).toThrow(
      /declared more than once/
    );
  });

  it("accepts a registry whose queue names are unique", () => {
    const definitions = [
      { name: "a", schema: $Payload },
      { name: "b", schema: $Payload },
    ] as const satisfies readonly QueueDefinition[];

    expect(() => createJobPlatform({ ...PROVIDERS, definitions })).not.toThrow();
  });
});

/**
 * A pg-boss job row, with the metadata columns filled in with values a worker
 * never reads. `data` is deliberately typed loosely: the whole point of these
 * tests is what happens between the raw jsonb pg-boss hands over and the parsed
 * payload the handler is promised.
 */
function jobRow<T>(
  data: T,
  overrides: { name?: string; retryCount?: number } = {}
): JobWithMetadata<T> {
  const now = new Date("2026-01-01T00:00:00.000Z");
  return {
    blocked: false,
    blocking: false,
    completedOn: null,
    createdOn: now,
    data,
    deadLetter: "",
    deleteAfterSeconds: 60,
    expireInSeconds: 60,
    heartbeatOn: null,
    heartbeatSeconds: null,
    id: "00000000-0000-0000-0000-000000000001",
    keepUntil: now,
    name: overrides.name ?? "probe",
    output: {},
    pendingDependencies: 0,
    policy: "standard",
    priority: 0,
    retryBackoff: false,
    retryCount: overrides.retryCount ?? 0,
    retryDelay: 0,
    retryLimit: 0,
    signal: AbortSignal.abort(),
    singletonKey: null,
    singletonOn: null,
    sourceCreatedOn: null,
    sourceId: null,
    sourceName: null,
    sourceRetryCount: null,
    startAfter: now,
    startedOn: now,
    state: "active",
  };
}

/**
 * A real `PgBoss` (the constructor connects to nothing) with `work` stubbed, so
 * `register` can be driven end to end and the handler pg-boss would have been
 * given can be invoked directly. Returns a getter rather than the handler
 * because `register` has not run yet when this is called.
 *
 * Keyed by queue name (not a single slot) so one boss can back several
 * concurrently-registered workers — the shape a platform-level middleware test
 * needs to prove it wraps every worker, not just the one registered first.
 * `deliver`'s `queue` argument is optional: with exactly one worker registered
 * there is only one handler to pick, so existing single-worker call sites are
 * unaffected.
 */
function capturingBoss(): {
  boss: PgBoss;
  deliver: (jobs: JobWithMetadata<unknown>[], queue?: string) => Promise<unknown>;
} {
  const boss = new PgBoss("postgresql://user:pass@localhost:5432/unused");
  const captured = new Map<string, (jobs: JobWithMetadata<unknown>[]) => Promise<unknown>>();
  vi.spyOn(boss, "work").mockImplementation(async (name, _options, handler) => {
    captured.set(name, handler);
    return "worker-id";
  });
  return {
    boss,
    deliver: (jobs, queue) => {
      const name = queue ?? (captured.size === 1 ? [...captured.keys()][0] : undefined);
      if (name === undefined) {
        throw new Error(
          captured.size === 0
            ? "register() has not been called yet"
            : "deliver() needs an explicit queue when more than one worker is registered"
        );
      }
      const handler = captured.get(name);
      if (!handler) throw new Error(`register() has not been called yet for queue "${name}"`);
      return handler(jobs);
    },
  };
}

/**
 * A real `PgBoss` (the constructor connects to nothing) with the three
 * scheduling calls stubbed, so `applySchedules` can be driven end to end and
 * what it *would* have sent to pg-boss can be asserted.
 */
function schedulingBoss(existing: Schedule[] = []): {
  boss: PgBoss;
  scheduled: Array<{ cron: string; data: unknown; name: string; options: unknown }>;
  unscheduled: Array<{ key?: string; name: string }>;
} {
  const boss = new PgBoss("postgresql://user:pass@localhost:5432/unused");
  const scheduled: Array<{ cron: string; data: unknown; name: string; options: unknown }> = [];
  const unscheduled: Array<{ key?: string; name: string }> = [];
  vi.spyOn(boss, "schedule").mockImplementation(async (name, cron, data, options) => {
    scheduled.push({ cron, data, name, options });
  });
  vi.spyOn(boss, "getSchedules").mockResolvedValue(existing);
  vi.spyOn(boss, "unschedule").mockImplementation(async (name, key) => {
    unscheduled.push(key === undefined ? { name } : { key, name });
  });
  return { boss, scheduled, unscheduled };
}

describe("defineWorker payload parsing", () => {
  // The queue's schema coerces and defaults, so the raw jsonb a job carries and
  // the payload the handler is typed to receive are genuinely different values.
  const $Coercing = z.object({
    at: z.coerce.date(),
    tier: z.string().default("free"),
    userId: z.string(),
  });
  // A schema with no `userId` at all — only a `global: true` queue may carry
  // one, and it's what lets the logging tests below exercise the
  // `actor.success ? … : undefined` fallback for a job with no acting user.
  const $Global = z.object({ note: z.string().optional() });
  const DEFINITIONS = defineQueues([
    { name: "probe", schema: $Coercing },
    { global: true, name: "global-probe", schema: $Global },
  ]);

  function platformFor(boss: PgBoss, logger?: JobLogger) {
    return createJobPlatform({
      definitions: DEFINITIONS,
      getBoss: async () => boss,
      getRuntime: async () => ({ tag: "runtime" }),
      logger: logger ?? { error: () => {}, info: () => {}, warn: () => {} },
      toBossDb: (): PgBossDb => ({ executeSql: () => Promise.reject(new Error("unused")) }),
    });
  }

  it("hands the handler payloads parsed through the queue schema, not raw jsonb", async () => {
    const { boss, deliver } = capturingBoss();
    const seen: Array<{ at: unknown; tier: string; userId: string }> = [];

    const worker = platformFor(boss).defineWorker({
      queue: "probe",
      handler: async ({ jobs }) => {
        for (const job of jobs) seen.push(job.data);
      },
    });
    await worker.register(boss);

    // Exactly what pg-boss reads back out of jsonb: a date as a string, and the
    // defaulted field simply absent.
    await deliver([jobRow({ at: "2026-07-26T12:00:00.000Z", userId: "user_1" })]);

    expect(seen).toHaveLength(1);
    const payload = seen[0];
    expect(payload?.at).toBeInstanceOf(Date);
    expect(payload?.at).toEqual(new Date("2026-07-26T12:00:00.000Z"));
    expect(payload?.tier).toBe("free");
    expect(payload?.userId).toBe("user_1");
  });

  it("leaves the rest of the job metadata untouched", async () => {
    const { boss, deliver } = capturingBoss();
    let seenId: string | undefined;

    const worker = platformFor(boss).defineWorker({
      queue: "probe",
      handler: async ({ jobs }) => {
        seenId = jobs[0]?.id;
      },
    });
    await worker.register(boss);
    await deliver([jobRow({ at: "2026-07-26T12:00:00.000Z", userId: "user_1" })]);

    expect(seenId).toBe("00000000-0000-0000-0000-000000000001");
  });

  it("throws (failing the job) when a payload does not satisfy the schema", async () => {
    const { boss, deliver } = capturingBoss();
    let handlerRan = false;

    const worker = platformFor(boss).defineWorker({
      queue: "probe",
      handler: async () => {
        handlerRan = true;
      },
    });
    await worker.register(boss);

    // Validation is per BATCH: the valid job in this batch is not delivered
    // either, because the whole batch throws.
    await expect(
      deliver([
        jobRow({ at: "2026-07-26T12:00:00.000Z", userId: "user_1" }),
        jobRow({ at: "not-a-date-at-all", userId: 42 }),
      ])
    ).rejects.toThrow();
    expect(handlerRan).toBe(false);
  });

  // Moved from `describe("platform middleware")`: this exercises
  // `parseJobBatch`'s logging, not middleware, and belongs with the rest of
  // the parsing tests. `jobRow`'s `name`/`retryCount` overrides deliberately
  // differ from the asserted `queue` and the real `retryCount`'s zero value,
  // so a logger reading `job.name` instead of `queue`, or hardcoding
  // `retryCount`, cannot pass by fixture accident.
  it("logs jobId, queue, retryCount, and userId under a 'job received' message", async () => {
    const { boss, deliver } = capturingBoss();
    const logged: Array<{ msg: string; obj: Record<string, unknown> }> = [];

    const worker = platformFor(boss, {
      error: () => {},
      info: (obj, msg) => {
        logged.push({ msg, obj });
      },
      warn: () => {},
    }).defineWorker({
      queue: "probe",
      handler: async () => {},
    });
    await worker.register(boss);

    await deliver([
      jobRow(
        { at: "2026-07-26T12:00:00.000Z", userId: "user_1" },
        { name: "not-probe", retryCount: 3 }
      ),
    ]);

    expect(logged).toContainEqual({
      msg: "job received",
      obj: {
        jobId: "00000000-0000-0000-0000-000000000001",
        queue: "probe",
        retryCount: 3,
        userId: "user_1",
      },
    });
  });

  it("logs userId as undefined for a global queue payload with no acting user", async () => {
    const { boss, deliver } = capturingBoss();
    const logged: Array<{ msg: string; obj: Record<string, unknown> }> = [];

    const worker = platformFor(boss, {
      error: () => {},
      info: (obj, msg) => {
        logged.push({ msg, obj });
      },
      warn: () => {},
    }).defineWorker({
      queue: "global-probe",
      handler: async () => {},
    });
    await worker.register(boss);

    await deliver([jobRow({ note: "system sweep" })]);

    expect(logged).toContainEqual({
      msg: "job received",
      obj: {
        jobId: "00000000-0000-0000-0000-000000000001",
        queue: "global-probe",
        retryCount: 0,
        userId: undefined,
      },
    });
  });
});

describe("schemaFor", () => {
  it("throws JobPlatformError for a queue that is not in the registry", () => {
    // A registry whose type has widened to `QueueDefinition[]` — the spelling
    // that makes every derived name type collapse to `string`, so an unknown
    // queue name reaches `schemaFor` without a compile error.
    const definitions: QueueDefinition[] = [{ name: "known", schema: $Payload }];
    const platform = createJobPlatform({ ...PROVIDERS, definitions });

    expect(() => platform.schemaFor("missing")).toThrow(JobPlatformError);
    expect(() => platform.schemaFor("missing")).toThrow(/Unknown queue "missing"/);
    expect(() => platform.schemaFor("known")).not.toThrow();
  });
});

describe("applySchedules payload validation", () => {
  const $Sweep = z.object({ olderThanDays: z.number(), userId: z.string() });
  // A field that is valid in memory but NOT valid after a jsonb round trip:
  // a Date goes in, an ISO string comes back, and z.date() rejects the string.
  const $Dated = z.object({ at: z.date(), userId: z.string() });
  // A schema whose parse output is a Date built FROM the round-tripped string —
  // structurally equal to the declared value but not the same object. Only
  // this kind of schema can tell "sent as declared" apart from "sent as
  // parsed": `$Sweep` has no coercion, so the two are indistinguishable there.
  const $Coerce = z.object({ at: z.coerce.date(), userId: z.string() });
  const DEFINITIONS = defineQueues([
    { name: "sweep", schema: $Sweep },
    { name: "dated", schema: $Dated },
    { name: "coerce", schema: $Coerce },
  ]);

  function platformFor(boss: PgBoss) {
    return createJobPlatform({
      definitions: DEFINITIONS,
      getBoss: async () => boss,
      getRuntime: async () => ({}),
      logger: { error: () => {}, info: () => {}, warn: () => {} },
      toBossDb: (): PgBossDb => ({ executeSql: () => Promise.reject(new Error("unused")) }),
    });
  }

  it("applies a valid schedule, passing data through verbatim", async () => {
    const { boss, scheduled } = schedulingBoss();
    await platformFor(boss).applySchedules(boss, [
      { cron: "0 3 * * *", data: { olderThanDays: 30, userId: "system" }, queue: "sweep" },
    ]);

    expect(scheduled).toEqual([
      {
        cron: "0 3 * * *",
        data: { olderThanDays: 30, userId: "system" },
        name: "sweep",
        options: {},
      },
    ]);
  });

  it("passes options through to boss.schedule verbatim", async () => {
    const { boss, scheduled } = schedulingBoss();
    await platformFor(boss).applySchedules(boss, [
      {
        cron: "0 3 * * *",
        data: { olderThanDays: 30, userId: "system" },
        options: { tz: "UTC" },
        queue: "sweep",
      },
    ]);

    expect(scheduled).toEqual([
      {
        cron: "0 3 * * *",
        data: { olderThanDays: 30, userId: "system" },
        name: "sweep",
        options: { tz: "UTC" },
      },
    ]);
  });

  it("sends data as declared, not the parse output", async () => {
    const { boss, scheduled } = schedulingBoss();
    const at = new Date("2026-01-01T00:00:00.000Z");
    await platformFor(boss).applySchedules(boss, [
      { cron: "0 3 * * *", data: { at, userId: "system" }, queue: "coerce" },
    ]);

    // Identity, not structure: the parse output would be an equal-but-distinct
    // Date built from the round-tripped ISO string.
    expect((scheduled[0]?.data as { at: unknown }).at).toBe(at);
  });

  it("rejects a payload that does not satisfy the queue schema, naming the queue", async () => {
    const { boss } = schedulingBoss();
    const platform = platformFor(boss);
    // Coerced past the compile-time check to reach the runtime guard.
    const bad = [
      { cron: "0 3 * * *", data: { olderThanDays: "thirty", userId: "system" }, queue: "sweep" },
    ] as unknown as Parameters<typeof platform.applySchedules>[1];

    await expect(platform.applySchedules(boss, bad)).rejects.toThrow(JobPlatformError);
    await expect(platform.applySchedules(boss, bad)).rejects.toThrow(/queue "sweep"/);
  });

  it("includes the key in the error label for a keyed schedule with an invalid payload", async () => {
    const { boss } = schedulingBoss();
    const platform = platformFor(boss);
    // Coerced past the compile-time check to reach the runtime guard, matching
    // the precedent above — this time with a `key` so the `(key "…")` suffix
    // in the error label has something to assert against.
    const bad = [
      {
        cron: "0 3 * * *",
        data: { olderThanDays: "thirty", userId: "system" },
        options: { key: "eu" },
        queue: "sweep",
      },
    ] as unknown as Parameters<typeof platform.applySchedules>[1];

    await expect(platform.applySchedules(boss, bad)).rejects.toThrow(/queue "sweep" \(key "eu"\)/);
  });

  it("rejects a payload that is valid in memory but invalid after the jsonb round trip", async () => {
    const { boss, scheduled } = schedulingBoss();
    const platform = platformFor(boss);

    // `at` typechecks and would pass a naive safeParse of the in-memory value.
    // It is only invalid once jsonb has turned the Date into a string — which
    // is exactly what the worker will parse at fire time.
    await expect(
      platform.applySchedules(boss, [
        {
          cron: "0 4 * * *",
          data: { at: new Date("2026-01-01T00:00:00.000Z"), userId: "system" },
          queue: "dated",
        },
      ])
    ).rejects.toThrow(JobPlatformError);
    expect(scheduled).toEqual([]);
  });

  it("rejects a payload that is not JSON-serializable, naming the queue", async () => {
    const { boss, scheduled } = schedulingBoss();
    const platform = platformFor(boss);
    // A circular reference makes JSON.stringify throw before safeParse ever
    // runs. Coerced past the compile-time check to reach the runtime guard,
    // matching the precedent above.
    const circular: Record<string, unknown> = { olderThanDays: 30, userId: "system" };
    circular.self = circular;
    const bad = [{ cron: "0 3 * * *", data: circular, queue: "sweep" }] as unknown as Parameters<
      typeof platform.applySchedules
    >[1];

    await expect(platform.applySchedules(boss, bad)).rejects.toThrow(JobPlatformError);
    await expect(platform.applySchedules(boss, bad)).rejects.toThrow(/queue "sweep"/);
    expect(scheduled).toEqual([]);
  });

  it("validates every schedule before applying any", async () => {
    const { boss, scheduled, unscheduled } = schedulingBoss();
    const platform = platformFor(boss);
    const mixed = [
      { cron: "0 3 * * *", data: { olderThanDays: 30, userId: "system" }, queue: "sweep" },
      { cron: "0 5 * * *", data: { olderThanDays: "nope", userId: "system" }, queue: "sweep" },
    ] as unknown as Parameters<typeof platform.applySchedules>[1];

    await expect(platform.applySchedules(boss, mixed)).rejects.toThrow(JobPlatformError);
    // The valid first entry must NOT have been applied, and nothing pruned.
    expect(scheduled).toEqual([]);
    expect(unscheduled).toEqual([]);
  });

  it("still prunes schedules that are no longer declared", async () => {
    const { boss, unscheduled } = schedulingBoss([
      { cron: "0 3 * * *", key: "", name: "sweep", timezone: "UTC" },
      { cron: "0 9 * * *", key: "eu", name: "sweep", timezone: "UTC" },
    ]);
    await platformFor(boss).applySchedules(boss, [
      { cron: "0 3 * * *", data: { olderThanDays: 30, userId: "system" }, queue: "sweep" },
    ]);

    expect(unscheduled).toEqual([{ key: "eu", name: "sweep" }]);
  });

  it("unschedules by name alone when the stale schedule has no key", async () => {
    const { boss, unscheduled } = schedulingBoss([
      { cron: "0 3 * * *", key: "", name: "stale", timezone: "UTC" },
    ]);
    await platformFor(boss).applySchedules(boss, []);

    expect(unscheduled).toEqual([{ name: "stale" }]);
  });
});

describe("platform middleware", () => {
  const $Coercing = z.object({ at: z.coerce.date(), userId: z.string() });
  // Two queues, not one: a middleware wired up on only the first worker
  // registered is indistinguishable from a platform-wide hook as long as
  // there's only one worker to check. The second queue is what forces that
  // distinction.
  const DEFINITIONS = defineQueues([
    { name: "probe", schema: $Coercing },
    { name: "probe-two", schema: $Coercing },
  ]);

  function platformFor(boss: PgBoss, middleware?: JobMiddleware<QueueNameOf<typeof DEFINITIONS>>) {
    return createJobPlatform({
      definitions: DEFINITIONS,
      getBoss: async () => boss,
      getRuntime: async () => ({ tag: "runtime" }),
      logger: { error: () => {}, info: () => {}, warn: () => {} },
      middleware,
      toBossDb: (): PgBossDb => ({ executeSql: () => Promise.reject(new Error("unused")) }),
    });
  }

  const validJob = () => jobRow({ at: "2026-07-26T12:00:00.000Z", userId: "user_1" });

  it("wraps every handler run, so a cross-cutting concern cannot be forgotten", async () => {
    const { boss, deliver } = capturingBoss();
    const events: string[] = [];
    const platform = platformFor(boss, async (ctx, next) => {
      events.push(`before:${ctx.queue}:${ctx.jobs.length}`);
      await next();
      events.push(`after:${ctx.queue}`);
    });
    const workerOne = platform.defineWorker({
      queue: "probe",
      handler: async () => {
        events.push("handler:probe");
      },
    });
    const workerTwo = platform.defineWorker({
      queue: "probe-two",
      handler: async () => {
        events.push("handler:probe-two");
      },
    });
    await workerOne.register(boss);
    await workerTwo.register(boss);

    await deliver([validJob()], "probe");
    await deliver([validJob()], "probe-two");

    // Registered on ONE platform, delivered to each — a middleware wired to
    // only the first-registered worker leaves the second queue's events out
    // entirely.
    expect(events).toEqual([
      "before:probe:1",
      "handler:probe",
      "after:probe",
      "before:probe-two:1",
      "handler:probe-two",
      "after:probe-two",
    ]);
  });

  it("runs middleware exactly once per BATCH, not once per job", async () => {
    const { boss, deliver } = capturingBoss();
    let callCount = 0;
    let jobsSeen: number | undefined;
    const worker = platformFor(boss, async (ctx, next) => {
      callCount += 1;
      jobsSeen = ctx.jobs.length;
      await next();
    }).defineWorker({
      queue: "probe",
      handler: async () => {},
    });
    await worker.register(boss);

    // A batch of 3, not 1: at the default batchSize of 1 per-batch and
    // per-job dispatch are indistinguishable, so this is the only way to
    // prove middleware wraps the whole batch rather than each job in it.
    await deliver([validJob(), validJob(), validJob()]);

    expect(callCount).toBe(1);
    expect(jobsSeen).toBe(3);
  });

  it("discards whatever middleware resolves to, so it cannot leak into pg-boss job output", async () => {
    const { boss, deliver } = capturingBoss();
    const worker = platformFor(boss, async (_ctx, next) => {
      await next();
      // Coerced past `Promise<void>` on purpose: this is the only way to
      // prove at runtime that the platform discards a middleware return
      // value, rather than relying on the type system to forbid it.
      return "leaked-value" as unknown as undefined;
    }).defineWorker({
      queue: "probe",
      handler: async () => {},
    });
    await worker.register(boss);

    await expect(deliver([validJob()])).resolves.toBeUndefined();
  });

  it("skips the handler when middleware does not call next", async () => {
    const { boss, deliver } = capturingBoss();
    let handlerRan = false;
    const worker = platformFor(boss, async () => {}).defineWorker({
      queue: "probe",
      handler: async () => {
        handlerRan = true;
      },
    });
    await worker.register(boss);
    await deliver([validJob()]);

    expect(handlerRan).toBe(false);
  });

  it("receives RAW pre-validation jobs, not the parsed payloads the handler gets", async () => {
    const { boss, deliver } = capturingBoss();
    let middlewareSaw: unknown;
    let handlerSaw: unknown;
    const worker = platformFor(boss, async (ctx, next) => {
      middlewareSaw = (ctx.jobs[0]?.data as { at: unknown }).at;
      await next();
    }).defineWorker({
      queue: "probe",
      handler: async ({ jobs }) => {
        handlerSaw = jobs[0]?.data.at;
      },
    });
    await worker.register(boss);
    await deliver([validJob()]);

    // Middleware runs before the parse loop, so it sees the raw jsonb string.
    expect(middlewareSaw).toBe("2026-07-26T12:00:00.000Z");
    expect(handlerSaw).toBeInstanceOf(Date);
  });

  it("surfaces a payload validation failure through next, and swallowing it completes the batch", async () => {
    const { boss, deliver } = capturingBoss();
    let caught: unknown;
    const worker = platformFor(boss, async (_ctx, next) => {
      try {
        await next();
      } catch (err) {
        caught = err;
      }
    }).defineWorker({ queue: "probe", handler: async () => {} });
    await worker.register(boss);

    // `at` cannot coerce and `userId` is the wrong type, so the parse throws
    // inside next(). Middleware swallows it, so the batch RESOLVES — which is
    // exactly why swallowing marks a job complete and suppresses the retry.
    // The callback resolves to void (middleware swallowed the error and
    // returned nothing), not undefined-as-a-rejection — `.resolves` itself is
    // the load-bearing check: it fails if the promise rejects instead.
    await expect(
      deliver([jobRow({ at: "not-a-date-at-all", userId: 42 })])
    ).resolves.toBeUndefined();
    expect(caught).toBeInstanceOf(z.ZodError);
  });

  it("fails the batch when middleware rethrows", async () => {
    const { boss, deliver } = capturingBoss();
    let reported: unknown;
    const worker = platformFor(boss, async (_ctx, next) => {
      try {
        await next();
      } catch (err) {
        reported = err; // e.g. span.recordException(err)
        throw err; // the documented pattern
      }
    }).defineWorker({ queue: "probe", handler: async () => {} });
    await worker.register(boss);

    await expect(deliver([jobRow({ at: "not-a-date", userId: 42 })])).rejects.toThrow();
    expect(reported).toBeInstanceOf(z.ZodError);
  });

  it("fails the batch when middleware throws before calling next", async () => {
    const { boss, deliver } = capturingBoss();
    let handlerRan = false;
    const worker = platformFor(boss, async () => {
      throw new Error("mw boom");
    }).defineWorker({
      queue: "probe",
      handler: async () => {
        handlerRan = true;
      },
    });
    await worker.register(boss);

    await expect(deliver([validJob()])).rejects.toThrow("mw boom");
    expect(handlerRan).toBe(false);
  });

  it("fails the batch when the handler rejects, propagating through next()", async () => {
    const { boss, deliver } = capturingBoss();
    const worker = platformFor(boss, async (_ctx, next) => {
      await next(); // no try/catch: a handler rejection should reach pg-boss untouched
    }).defineWorker({
      queue: "probe",
      handler: async () => {
        throw new Error("handler boom");
      },
    });
    await worker.register(boss);

    await expect(deliver([validJob()])).rejects.toThrow("handler boom");
  });

  it("leaves behavior unchanged when no middleware is configured", async () => {
    const { boss, deliver } = capturingBoss();
    let handlerSaw: unknown;
    const worker = platformFor(boss).defineWorker({
      queue: "probe",
      handler: async ({ jobs }) => {
        handlerSaw = jobs[0]?.data.at;
      },
    });
    await worker.register(boss);
    await deliver([validJob()]);

    expect(handlerSaw).toBeInstanceOf(Date);
  });
});

/**
 * An existing queue as `boss.getQueue` reports it. `ensureQueues` only reads
 * truthiness, but `QueueResult` carries statistics columns, so they are filled
 * in with values nothing under test reads.
 */
function queueResult(name: string): QueueResult {
  const now = new Date("2026-01-01T00:00:00.000Z");
  return {
    activeCount: 0,
    createdOn: now,
    deferredCount: 0,
    failedCount: 0,
    name,
    queuedCount: 0,
    readyCount: 0,
    singletonsActive: null,
    table: name,
    totalCount: 0,
    updatedOn: now,
  };
}

describe("ensureQueues", () => {
  const SILENT: JobLogger = { error: () => {}, info: () => {}, warn: () => {} };

  /**
   * A real `PgBoss` (the constructor connects to nothing) with the three queue
   * calls stubbed. `existing` names the queues pg-boss already has, which is
   * what selects the create branch over the update branch — and therefore what
   * separates a first boot from every boot after it.
   */
  function queueBoss(existing: string[]): {
    boss: PgBoss;
    created: string[];
    updated: Array<{ name: string; options: object }>;
  } {
    const boss = new PgBoss("postgresql://user:pass@localhost:5432/unused");
    const created: string[] = [];
    const updated: Array<{ name: string; options: object }> = [];
    vi.spyOn(boss, "getQueue").mockImplementation(async (name) =>
      existing.includes(name) ? queueResult(name) : null
    );
    vi.spyOn(boss, "createQueue").mockImplementation(async (name) => {
      created.push(name);
    });
    vi.spyOn(boss, "updateQueue").mockImplementation(async (name, options) => {
      updated.push({ name, options: options ?? {} });
    });
    return { boss, created, updated };
  }

  function platformFor(
    boss: PgBoss,
    definitions: Parameters<typeof createJobPlatform>[0]["definitions"]
  ) {
    return createJobPlatform({
      definitions,
      getBoss: async () => boss,
      getRuntime: async () => ({}),
      logger: SILENT,
      toBossDb: (): PgBossDb => ({ executeSql: () => Promise.reject(new Error("unused")) }),
    });
  }

  it("skips updateQueue for an existing queue with nothing to update", async () => {
    // pg-boss throws `AssertionError: no properties found to update` on an empty
    // update. This is the DOCUMENTED happy path — the README says to omit
    // `options` for a queue with nothing to configure — and it only bites on the
    // SECOND boot, once the queue exists and this takes the update branch.
    const { boss, created, updated } = queueBoss(["plain"]);
    const platform = platformFor(
      boss,
      defineQueues([{ global: true, name: "plain", schema: z.object({}) }])
    );

    await expect(platform.ensureQueues(boss)).resolves.toBeUndefined();
    expect(updated).toEqual([]);
    expect(created).toEqual([]);
  });

  it("skips updateQueue when a queue declares only immutable options", async () => {
    // policy and partition are immutable in pg-boss and stripped before the
    // update, so a queue configured with nothing else also ends up empty.
    const { boss, updated } = queueBoss(["only-policy"]);
    const platform = platformFor(
      boss,
      defineQueues([
        {
          global: true,
          name: "only-policy",
          options: { policy: "singleton" },
          schema: z.object({}),
        },
      ])
    );

    await expect(platform.ensureQueues(boss)).resolves.toBeUndefined();
    expect(updated).toEqual([]);
  });

  it("still updates an existing queue that has something to update", async () => {
    // The guard above must not turn into "never update".
    const { boss, updated } = queueBoss(["retrying"]);
    const platform = platformFor(
      boss,
      defineQueues([
        { global: true, name: "retrying", options: { retryLimit: 3 }, schema: z.object({}) },
      ])
    );

    await platform.ensureQueues(boss);
    expect(updated).toEqual([{ name: "retrying", options: { retryLimit: 3 } }]);
  });

  it("creates a queue that does not exist yet", async () => {
    const { boss, created, updated } = queueBoss([]);
    const platform = platformFor(
      boss,
      defineQueues([{ global: true, name: "plain", schema: z.object({}) }])
    );

    await platform.ensureQueues(boss);
    expect(created).toEqual(["plain"]);
    expect(updated).toEqual([]);
  });
});
