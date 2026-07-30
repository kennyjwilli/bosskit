import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { ScheduleOf } from "./schedules";
import { UserScopedSchema, defineQueues } from "./types";
import type { QueueDefinition, QueuePayloadOf, SendableOf } from "./types";

describe("user-scoped queue definitions", () => {
  // Compile-time guarantees. These are type assertions, not runtime checks:
  // each @ts-expect-error FAILS THE BUILD if the line ever starts compiling,
  // which is exactly the regression we want to catch. Written against synthetic
  // definitions, never a real registry, so they pin the constraint itself and
  // keep this package's tests free of any concrete queue.
  it("requires an acting user unless a queue opts out with global", () => {
    // A queue with no `global` flag must carry a user in its payload.
    const userScoped: QueueDefinition = {
      name: "example",
      schema: z.object({ userId: z.string(), thing: z.string() }),
    };
    expect(userScoped.name).toBe("example");

    // @ts-expect-error a default (user-scoped) queue may not omit userId
    const missingUser: QueueDefinition = {
      name: "example",
      schema: z.object({ thing: z.string() }),
    };
    expect(missingUser.name).toBe("example");

    // @ts-expect-error userId must be a string
    const wrongUserType: QueueDefinition = {
      name: "example",
      schema: z.object({ userId: z.number() }),
    };
    expect(wrongUserType.name).toBe("example");

    // The explicit opt-out lets a system queue skip the user entirely.
    // (Named globalQueue, not global — biome forbids shadowing globals.)
    const globalQueue: QueueDefinition = {
      name: "example",
      global: true,
      schema: z.object({ thing: z.string() }),
    };
    expect(globalQueue.name).toBe("example");
  });
});

describe("defineQueues", () => {
  it("preserves literal registry types without `as const satisfies`", () => {
    const $A = UserScopedSchema.extend({ runId: z.string() });
    const $B = UserScopedSchema.extend({ count: z.number() });

    const QUEUES = defineQueues([
      { name: "a-dlq", schema: $A, options: { retryLimit: 2 } },
      { name: "a", schema: $A, options: { deadLetter: "a-dlq" } },
      { name: "b", schema: $B },
    ]);

    // Sendable excludes the dead-letter target.
    const ok: SendableOf<typeof QUEUES> = "a";
    // @ts-expect-error a-dlq is a dead-letter target, not enqueue-able
    const notSendable: SendableOf<typeof QUEUES> = "a-dlq";

    // Payloads stay per-queue precise rather than collapsing to UserScoped.
    const payloadB: QueuePayloadOf<typeof QUEUES, "b"> = { count: 1, userId: "u" };
    // @ts-expect-error runId belongs to queue "a", not queue "b"
    const wrongShape: QueuePayloadOf<typeof QUEUES, "b"> = { count: 1, runId: "r", userId: "u" };

    // The real assertions above are the @ts-expect-error directives: each fails
    // the BUILD if its line ever starts compiling. These runtime checks exist so
    // the bindings are used rather than dead — matching the style already in
    // this file.
    expect(QUEUES).toHaveLength(3);
    expect(ok).toBe("a");
    expect(notSendable).toBe("a-dlq");
    expect(payloadB.count).toBe(1);
    expect(wrongShape.count).toBe(1);
  });

  it("still rejects a payload schema that does not produce a userId", () => {
    // @ts-expect-error schema must satisfy z.ZodType<UserScoped> unless global: true
    const bad = defineQueues([{ name: "x", schema: z.object({ q: z.string() }) }]);
    expect(bad).toHaveLength(1);
  });
});

describe("ScheduleOf", () => {
  const $Alpha = UserScopedSchema.extend({ runId: z.string() });
  const $Beta = UserScopedSchema.extend({ count: z.number() });
  const QUEUES = defineQueues([
    { name: "alpha-dlq", schema: $Alpha },
    { name: "alpha", options: { deadLetter: "alpha-dlq" }, schema: $Alpha },
    { name: "beta", schema: $Beta },
  ]);

  it("binds a schedule's data to its own queue's payload", () => {
    const good: ScheduleOf<typeof QUEUES> = {
      cron: "0 3 * * *",
      data: { runId: "r", userId: "u" },
      queue: "alpha",
    };

    // @ts-expect-error runId belongs to queue "alpha", not queue "beta"
    // biome-ignore format: must stay on one line — TS reports this error on the `data` property, so reflowing it would leave the directive above unused (TS2578) and break the build
    const wrongData: ScheduleOf<typeof QUEUES> = { cron: "0 3 * * *", data: { runId: "r", userId: "u" }, queue: "beta" };

    // @ts-expect-error a dead-letter queue is not a schedule target
    // biome-ignore format: must stay on one line — TS reports this error on the `queue` property, so reflowing it would leave the directive above unused (TS2578) and break the build
    const dlqTarget: ScheduleOf<typeof QUEUES> = { cron: "0 3 * * *", data: { runId: "r", userId: "u" }, queue: "alpha-dlq" };

    // @ts-expect-error data is required — omitting it stores null, which fails the worker's parse
    const noData: ScheduleOf<typeof QUEUES> = { cron: "0 3 * * *", queue: "alpha" };

    // As elsewhere in this file the real assertions are the directives above,
    // which fail the BUILD if any line starts compiling. These keep the
    // bindings used rather than dead.
    expect(good.queue).toBe("alpha");
    expect(wrongData.queue).toBe("beta");
    expect(dlqTarget.queue).toBe("alpha-dlq");
    expect(noData.queue).toBe("alpha");
  });
});
