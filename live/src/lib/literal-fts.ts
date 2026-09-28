export function serializeLiteralFtsQuery(input: string): string {
  return input
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => `"${term.replaceAll('"', '""')}"`)
    .join(" AND ")
}
