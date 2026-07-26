import type { Db as PgBossDb } from "pg-boss";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { JobPlatformError } from "./errors";
import { createJobPlatform } from "./platform";
import type { QueueDefinition } from "./types";

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
      { name: "dupe", schema: $Payload, options: {} },
      { name: "dupe", schema: $Payload.extend({ extra: z.string() }), options: {} },
    ] as const satisfies readonly QueueDefinition[];

    expect(() => createJobPlatform({ ...PROVIDERS, definitions })).toThrow(JobPlatformError);
    expect(() => createJobPlatform({ ...PROVIDERS, definitions })).toThrow(
      /declared more than once/
    );
  });

  it("accepts a registry whose queue names are unique", () => {
    const definitions = [
      { name: "a", schema: $Payload, options: {} },
      { name: "b", schema: $Payload, options: {} },
    ] as const satisfies readonly QueueDefinition[];

    expect(() => createJobPlatform({ ...PROVIDERS, definitions })).not.toThrow();
  });
});
