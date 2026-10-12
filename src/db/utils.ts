import { sql } from "drizzle-orm";

export function chunkArray<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

export function sqlValueList(values: readonly (string | number)[]) {
  return sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  );
}
