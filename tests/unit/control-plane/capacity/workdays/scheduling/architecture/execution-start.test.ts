import { expect, it } from 'vitest';
import { chmodSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { executionWorkdayStart, verifyRetainedWorkdayStart } from '../../../../../../acceptance/execution-inventory.ts';
import { executionStartFixture } from './execution-start-fixture.ts';
import { workdayStartDatabase } from './workday-start-fixture.ts';

it('isolated managed API verifier resolves the original retained SDK start without inherited environment mutation or run discovery', () => {
	const f = executionStartFixture();
	try {
		const before = structuredClone(f.environment);
		expect(executionWorkdayStart(f.environment).id).toBe(f.receipt.workdayId);
		expect(f.environment).toEqual(before);
		expect(() => Reflect.apply(executionWorkdayStart, undefined, [{ TREESEED_ACCEPTANCE_WORKDAY_ID: f.receipt.workdayId }, true]),
			'Normal SDK cannot substitute an explicit advanced-case ID for the original frozen receipt').toThrow();
		expect(executionWorkdayStart(f.environment, true).id).toBe(f.receipt.workdayId);
		for (const invalid of [null, '', 'sdk', 0, 1, {}, []]) expect(() => Reflect.apply(executionWorkdayStart, undefined, [f.environment, invalid])).toThrow();
	} finally { f.close(); }
});

it('denies malformed missing redirected foreign or conflicting API start authority and retains failed bytes unchanged', async () => {
	const f = executionStartFixture();
	try {
		const path = `${f.path}.workday-start.json`, original = readFileSync(path), freezeBytes = readFileSync(f.path);
		for (const bytes of ['', '{', 'null', '[]', '{}', JSON.stringify({ ...f.receipt, extra: true }),
			...Object.keys(f.receipt).map(key => JSON.stringify(Object.fromEntries(Object.entries(f.receipt).filter(([name]) => name !== key))))]) {
			writeFileSync(path, bytes); expect(() => executionWorkdayStart(f.environment)).toThrow(); expect(readFileSync(path, 'utf8')).toBe(bytes);
		}
		for (const [key, values] of Object.entries({ workdayId: ['', null, 'foreign'], schemaVersion: ['', 'other'], preflightId: ['', 'foreign'],
			preflightDigest: ['', 'sha256:invalid'], startedAt: ['', 'invalid'], transactionReceiptId: ['', 'workday-start:invalid'],
			acceptedExecutionNodeIds: [null, {}, ['same', 'same']], assignmentIds: [[null], ['']], reservationIds: [[' space ']], providerReceiptRefs: ['invalid'] })) {
			for (const value of values) { const bytes = JSON.stringify({ ...f.receipt, [key]: value }); writeFileSync(path, bytes);
				expect(() => executionWorkdayStart(f.environment), key).toThrow(); expect(readFileSync(path, 'utf8')).toBe(bytes); }
		}
		writeFileSync(path, original);
		for (const environment of [{}, { TREESEED_ACCEPTANCE_WORKDAY_ID: 'invalid' }, { ...f.environment, TREESEED_ACCEPTANCE_FREEZE_PATH: '' },
			{ ...f.environment, TREESEED_ACCEPTANCE_TEAM: '' }, { ...f.environment, TREESEED_ACCEPTANCE_FREEZE_PATH: 'relative' },
			{ ...f.environment, TREESEED_ACCEPTANCE_WORKDAY_ID: 'workday-eeeeeeee-aaaa-bbbb-cccc-dddddddddddd' }]) {
			expect(() => executionWorkdayStart(environment)).toThrow();
		}
		expect(executionWorkdayStart({ TREESEED_ACCEPTANCE_WORKDAY_ID: f.receipt.workdayId }).id).toBe(f.receipt.workdayId);
		for (const target of [f.path, path]) {
			const bytes = readFileSync(target); chmodSync(target, 0); expect(() => executionWorkdayStart(f.environment)).toThrow(); chmodSync(target, 0o600);
			rmSync(target); mkdirSync(target); expect(() => executionWorkdayStart(f.environment)).toThrow(); rmSync(target, { recursive: true });
			writeFileSync(`${target}.original`, bytes); symlinkSync(`${target}.original`, target); expect(() => executionWorkdayStart(f.environment)).toThrow();
			rmSync(target); writeFileSync(target, bytes);
		}
		for (const freeze of [null, [], {}, { ...f.freeze, preflight: {} }, { ...f.freeze, proposal: { id: '' } },
			{ ...f.freeze, request: { body: { ...f.freeze.request.body, projects: [] } } },
			{ ...f.freeze, request: { body: { ...f.freeze.request.body, proposalIds: ['foreign'] } } },
			{ ...f.freeze, request: { body: { ...f.freeze.request.body, executionMode: 'production' } } }]) {
			writeFileSync(f.path, JSON.stringify(freeze)); expect(() => executionWorkdayStart(f.environment)).toThrow();
		}
		writeFileSync(f.path, freezeBytes); rmSync(path); expect(() => executionWorkdayStart(f.environment)).toThrow(); writeFileSync(path, original);
		const held = executionWorkdayStart(f.environment);
		const record = { id: 'original', team_id: 'team', operation: 'workday.start', resource_type: 'workday_start', resource_id: f.receipt.workdayId,
			idempotency_key: `golden-start:${f.freeze.preflight.id}`, request_digest: `sha256:${f.receipt.transactionReceiptId.slice('workday-start:'.length)}`, response_json: original.toString('utf8') };
		const query = async () => [record];
		expect(await verifyRetainedWorkdayStart(held, f.run, query)).toEqual([record]);
		for (const rows of [[], [record, record], [{ ...record, team_id: 'foreign' }], [{ ...record, request_digest: 'foreign' }],
			[{ ...record, response_json: '{}' }], [{ ...record, response_json: '{' }]]) await expect(verifyRetainedWorkdayStart(held, f.run, async () => rows)).rejects.toThrow();
		for (const changed of [{ id: 'foreign' }, { teamId: 'foreign' }, { executionMode: 'production' }, { status: 'failed' }, { startedAt: 'foreign' },
			{ parameters: { ...f.run.parameters, proposalIds: ['foreign'] } }, { parameters: { ...f.run.parameters, scheduledProjectIds: ['foreign'] } }]) {
			await expect(verifyRetainedWorkdayStart(held, { ...f.run, ...changed }, query)).rejects.toThrow();
		}
		const denied = new Error('original SQL denial'); await expect(verifyRetainedWorkdayStart(held, f.run, async () => { throw denied; })).rejects.toBe(denied);
		for (const target of [f.path, path]) {
			const bytes = readFileSync(target);
			await expect(verifyRetainedWorkdayStart(held, f.run, async () => { writeFileSync(target, '{}'); return [record]; })).rejects.toThrow();
			writeFileSync(target, bytes);
		}
		expect(readFileSync(f.path)).toEqual(freezeBytes); expect(readFileSync(path)).toEqual(original);
	} finally { f.close(); }
});

it('actual owning public preflight and start produce the base64url digests consumed unchanged by isolated API verification', async () => {
	const producer = await workdayStartDatabase(), f = executionStartFixture();
	try {
		const preflight = await producer.preflight(), key = `golden-start:${preflight.id}`, receipt = await producer.start(preflight, key);
		writeFileSync(f.path, JSON.stringify({ ...f.freeze, preflight })); writeFileSync(`${f.path}.workday-start.json`, JSON.stringify(receipt));
		expect(executionWorkdayStart(f.environment).id).toBe(receipt.workdayId);
		const stored = await producer.first("SELECT * FROM capacity_operation_receipts WHERE operation='workday.start' AND idempotency_key=?", [key]);
		expect(JSON.parse(String(stored!.response_json))).toEqual(receipt);
		expect(stored!.request_digest).toBe(`sha256:${receipt.transactionReceiptId.slice('workday-start:'.length)}`);
		expect(await producer.start(preflight, key)).toEqual(receipt);
	} finally { try { await producer.close(); } finally { f.close(); } }
});
