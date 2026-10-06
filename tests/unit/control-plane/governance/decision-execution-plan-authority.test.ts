import { describe, expect, it, vi } from 'vitest';
import { validateDecisionAuthority, type DecisionAuthorityDatabase } from '../../../../src/api/governance/decision-authority.ts';
import { evaluateGovernanceProposalMethod } from '../../../../src/api/store/governance/policy/contracts/evaluate-governance-proposal.ts';
import { ControlPlaneStore, serializeGovernanceProposal } from '../../../../src/api/persistence/store.ts';
import * as executableProposal from '../../../../src/api/governance/executable-proposal.ts';
import { readyProposal } from './proposals/architecture/ready-proposal-fixture.ts';
import * as gateway from '../../../../src/api/knowledge/gateway-treedx-connection.ts';
import * as changesets from '../../../../src/api/knowledge/changesets/apply-text-changeset.ts';
import { TreeDxInfrastructureClient } from '../../../../src/api/control-plane/treedx/infrastructure-client.ts';
import { TreeDxClient, FetchTransport } from '@treeseed/treedx/treedx/client';

const digest = 'b'.repeat(64);
const baseRow = {
	id: 'decision', team_id: 'team', project_id: 'project', proposal_id: 'proposal', proposal_version: 2,
	proposal_content_hash: digest, status: 'accepted', superseded_at: null,
	proposal_status: 'accepted', active_version: 2, active_content_hash: digest,
};

// Single-row UNIT collaborator, not owning SQL integration. Preserve the
// database's generic query signature; callers choose their projected row type.
function decisionDatabase(row: Record<string, unknown>): DecisionAuthorityDatabase {
	return { first: async <T extends Record<string, unknown> = Record<string, unknown>>(): Promise<T | null> => structuredClone(row) as T };
}

describe('decision proposal authority', () => {
	it('requires immutable proposal provenance on every accepted decision', async () => {
		const database = decisionDatabase({ ...baseRow, decision_record_json: { decisionDependencies: [] } });
		await expect(validateDecisionAuthority(database, 'decision')).resolves.toMatchObject({
			valid: false, code: 'governance_decision_proposal_ref_invalid',
		});
	});

	it('denies an operational proposal snapshot without governed classed Decision authority', async () => {
		const proposalRef = { store: 'treedx', model: 'proposal', id: 'proposal', revision: 2, digest: `sha256:${digest}`, repository: 'repository', commit: 'a'.repeat(40), path: 'proposals/proposal.mdx' };
		const database = decisionDatabase({ ...baseRow, decision_record_json: { decisionDependencies: [], proposalRef } });
		await expect(validateDecisionAuthority(database, 'decision')).resolves.toMatchObject({
			valid: false,
		});
	});
});

