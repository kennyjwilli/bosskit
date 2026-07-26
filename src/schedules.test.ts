import { describe, expect, it } from "vitest";
import { type ScheduleDefinition, schedulesToRemove } from "./schedules";

const daily: ScheduleDefinition = { cron: "0 3 * * *", queue: "agent-run" };

describe("schedulesToRemove", () => {
  it("removes nothing when every existing schedule is declared", () => {
    const existing = [{ key: null, name: "agent-run" }];
    expect(schedulesToRemove([daily], existing)).toEqual([]);
  });

  it("ignores key order/representation: '' and null both mean keyless", () => {
    // Real pg-boss rows carry key '' for keyless schedules; a declared keyless
    // schedule must match them so it is not spuriously removed.
    const existing = [{ key: "", name: "agent-run" }];
    expect(schedulesToRemove([daily], existing)).toEqual([]);
  });

  it("removes undeclared schedules, distinguishing keyed from keyless", () => {
    const existing = [
      { key: null, name: "agent-run" }, // declared → kept
      { key: "", name: "agent-run-dlq" }, // undeclared, keyless → { name }
      { key: "eu", name: "agent-run-dlq" }, // undeclared, keyed → { name, key }
    ];
    expect(schedulesToRemove([daily], existing)).toEqual([
      { name: "agent-run-dlq" },
      { key: "eu", name: "agent-run-dlq" },
    ]);
  });

  it("treats same queue with different keys as distinct schedules", () => {
    const us: ScheduleDefinition = {
      cron: "0 6 * * *",
      options: { key: "us" },
      queue: "agent-run-dlq",
    };
    const eu: ScheduleDefinition = {
      cron: "0 18 * * *",
      options: { key: "eu" },
      queue: "agent-run-dlq",
    };
    // 'us' is declared, 'eu' is not → only 'eu' is removed.
    const existing = [
      { key: "us", name: "agent-run-dlq" },
      { key: "eu", name: "agent-run-dlq" },
    ];
    expect(schedulesToRemove([us], existing)).toEqual([{ key: "eu", name: "agent-run-dlq" }]);
    // Both declared → nothing removed.
    expect(schedulesToRemove([us, eu], existing)).toEqual([]);
  });
});
