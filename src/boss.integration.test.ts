import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBoss } from "./boss";
import { setupTestDb } from "./test/harness";

describe("pg-boss lifecycle", () => {
  let teardown: () => Promise<void>;
  let url: string;

  beforeAll(async () => {
    ({ url, teardown } = await setupTestDb({ testFile: import.meta.url }));
  });
  afterAll(async () => {
    await teardown();
  });

  it("installs its schema on start and reports installed", async () => {
    const boss = createBoss({ connectionString: url, logger: console, migrate: true });
    await boss.start();
    try {
      expect(await boss.isInstalled()).toBe(true);
      expect(await boss.schemaVersion()).toBeGreaterThan(0);
    } finally {
      await boss.stop({ graceful: false });
    }
  });

  it("fails fast when migrate is false and the schema is absent", async () => {
    // Fresh databases have no pgboss schema; "external" mode must not create it.
    const { url: url2, teardown: teardown2 } = await setupTestDb({
      testFile: import.meta.url,
    });
    const boss = createBoss({ connectionString: url2, logger: console, migrate: false });
    try {
      await expect(boss.start()).rejects.toThrow();
    } finally {
      await boss.stop({ graceful: false }).catch(() => undefined);
      await teardown2();
    }
  });

  it("runs no cron worker when schedule is off", async () => {
    // pg-boss's scheduler registers itself as a worker on its own queue at
    // start; a send-only process must leave that to the process that owns the
    // schedules. A fresh database shows whether the queue was ever created.
    const { url: url3, teardown: teardown3 } = await setupTestDb({
      testFile: import.meta.url,
    });
    const boss = createBoss({
      connectionString: url3,
      logger: console,
      migrate: true,
      schedule: false,
    });
    await boss.start();
    try {
      expect(await boss.getQueue("__pgboss__send-it")).toBeNull();
    } finally {
      await boss.stop({ graceful: false });
      await teardown3();
    }
  });

  it("reports its application name to postgres", async () => {
    const boss = createBoss({
      application_name: "bosskit-probe",
      connectionString: url,
      logger: console,
      migrate: true,
    });
    await boss.start();
    const client = postgres(url, { max: 1 });
    try {
      const rows = await client<{ application_name: string }[]>`
        SELECT DISTINCT application_name
        FROM pg_stat_activity
        WHERE datname = current_database() AND application_name <> ''
      `;
      expect(rows.map((r) => r.application_name)).toContain("bosskit-probe");
    } finally {
      await client.end();
      await boss.stop({ graceful: false });
    }
  });
});
