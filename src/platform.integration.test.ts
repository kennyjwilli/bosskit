import { sql as sqlTag } from "drizzle-orm";
import { type PgBoss, fromDrizzle } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createBoss } from "./boss";
import { createJobPlatform } from "./platform";
import { setupTestDb } from "./test/harness";
import { defineQueues } from "./types";

/**
 * The platform itself, against a synthetic registry — deliberately a synthetic
 * one, so the framework's own tests stay free of any concrete queue. Covers the
 * seam nothing else exercises: register() resolving its providers, then the
 * full round trip enqueue → validate → handler.
 */

const $Payload = z.object({ note: z.string(), userId: z.string() });

const DEFINITIONS = defineQueues([{ name: "probe-queue", schema: $Payload, options: {} }]);

describe("createJobPlatform (integration)", () => {
  let teardown: () => Promise<void>;
  let boss: PgBoss;
  // The enqueue rides this handle, so it must be the same database the boss
  // migrated its schema into.
  let db: Awaited<ReturnType<typeof setupTestDb>>["db"];

  beforeAll(async () => {
    const setup = await setupTestDb({ testFile: import.meta.url });
    teardown = setup.teardown;
    db = setup.db;
    boss = createBoss({ connectionString: setup.url, logger: console, migrate: true });
    await boss.start();
  });
  afterAll(async () => {
    await boss.stop({ graceful: false });
    await teardown();
  });

  it("registers a worker, resolving its providers, and delivers a typed job", async () => {
    let runtimeCalls = 0;
    let seen: { note: string; userId: string; tag: string } | undefined;

    const platform = createJobPlatform({
      definitions: DEFINITIONS,
      getBoss: async () => boss,
      // Counted so the memoization contract is asserted, not assumed.
      getRuntime: async () => {
        runtimeCalls += 1;
        return { tag: "runtime-value" };
      },
      logger: console,
      toBossDb: (handle: typeof db) => fromDrizzle(handle, sqlTag),
    });

    await platform.ensureQueues(boss);

    const worker = platform.defineWorker({
      queue: "probe-queue",
      options: { pollingIntervalSeconds: 1 },
      handler: async ({ jobs, tag }) => {
        const job = jobs[0];
        if (job) seen = { ...job.data, tag };
      },
    });

    // The seam under test: register resolves getBoss/getRuntime itself.
    const workerId = await worker.register(boss);
    expect(workerId).toBeTruthy();
    // Two registrations, one runtime — the memoization a pooled runtime relies on.
    await worker.register(boss);
    expect(runtimeCalls).toBe(1);

    await platform.enqueue({
      data: { note: "hello", userId: "user_probe" },
      db,
      queue: "probe-queue",
    });

    // Poll rather than sleep: the worker fetches on its own interval.
    const deadline = Date.now() + 15_000;
    while (!seen && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }

    // The handler receives the inferred runtime (`tag`) alongside typed jobs.
    expect(seen).toEqual({ note: "hello", tag: "runtime-value", userId: "user_probe" });
  }, 30_000);

  it("rejects an enqueue whose payload does not satisfy the queue schema", async () => {
    const platform = createJobPlatform({
      definitions: DEFINITIONS,
      getBoss: async () => boss,
      getRuntime: async () => ({ tag: "unused" }),
      logger: console,
      toBossDb: (handle: typeof db) => fromDrizzle(handle, sqlTag),
    });

    await expect(
      platform.enqueue({
        // `note` is required by the schema — the outgoing boundary must reject
        // it even though the call site was coerced past the type check.
        data: { note: undefined as unknown as string, userId: "user_probe" },
        db,
        queue: "probe-queue",
      })
    ).rejects.toThrow();
  });
});
