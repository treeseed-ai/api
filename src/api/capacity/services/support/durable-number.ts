/**
 * PostgreSQL REAL values are stored as IEEE-754 binary32 numbers while the
 * JavaScript driver supplies binary64 numbers. Compare the durable binary32
 * representation so an idempotent replay cannot reject the value that the
 * database just committed.
 */
export function durableReal(value: unknown): number | null {
	if (value == null) return null;
	const number = Number(value);
	return Number.isFinite(number) ? Math.fround(number) : number;
}

export function durableRealEquals(left: unknown, right: unknown): boolean {
	return Object.is(durableReal(left), durableReal(right));
}
