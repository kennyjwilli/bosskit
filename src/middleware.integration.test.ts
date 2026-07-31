import { sql as sqlTag } from "drizzle-orm";
import { type PgBoss, fromDrizzle } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createBoss } from "./boss";
import { createJobPlatform } from "./platform";
import { setupTestDb } from "./test/harness";
import { type JobMiddleware, defineQueues } from "./types";

/**
 * The claims a stubbed `boss.work` cannot prove.
 *
 * `platform.test.ts` drives middleware through a `vi.spyOn(boss, "work")` stub,
 * so it can only assert the proxy: that bosskit's callback resolves or rejects.
 * Whether pg-boss then marks the job completed or failed is pg-boss's behavior,
 * and it is what the documentation actually promises — "swallowing an error
 * marks the job complete" and "not calling next() completes the job" are
 * warnings about suppressed retries and lost dead-letters. Those need a real
 * database.
 *
 * The same applies to `applySchedules`, which validates a schedule's payload
 * against `JSON.parse(JSON.stringify(data))` on the premise that this is what
 * Postgres stores and a worker later reads. That premise is asserted here
 * rather than assumed.
 *
 * Each scenario gets its own queue: a worker is registered per test, and two
 * workers on one queue would race for the same jobs.
 */

const $Probe = z.object({ note: z.string() });
// z.coerce.date() accepts the string a Date becomes after the jsonb round trip,
// which is exactly why it can distinguish "stored verbatim" from "round-tripped".
const $Dated = z.object({ at: z.coerce.date() });

const DEFINITIONS = defineQueues([
  // retryLimit: 0 so a failed job settles in `failed` rather than parking in
  // `retry` — the tests below distinguish those two states.
  { global: true, name: "swallow-probe", options: { retryLimit: 0 }, schema: $Probe },
  { global: true, name: "rethrow-probe", options: { retryLimit: 0 }, schema: $Probe },
  { global: true, name: "skip-next-probe", options: { retryLimit: 0 }, schema: $Probe },
  { global: true, name: "schedule-probe", schema: $Dated },
]);

describe("middleware and schedules (integration)", () => {
  let teardown: () => Promise<void>;
  let boss: PgBoss;
  let db: Awaited<ReturnType<typeof setupTestDb>>["db"];

  beforeAll(async () => {
    const setup = await setupTestDb({ testFile: import.meta.url });
    teardown = setup.teardown;
    db = setup.db;
    boss = createBoss({ connectionString: setup.url, logger: console, migrate: true });
    await boss.start();
  }, 60_000);

  afterAll(async () => {
    await boss.stop({ graceful: false });
    await teardown();
  });

  function platformWith(
    middleware?: JobMiddleware<
      "swallow-probe" | "rethrow-probe" | "skip-next-probe" | "schedule-probe"
    >
  ) {
    return createJobPlatform({
      definitions: DEFINITIONS,
      getBoss: async () => boss,
      getRuntime: async () => ({}),
      logger: console,
      middleware,
      toBossDb: (handle: typeof db) => fromDrizzle(handle, sqlTag),
    });
  }

  /** Poll until the job leaves the non-terminal states, then report where it landed. */
  async function settledState(queue: string, jobId: string): Promise<string> {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const job = await boss.getJobById(queue, jobId);
      if (job && job.state !== "created" && job.state !== "active" && job.state !== "retry") {
        return job.state;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`job ${jobId} on "${queue}" never reached a terminal state`);
  }

  it("marks the job COMPLETE when middleware swallows a handler error", async () => {
    let handlerRan = false;
    const platform = platformWith(async (_ctx, next) => {
      try {
        await next();
      } catch {
        // Swallowing is the documented foot-gun: pg-boss sees a resolved
        // callback and completes the job, so the retry and the dead-letter hop
        // are both suppressed.
      }
    });
    await platform.ensureQueues(boss);
    await platform
      .defineWorker({
        handler: async () => {
          handlerRan = true;
          throw new Error("handler boom");
        },
        options: { pollingIntervalSeconds: 1 },
        queue: "swallow-probe",
      })
      .register(boss);

    const jobId = await platform.enqueue({ data: { note: "x" }, db, queue: "swallow-probe" });
    expect(jobId).toBeTruthy();

    expect(await settledState("swallow-probe", jobId as string)).toBe("completed");
    expect(handlerRan).toBe(true);
  }, 60_000);

  it("marks the job FAILED when middleware rethrows", async () => {
    // The contrast that makes the test above meaningful: same handler error,
    // same queue options, only the middleware differs.
    const reported: unknown[] = [];
    const platform = platformWith(async (_ctx, next) => {
      try {
        await next();
      } catch (err) {
        // Report-then-rethrow, the pattern the README documents for alerting.
        reported.push(err);
        throw err;
      }
    });
    await platform.ensureQueues(boss);
    await platform
      .defineWorker({
        handler: async () => {
          throw new Error("handler boom");
        },
        options: { pollingIntervalSeconds: 1 },
        queue: "rethrow-probe",
      })
      .register(boss);

    const jobId = await platform.enqueue({ data: { note: "x" }, db, queue: "rethrow-probe" });
    expect(jobId).toBeTruthy();

    expect(await settledState("rethrow-probe", jobId as string)).toBe("failed");
    // The error middleware saw is the handler's, not something pg-boss wrapped.
    expect((reported[0] as Error).message).toBe("handler boom");
  }, 60_000);

  it("marks the job COMPLETE, without running the handler, when middleware skips next()", async () => {
    let handlerRan = false;
    const platform = platformWith(async () => {
      // Never calls next().
    });
    await platform.ensureQueues(boss);
    await platform
      .defineWorker({
        handler: async () => {
          handlerRan = true;
        },
        options: { pollingIntervalSeconds: 1 },
        queue: "skip-next-probe",
      })
      .register(boss);

    const jobId = await platform.enqueue({ data: { note: "x" }, db, queue: "skip-next-probe" });
    expect(jobId).toBeTruthy();

    expect(await settledState("skip-next-probe", jobId as string)).toBe("completed");
    expect(handlerRan).toBe(false);
  }, 60_000);

  it("stores schedule data through jsonb, turning a Date into a string", async () => {
    // The premise `applySchedules` validates on: it checks
    // JSON.parse(JSON.stringify(data)) because that is what Postgres stores and
    // a worker later reads. If Postgres kept the Date intact, validating the
    // round-tripped value would be checking the wrong thing.
    const platform = platformWith();
    await platform.ensureQueues(boss);
    const at = new Date("2026-01-01T00:00:00.000Z");
    await platform.applySchedules(boss, [
      { cron: "0 3 * * *", data: { at }, queue: "schedule-probe" },
    ]);

    const stored = (await boss.getSchedules()).find((s) => s.name === "schedule-probe");
    expect(stored).toBeDefined();
    const storedAt = (stored?.data as { at: unknown }).at;
    // Not a Date: jsonb has no date type, so it comes back as the ISO string.
    expect(typeof storedAt).toBe("string");
    expect(storedAt).toBe("2026-01-01T00:00:00.000Z");
  }, 60_000);
});
