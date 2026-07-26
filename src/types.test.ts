import { describe, expect, it } from "vitest";
import { z } from "zod";
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
