/** Inspect only the identifier grammar used by package-owned migrations. */
export function migrationColumnTarget(sql: string): { table: string; column: string } | null {
	const match = sql.match(/^\s*ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?["`]?([a-zA-Z0-9_]+)["`]?\s+(?:ALTER|DROP)\s+COLUMN\s+(?:IF\s+EXISTS\s+)?["`]?([a-zA-Z0-9_]+)["`]?/iu);
	return match ? { table: match[1], column: match[2] } : null;
}
