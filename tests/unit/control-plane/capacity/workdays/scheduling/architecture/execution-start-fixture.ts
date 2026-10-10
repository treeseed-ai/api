import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Controlled original v1 input; never a managed execution receipt. */
export function executionStartFixture() {
	const directory = mkdtempSync(join(tmpdir(), 'api-execution-start-'));
	const path = join(directory, 'freeze.json');
	const preflight = { id: 'preflight-held', teamId: 'team', preflightDigest: `sha256:${'a'.repeat(64)}` };
	const freeze = { preflight, proposal: { id: 'proposal' }, request: { body: {
		proposalIds: ['proposal'], projects: ['project'], executionMode: 'simulation',
	} } };
	const receipt = { schemaVersion: 'treeseed.workday-start-receipt/v1', workdayId: 'workday-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
		preflightId: preflight.id, preflightDigest: preflight.preflightDigest, startedAt: '2026-10-10T12:00:00.000Z',
		acceptedExecutionNodeIds: [], assignmentIds: [], reservationIds: [], providerReceiptRefs: [], transactionReceiptId: `workday-start:${'b'.repeat(64)}` };
	const run = { id: receipt.workdayId, teamId: 'team', executionMode: 'simulation', status: 'completed', startedAt: receipt.startedAt,
		parameters: { proposalIds: ['proposal'], scheduledProjectIds: ['project'] } };
	const environment = { TREESEED_ACCEPTANCE_FREEZE_PATH: path, TREESEED_ACCEPTANCE_TEAM: 'team' };
	writeFileSync(path, JSON.stringify(freeze)); writeFileSync(`${path}.workday-start.json`, JSON.stringify(receipt));
	return { directory, path, freeze, receipt, run, environment, close: () => rmSync(directory, { recursive: true, force: true }) };
}
