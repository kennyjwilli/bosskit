/**
 * Schedule declarations are generic over a registry's queue names, so a typo in
 * a schedule target is a compile error. The sync itself lives on the platform
 * (`applySchedules`) — it needs the registry's name type; this module holds the
 * declaration shape and the pure diff.
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
