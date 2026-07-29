import { type JobWithMetadata, PgBoss, type Db as PgBossDb, type Schedule } from "pg-boss";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { JobPlatformError } from "./errors";
import { createJobPlatform } from "./platform";
import { type QueueDefinition, defineQueues } from "./types";

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
function jobRow<T>(data: T): JobWithMetadata<T> {
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
    name: "probe",
    output: {},
    pendingDependencies: 0,
    policy: "standard",
    priority: 0,
    retryBackoff: false,
    retryCount: 0,
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
 */
function capturingBoss(): {
  boss: PgBoss;
  deliver: (jobs: JobWithMetadata<unknown>[]) => Promise<unknown>;
} {
  const boss = new PgBoss("postgresql://user:pass@localhost:5432/unused");
  let captured: ((jobs: JobWithMetadata<unknown>[]) => Promise<unknown>) | undefined;
  vi.spyOn(boss, "work").mockImplementation(async (_name, _options, handler) => {
    captured = handler;
    return "worker-id";
  });
  return {
    boss,
    deliver: (jobs) => {
      if (!captured) throw new Error("register() has not been called yet");
      return captured(jobs);
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
  scheduled: Array<{ cron: string; data: unknown; name: string }>;
  unscheduled: Array<{ key?: string; name: string }>;
} {
  const boss = new PgBoss("postgresql://user:pass@localhost:5432/unused");
  const scheduled: Array<{ cron: string; data: unknown; name: string }> = [];
  const unscheduled: Array<{ key?: string; name: string }> = [];
  vi.spyOn(boss, "schedule").mockImplementation(async (name, cron, data) => {
    scheduled.push({ cron, data, name });
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
  const DEFINITIONS = defineQueues([{ name: "probe", schema: $Coercing }]);

  function platformFor(boss: PgBoss) {
    return createJobPlatform({
      definitions: DEFINITIONS,
      getBoss: async () => boss,
      getRuntime: async () => ({ tag: "runtime" }),
      logger: { error: () => {}, info: () => {}, warn: () => {} },
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
      { cron: "0 3 * * *", data: { olderThanDays: 30, userId: "system" }, name: "sweep" },
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
});