describe('accepted proposal decision recovery', () => {
	it('retains the original open workspace journal and close failure after native Decision readback instead of reporting successful closure', async () => {
		const proposalRef = { store: 'treedx', model: 'proposal', id: 'proposal', revision: 2, digest: `sha256:${digest}`,
			repository: 'repository', commit: 'a'.repeat(40), path: 'proposals/proposal.mdx' };
		const row = { id: 'decision', project_id: 'project', status: 'creating', created_by_id: 'operator', created_at: '2026-10-04T00:00:00.000Z',
			decision_record_json: JSON.stringify({ proposalRef, rationale: 'Original approval.' }) }, proposal = { closedReason: 'admin_approved' };
		const client = new TreeDxInfrastructureClient(new TreeDxClient({ baseUrl: 'http://127.0.0.1:1', transport: new FetchTransport({ baseUrl: 'http://127.0.0.1:1', token: 'UNIT input' }) }));
		const journal: unknown[][] = [], closeFailure = new Error('controlled native close failure'); let source = '';
		const store = { getProject: async () => ({ teamId: 'team' }), all: async () => [],
			run: async (_query: string, params: unknown[]) => { journal.push(structuredClone(params)); } };
		const connection = vi.spyOn(gateway, 'resolveKnowledgeGatewayConnection').mockResolvedValue({ client, repositoryId: 'repository',
			baseUrl: 'http://127.0.0.1:1', accessToken: 'UNIT input', baseRef: proposalRef.commit, contentPath: '.', allowedPaths: ['decisions/**'],
			nodeId: '', authoringBranch: 'staging', publicationRef: 'refs/heads/staging' });
		const read = vi.spyOn(client, 'readRepositoryFile').mockRejectedValueOnce(Object.assign(new Error('Missing supplied branch'), { status: 404 }))
			.mockImplementation(async () => ({ resolvedRef: 'c'.repeat(40), file: { path: 'decisions/decision.mdx', content: source } }));
		const create = vi.spyOn(client, 'createWorkspace').mockImplementation(async input => ({ workspaceId: input.workspaceId }));
		const patch = vi.spyOn(changesets, 'applyTextChangeset').mockImplementation(async input => { source = input.changes[0]!.after ?? ''; return undefined; });
		const commit = vi.spyOn(client, 'commit').mockResolvedValue({ commitSha: 'c'.repeat(40) });
		const close = vi.spyOn(client, 'closeWorkspace').mockRejectedValue(closeFailure), held = structuredClone({ proposal, row });
		try {
			await expect(executableProposal.publishProposalDecision(store, proposal, row, [])).rejects.toBe(closeFailure);
			expect(journal).toHaveLength(1); expect(journal[0]).toContain('authoring_workspace_open');
			expect(journal[0]!.some(value => typeof value === 'string' && value.includes('decision:decision'))).toBe(true);
			expect(close).toHaveBeenCalledTimes(1); expect({ proposal, row }).toEqual(held);
		} finally { connection.mockRestore(); read.mockRestore(); create.mockRestore(); patch.mockRestore(); commit.mockRestore(); close.mockRestore(); }
	});
	it('keeps the reserved Decision and native identity when atomic projection fails without accepting or separately emitting an event', async () => {
		const proposalRef = { store: 'treedx' as const, model: 'proposal', id: 'proposal', revision: 2,
			digest: `sha256:${digest}`, repository: 'repository', commit: 'a'.repeat(40), path: 'proposals/proposal.mdx' };
		const decisionRef = { ...proposalRef, model: 'decision', id: 'decision', path: 'decisions/decision.mdx', commit: 'c'.repeat(40) };
		const row = { ...baseRow, status: 'creating', created_at: '2026-10-04T00:00:00.000Z',
			decision_record_json: JSON.stringify({ proposalRef, decisionDependencies: [], rationale: 'Original governed approval.' }) };
		const proposal = serializeGovernanceProposal({ id: 'proposal', team_id: 'team', project_id: 'project', status: 'accepted', active_version: 2,
			active_content_hash: digest, metadata_json: '{}', closed_reason: 'admin_approved' });
		const writes: string[] = [], batches: Array<Array<{ sql: string; params: unknown[] }>> = [], interruption = new Error('controlled atomic Decision interruption');
		const store = new ControlPlaneStore({ TREESEED_ENVIRONMENT: 'test' }, {
			prepare: (sql: string) => ({ bind: (...params: unknown[]) => ({ sql, params,
				first: async () => structuredClone(row), all: async () => ({ results: [] }),
				run: async () => { writes.push(sql); throw new Error('Decision projection must use its atomic batch'); },
			}) }),
			batch: async (statements: unknown[]) => {
				const captured: Array<{ sql: string; params: unknown[] }> = [];
				for (const statement of statements) {
					if (!statement || typeof statement !== 'object' || !('sql' in statement) || typeof statement.sql !== 'string'
						|| !('params' in statement) || !Array.isArray(statement.params)) throw new Error('Invalid owning prepared statement');
					captured.push({ sql: statement.sql, params: statement.params });
				}
				batches.push(captured); throw interruption;
			},
		});
		store.initializationPromise = Promise.resolve();
		const source = vi.spyOn(executableProposal, 'readExactProposal').mockResolvedValue({ source: 'UNIT supplied proposal bytes', definition: readyProposal(), ref: proposalRef });
		const publish = vi.spyOn(executableProposal, 'publishProposalDecision').mockResolvedValue(decisionRef);
		const getProposal = vi.spyOn(store, 'getGovernanceProposal').mockResolvedValue(proposal);
		const votes = vi.spyOn(store, 'effectiveGovernanceVotes').mockResolvedValue([]);
		const original = structuredClone({ row, proposal, proposalRef, decisionRef });
		try {
			for (let retry = 0; retry < 2; retry++) await expect(store.createGovernanceDecisionFromProposal('proposal', { actorType: 'user', actorId: 'operator' })).rejects.toBe(interruption);
			expect(writes).toEqual([]); expect(batches).toHaveLength(2); expect(batches[1]).toEqual(batches[0]);
			expect(batches[0]).toHaveLength(3);
			expect(batches[0]!.some(operation => operation.sql.includes('INSERT INTO governance_events') && operation.sql.includes('ON CONFLICT (id) DO NOTHING'))).toBe(true);
			expect(batches[0]!.some(operation => operation.sql.includes('UPDATE governance_decisions') && operation.params.some(value => typeof value === 'string' && value.includes('decisions/decision.mdx')))).toBe(true);
			expect({ row, proposal, proposalRef, decisionRef }).toEqual(original);
		} finally { source.mockRestore(); publish.mockRestore(); getProposal.mockRestore(); votes.mockRestore(); }
	});
	it('decision creation replay rejects retained foreign stale rejected and superseded authority before returning or rewriting an existing decision', async () => {
		const proposal = { id: 'proposal', team_id: 'team', project_id: 'project', status: 'accepted', active_version: 2,
			active_content_hash: digest, proposal_types_json: '["implementation"]', metadata_json: '{}', decision_id: 'decision' };
		const decision = { ...baseRow, decision_record_json: JSON.stringify({ decisionDependencies: [], proposalRef: {
			store: 'treedx', model: 'proposal', id: 'proposal', revision: 2, digest: `sha256:${digest}`,
			repository: 'repository', commit: 'a'.repeat(40), path: 'proposals/proposal.mdx' } }) };
		const variants = [
			{ proposal, decision: { ...decision, team_id: 'foreign-team' }, code: 'governance_decision_team_mismatch' },
			{ proposal, decision: { ...decision, project_id: 'foreign-project' }, code: 'governance_decision_project_mismatch' },
			{ proposal, decision: { ...decision, status: 'rejected' }, code: 'governance_decision_not_accepted' },
			{ proposal, decision: { ...decision, superseded_at: '2026-10-04T00:00:00.000Z' }, code: 'governance_decision_not_accepted' },
			{ proposal: { ...proposal, status: 'withdrawn' }, decision, code: 'governance_proposal_not_accepted' },
			{ proposal: { ...proposal, active_version: 3 }, decision, code: 'governance_decision_proposal_stale' },
			{ proposal: { ...proposal, active_content_hash: 'c'.repeat(64) }, decision, code: 'governance_decision_proposal_stale' },
		];
		for (const variant of variants) {
			const input = { actorType: 'user', actorId: 'operator' }, before = structuredClone({ variant, input });
			const reads: string[] = [], writes: string[] = [];
			const store = new ControlPlaneStore({ TREESEED_ENVIRONMENT: 'test' }, {
				prepare: (sql: string) => ({ bind: (..._params: unknown[]) => ({
					first: async () => { reads.push(sql);
						if (sql.includes('FROM governance_proposals')) return variant.proposal;
						if (sql.includes('LEFT JOIN governance_proposals')) return { ...variant.decision,
							proposal_status: variant.proposal.status, active_version: variant.proposal.active_version,
							active_content_hash: variant.proposal.active_content_hash };
						if (sql.includes('FROM governance_decisions')) return variant.decision;
						throw new Error('Unexpected decision-replay UNIT read'); },
					all: async () => { throw new Error('Unexpected decision-replay UNIT inventory read'); },
					run: async () => { writes.push(sql); throw new Error('Unexpected decision-replay UNIT write'); },
				}) }),
				batch: async () => { writes.push('batch'); throw new Error('Unexpected decision-replay UNIT batch'); },
			});
			store.initializationPromise = Promise.resolve();
			for (let retry = 0; retry < 2; retry++) await expect(store.createGovernanceDecisionFromProposal('proposal', input))
				.rejects.toMatchObject({ status: 409, code: variant.code });
			expect(reads.length).toBeGreaterThan(0); expect(writes).toEqual([]);
			expect({ variant, input }).toEqual(before);
		}
	});
	it('retries idempotent decision creation after an interrupted acceptance', async () => {
		const proposal = { id: 'proposal', status: 'accepted', activeVersion: 2, decisionId: null };
		const create = vi.fn(async () => ({ id: 'decision' }));
		const store = {
			ensureInitialized: vi.fn(), getGovernanceProposal: vi.fn()
				.mockResolvedValueOnce(proposal).mockResolvedValueOnce({ ...proposal, decisionId: 'decision' }),
			latestGovernanceElectorateSnapshot: vi.fn(async () => ({ id: 'electorate' })),
			createGovernanceDecisionFromProposal: create,
		};
		await expect(evaluateGovernanceProposalMethod.call(store as unknown as ControlPlaneStore, 'proposal', {
			expectedProposalVersion: 2, actorType: 'user', actorId: 'admin',
		})).resolves.toMatchObject({ decisionId: 'decision' });
		expect(create).toHaveBeenCalledWith('proposal', expect.objectContaining({ electorateSnapshotId: 'electorate', actorId: 'admin' }));
	});
});
