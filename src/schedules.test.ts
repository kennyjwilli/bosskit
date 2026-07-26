import { describe, expect, it } from "vitest";
import { type ScheduleDefinition, schedulesToRemove } from "./schedules";

const daily: ScheduleDefinition = { cron: "0 3 * * *", queue: "report-export" };

describe("schedulesToRemove", () => {
  it("removes nothing when every existing schedule is declared", () => {
    const existing = [{ key: null, name: "report-export" }];
    expect(schedulesToRemove([daily], existing)).toEqual([]);
  });

  it("ignores key order/representation: '' and null both mean keyless", () => {
    // Real pg-boss rows carry key '' for keyless schedules; a declared keyless
    // schedule must match them so it is not spuriously removed.
    const existing = [{ key: "", name: "report-export" }];
    expect(schedulesToRemove([daily], existing)).toEqual([]);
  });

  it("removes undeclared schedules, distinguishing keyed from keyless", () => {
    const existing = [
      { key: null, name: "report-export" }, // declared → kept
      { key: "", name: "report-export-dlq" }, // undeclared, keyless → { name }
      { key: "eu", name: "report-export-dlq" }, // undeclared, keyed → { name, key }
    ];
    expect(schedulesToRemove([daily], existing)).toEqual([
      { name: "report-export-dlq" },
      { key: "eu", name: "report-export-dlq" },
    ]);
  });

  it("treats same queue with different keys as distinct schedules", () => {
    const us: ScheduleDefinition = {
      cron: "0 6 * * *",
      options: { key: "us" },
      queue: "report-export-dlq",
    };
    const eu: ScheduleDefinition = {
      cron: "0 18 * * *",
      options: { key: "eu" },
      queue: "report-export-dlq",
    };
    // 'us' is declared, 'eu' is not → only 'eu' is removed.
    const existing = [
      { key: "us", name: "report-export-dlq" },
      { key: "eu", name: "report-export-dlq" },
    ];
    expect(schedulesToRemove([us], existing)).toEqual([{ key: "eu", name: "report-export-dlq" }]);
    // Both declared → nothing removed.
    expect(schedulesToRemove([us, eu], existing)).toEqual([]);
  });
});
