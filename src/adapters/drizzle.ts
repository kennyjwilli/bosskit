import type { DrizzleSqlTagLike, Db as PgBossDb } from "pg-boss";

/**
 * Ships as the `bosskit/drizzle` entry point so the core stays ORM-free. Using
 * a different client means writing your own small adapter instead of importing
 * this one.
 *
 * Both the handle and the `sql` tag are typed structurally — pg-boss ships
 * `DrizzleSqlTagLike` for exactly this reason — so even this module has no
 * drizzle import, and `src/lib/jobs/` depends on no ORM at all.
 */

/** What this adapter needs of a drizzle handle: run one SQL statement. A pool
 * handle and a transaction handle both satisfy it, which is what lets an
 * enqueue ride the caller's transaction. Deliberately not pg-boss's
 * `DrizzleTransactionLike`, which describes node-postgres's `{ rows }` return —
 * the bare postgres-js row array is the whole reason this adapter exists. */
type DrizzleExecutor = {
  execute(query: unknown): Promise<Iterable<unknown>>;
};

/**
 * Parse `$N` placeholders into literal segments + values in textual order.
 * Re-implemented (not imported) because pg-boss's identical helper is an
 * unexported internal (dist/adapters/placeholders.js). Covered by its own unit test.
 * Handles repeated indexes ($2 twice) by duplicating the value at each occurrence.
 */
export function parsePlaceholders(
  text: string,
  values: unknown[]
): { parts: string[]; reordered: unknown[] } {
  const parts: string[] = [];
  const reordered: unknown[] = [];
  const re = /\$(\d+)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null = re.exec(text);
  while (match !== null) {
    parts.push(text.slice(lastIndex, match.index));
    reordered.push(values[Number(match[1]) - 1]);
    lastIndex = re.lastIndex;
    match = re.exec(text);
  }
  parts.push(text.slice(lastIndex));
  return { parts, reordered };
}

/**
 * Wrap a drizzle postgres-js db/transaction as a pg-boss Db. Unlike pg-boss's
 * built-in `fromDrizzle`, this unwraps postgres-js's bare row-array result
 * correctly — `fromDrizzle` assumes node-postgres `{ rows }` and crashes on the
 * postgres-js `RowList` (a plain array), reading `.rows` off each row → undefined.
 * Pass a transaction handle to make enqueue atomic with your domain writes.
 */
export function fromDrizzlePostgres(db: DrizzleExecutor, sql: DrizzleSqlTagLike): PgBossDb {
  return {
    async executeSql(text, values) {
      const { parts, reordered } = parsePlaceholders(text, values ?? []);
      const strings = Object.assign([...parts], { raw: [...parts] });
      // Bind each value through sql.param so drizzle emits exactly one placeholder
      // per value; a bare array would otherwise be expanded into a parameter list.
      const params = reordered.map((v) => sql.param(v));
      // postgres-js's RowList is statically `TRow[] & Iterable<...>`, so the awaited
      // result is already an array — Array.from copies it into a fresh unknown[].
      const result = await db.execute(sql(strings, ...params));
      return { rows: Array.from(result) };
    },
  };
}
