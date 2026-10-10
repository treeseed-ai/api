import assert from 'node:assert/strict';
import { decodeCapacityPageCursor } from '@treeseed/sdk/capacity-pagination';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { canonicalJson, sha256 } from '../../dist/api/capacity/security.js';

type Row = Record<string, unknown>;

type ExecutionStart = { id: string | undefined; retained?: {
	path: string; bytes: Buffer; receiptPath: string; receiptBytes: Buffer; freeze: Row; receipt: Row;
} };
function retainedBytes(path: string): Buffer {
	assert.ok(isAbsolute(path) && realpathSync(path) === resolve(path) && lstatSync(path).isFile(),
		'ACCEPTANCE_EXECUTION_START: Independent regular retained file required');
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const stat = fstatSync(fd);
		assert.ok(stat.isFile() && (stat.mode & 0o444) !== 0, 'ACCEPTANCE_EXECUTION_START: Readable regular retained file required');
		return readFileSync(fd);
	} finally { closeSync(fd); }
}

/** SDK children consume the original API receipt; advanced cases retain explicit IDs. */
export function executionWorkdayStart(environment: NodeJS.ProcessEnv = process.env): ExecutionStart {
	const explicit = environment.TREESEED_ACCEPTANCE_WORKDAY_ID, path = environment.TREESEED_ACCEPTANCE_FREEZE_PATH;
	if (explicit !== undefined) assert.match(explicit, /^workday-[a-f0-9-]+$/u, 'ACCEPTANCE_EXECUTION_START: Invalid explicit workday');
	if (path === undefined) {
		assert.ok(explicit, 'ACCEPTANCE_EXECUTION_START: Explicit run or frozen SDK input required');
		return { id: explicit };
	}
	assert.ok(path && environment.TREESEED_ACCEPTANCE_TEAM?.trim(), 'ACCEPTANCE_EXECUTION_START: Explicit freeze and team required');
	const bytes = retainedBytes(path), freeze = row(JSON.parse(bytes.toString('utf8'))), receiptPath = `${path}.workday-start.json`;
	const receiptBytes = retainedBytes(receiptPath), receipt = row(JSON.parse(receiptBytes.toString('utf8'))), preflight = row(freeze.preflight);
	assert.deepEqual(Object.keys(receipt).sort(), ['schemaVersion', 'workdayId', 'preflightId', 'preflightDigest', 'startedAt',
		'acceptedExecutionNodeIds', 'assignmentIds', 'reservationIds', 'providerReceiptRefs', 'transactionReceiptId'].sort(),
		'ACCEPTANCE_EXECUTION_START: Complete original receipt fields required');
	assert.equal(receipt.schemaVersion, 'treeseed.workday-start-receipt/v1');
	const id = receipt.workdayId;
	assert.ok(typeof id === 'string' && /^workday-[a-f0-9-]+$/u.test(id), 'ACCEPTANCE_EXECUTION_START: Exact issued workday required');
	assert.ok(typeof preflight.id === 'string' && preflight.id.trim() === preflight.id && preflight.id
		&& typeof preflight.teamId === 'string' && preflight.teamId.trim() === preflight.teamId && preflight.teamId
		&& typeof preflight.preflightDigest === 'string' && /^sha256:[A-Za-z0-9_-]{43}$/u.test(preflight.preflightDigest));
	assert.equal(receipt.preflightId, preflight.id); assert.equal(receipt.preflightDigest, preflight.preflightDigest);
	assert.ok(typeof receipt.startedAt === 'string' && Number.isFinite(Date.parse(receipt.startedAt))
		&& typeof receipt.transactionReceiptId === 'string' && /^workday-start:[A-Za-z0-9_-]{43}$/u.test(receipt.transactionReceiptId));
	for (const key of ['acceptedExecutionNodeIds', 'assignmentIds', 'reservationIds', 'providerReceiptRefs']) {
		const values = receipt[key]; assert.ok(Array.isArray(values) && values.every(value => typeof value === 'string' && value.trim() === value && value)
			&& new Set(values).size === values.length, 'ACCEPTANCE_EXECUTION_START: Complete unique original inventories required');
	}
	const body = row(row(freeze.request).body), proposal = row(freeze.proposal);
	assert.ok(typeof proposal.id === 'string' && proposal.id.trim() === proposal.id && proposal.id);
	assert.deepEqual(body.proposalIds, [proposal.id]); assert.equal(body.executionMode, 'simulation');
	assert.ok(Array.isArray(body.projects) && body.projects.length > 0 && body.projects.every(value => typeof value === 'string' && value.trim() === value && value)
		&& new Set(body.projects).size === body.projects.length);
	if (explicit !== undefined) assert.equal(explicit, id, 'ACCEPTANCE_EXECUTION_START: Conflicting explicit workday');
	return { id, retained: { path, bytes, receiptPath, receiptBytes, freeze, receipt } };
}

