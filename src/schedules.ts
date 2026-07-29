import type { QueueDefinition, QueuePayloadOf, SendableOf } from "./types";

/**
 * The loose, registry-agnostic shape of a declared schedule: `data` is
 * optional and `queue` is any string, not narrowed to a registry's names.
 * `schedulesToRemove` (below) consumes this shape so it can diff schedules
 * from any registry — or none — against what pg-boss has stored. `ScheduleOf`
 * is assignable to it. Declaring schedules yourself? Use `ScheduleOf`, which
 * binds `data` to one registry's queue payloads and is what `applySchedules`
 * takes.
 */
export type ScheduleDefinition<Name extends string = string> = {
  /** Queue that receives the scheduled job. */
  queue: Name;
  /** 5-field cron (minute precision) — pg-boss evaluates schedules every ~30s. */
  cron: string;
  /** Plain JSON-serializable data (no Dates/class instances) — it round-trips through jsonb. */
  data?: object;
  options?: {
    /** IANA time zone; pg-boss defaults to UTC. */
    tz?: string;
    /** Unique key when one queue needs multiple schedules. */
    key?: string;
  };
};

/**
 * Identity of an existing schedule row, all `applySchedules` needs to decide
 * which stored schedules are no longer declared. `key` is `string | null` so a
 * real `Schedule[]` from `boss.getSchedules()` (key is `''` when unset) and
 * explicit-null test fixtures both assign here without a cast.
 */
type ExistingScheduleId = { name: string; key: string | null };

/** Stable identity for a schedule: same queue + key = same schedule (empty/null/undefined key all normalize together). */
function idOf(name: string, key: string | null | undefined): string {
  return `${name}::${key ?? ""}`;
}

/**
 * Pure: existing schedules that are no longer declared, so they can be
 * unscheduled. We don't diff cron/data to decide what to *apply* — `boss.schedule`
 * is an idempotent upsert and pg-boss derives fire times from the cron expression
 * (not from `updated_on`), so re-applying an unchanged schedule is a cheap no-op
 * with no effect on timing. Only removals need a diff.
 */
export function schedulesToRemove(
  declared: ScheduleDefinition[],
  existing: ExistingScheduleId[]
): Array<{ name: string; key?: string }> {
  const declaredIds = new Set(declared.map((d) => idOf(d.queue, d.options?.key)));
  return existing
    .filter((e) => !declaredIds.has(idOf(e.name, e.key)))
    .map((e) => (!e.key ? { name: e.name } : { key: e.key, name: e.name }));
}

/**
 * A schedule declaration bound to one registry. Distributing over the sendable
 * queue names is what types `data` per queue: a schedule for queue "a" must
 * carry queue "a"'s payload, so a mismatched or missing payload is a compile
 * error rather than a job that fails every night at 03:00 forever.
 *
 * Dead-letter queues are excluded (`SendableOf`, not `QueueNameOf`) for the
 * same reason `enqueue` excludes them: pg-boss populates a DLQ itself.
 *
 * `data` is Zod's OUTPUT type, so a field with `.default()` must still be
 * supplied here — same as `enqueue`.
 */
export type ScheduleOf<D extends readonly QueueDefinition[]> = {
  [Q in SendableOf<D>]: {
    /** 5-field cron (minute precision) — pg-boss evaluates schedules every ~30s. */
    cron: string;
    /** This queue's payload. Must be JSON-round-trippable; it is stored as jsonb. */
    data: QueuePayloadOf<D, Q>;
    options?: {
      /** Unique key when one queue needs multiple schedules. */
      key?: string;
      /** IANA time zone; pg-boss defaults to UTC. */
      tz?: string;
    };
    /** Queue that receives the scheduled job. */
    queue: Q;
  };
}[SendableOf<D>];
