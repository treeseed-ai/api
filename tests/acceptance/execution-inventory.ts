import assert from 'node:assert/strict';
import { decodeCapacityPageCursor } from '@treeseed/sdk/capacity-pagination';

type Row = Record<string, unknown>;
function row(value: unknown): Row {
	assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'ACCEPTANCE_NATIVE_INVENTORY: Explicit object required');
	return value as Row;
}

/** Additional samples required by the existing native architecture case. */
export function requireNativeAdmissionSamples(prioritizedWork: number, calibratedWork: number): void {
	assert.ok(prioritizedWork > 0, 'ACCEPTANCE_PRIORITY_EMPTY: Actual governed nonzero priority must be exercised, not only default-zero replay');
	assert.ok(calibratedWork > 0, 'ACCEPTANCE_CALIBRATION_EMPTY: Actual historical calibration is required, not only cold-start IDs');
}

/** Independent owning SQL inventory bounds public reads; matching read-backs alone cannot prove completeness. */
export async function verifyNativeInventory(native: unknown, fetch: (cursor?: string) => unknown | Promise<unknown>, limit: number,
	direction: 'ascending' | 'descending' = 'descending'): Promise<Row[]> {
	assert.ok(Number.isSafeInteger(limit) && limit > 0 && limit <= 200, 'ACCEPTANCE_NATIVE_INVENTORY: Canonical page size required');
	assert.ok(direction === 'ascending' || direction === 'descending');
	assert.ok(Array.isArray(native), 'ACCEPTANCE_NATIVE_INVENTORY: Complete native collection required');
	const expected = native.map(value => {
		const entry = row(value);
		assert.ok(typeof entry.id === 'string' && entry.id && typeof entry.created_at === 'string' && Number.isFinite(Date.parse(entry.created_at)),
			'ACCEPTANCE_NATIVE_INVENTORY: Native identity and observed creation clock required');
		return { id: entry.id, createdAt: entry.created_at };
	}).sort((left, right) => (direction === 'ascending' ? -1 : 1)
		* (left.createdAt < right.createdAt ? 1 : left.createdAt > right.createdAt ? -1 : left.id < right.id ? 1 : left.id > right.id ? -1 : 0));
	assert.equal(new Set(expected.map(value => value.id)).size, expected.length, 'ACCEPTANCE_NATIVE_INVENTORY: Ambiguous native identities');
	const observed: Row[] = []; let cursor: string | undefined;
	do {
		const response = row(await fetch(cursor)), page = row(response.page);
		assert.ok(Array.isArray(response.items), 'ACCEPTANCE_NATIVE_INVENTORY: Explicit public collection required');
		const items = response.items.map(row), slice = expected.slice(observed.length, observed.length + limit);
		assert.deepEqual(items.map(value => ({ id: value.id, createdAt: value.createdAt })), slice,
			'ACCEPTANCE_NATIVE_INVENTORY: Public producer omitted duplicated substituted or reordered native records');
		observed.push(...items);
		const more = observed.length < expected.length;
		assert.equal(page.limit, limit); assert.equal(page.hasMore, more, 'ACCEPTANCE_NATIVE_INVENTORY: Public termination conflicts with native inventory');
		if (!more) { assert.equal(page.nextCursor, null); break; }
		assert.equal(typeof page.nextCursor, 'string'); assert.notEqual(page.nextCursor, cursor);
		assert.deepEqual(decodeCapacityPageCursor(page.nextCursor), slice.at(-1), 'ACCEPTANCE_NATIVE_INVENTORY: Cursor differs from exact final native record');
		cursor = page.nextCursor as string;
	} while (observed.length < expected.length);
	assert.equal(observed.length, expected.length);
	return observed;
}