/** Native start custody independently binds the retained observation and public run. */
export async function verifyRetainedWorkdayStart(held: ExecutionStart, run: Row,
	query: (sql: string, parameters: unknown[]) => Promise<Row[]>): Promise<Row[]> {
	if (!held.retained) return [];
	const { path, bytes, receiptPath, receiptBytes, freeze, receipt } = held.retained;
	const preflight = row(freeze.preflight), body = row(row(freeze.request).body), key = `golden-start:${preflight.id}`;
	assert.equal(run.id, held.id); assert.equal(run.teamId, preflight.teamId); assert.equal(run.executionMode, 'simulation');
	assert.equal(run.status, 'completed'); assert.equal(run.startedAt, receipt.startedAt);
	assert.deepEqual(row(run.parameters).proposalIds, body.proposalIds); assert.deepEqual(row(run.parameters).scheduledProjectIds, body.projects);
	const records = await query(`SELECT * FROM capacity_operation_receipts WHERE team_id=$1 AND operation='workday.start'
		AND resource_type='workday_start' AND resource_id=$2 AND idempotency_key=$3 ORDER BY id`, [preflight.teamId, held.id, key]);
	assert.equal(records.length, 1, 'ACCEPTANCE_EXECUTION_START: One scoped original native start required');
	const stored = row(records[0]);
	assert.equal(stored.team_id, preflight.teamId); assert.equal(stored.operation, 'workday.start'); assert.equal(stored.resource_type, 'workday_start');
	assert.equal(stored.resource_id, held.id); assert.equal(stored.idempotency_key, key);
	const digest = sha256(canonicalJson({ preflightId: preflight.id, preflightDigest: preflight.preflightDigest, idempotencyKey: key }));
	assert.equal(stored.request_digest, `sha256:${digest}`); assert.equal(receipt.transactionReceiptId, `workday-start:${digest}`);
	assert.deepEqual(row(JSON.parse(String(stored.response_json))), receipt, 'ACCEPTANCE_EXECUTION_START: Retained observation differs from original native response');
	assert.deepEqual(retainedBytes(path), bytes); assert.deepEqual(retainedBytes(receiptPath), receiptBytes);
	return records;
}
function row(value: unknown): Row {
	assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'ACCEPTANCE_NATIVE_INVENTORY: Explicit object required');
	return value as Row;
}

/** Sample minima supplement the architecture case; SDK may genuinely cold-start.
 * Both cases still replay every stored priority/calibration input independently. */
export function requireNativeAdmissionSamples(prioritizedWork: number, calibratedWork: number, requireObservedSamples = true): void {
	assert.equal(typeof requireObservedSamples, 'boolean', 'ACCEPTANCE_SCHEMA_SAMPLES: Explicit case scope required');
	for (const count of [prioritizedWork, calibratedWork]) assert.ok(Number.isSafeInteger(count) && count >= 0,
		'ACCEPTANCE_SCHEMA_SAMPLES: Complete nonnegative observed sample counts required');
	if (!requireObservedSamples) return;
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
