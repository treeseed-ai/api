import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { createGovernanceService } from '../../../../../src/api/control-plane/governance/governance-service.ts';
import { createGovernanceOperations } from '../../../../../src/api/control-plane/catalog/governance-operations.ts';
import { createOperationHttpHandler } from '../../../../../src/api/control-plane/http/operation-http-handler.ts';
import { readExactProposal } from '../../../../../src/api/governance/executable-proposal.ts';
import { getGovernanceProposalMethod } from '../../../../../src/api/store/governance/policy/queries/proposals/get-governance-proposal.ts';
import { proposalNativeFixture } from './architecture/proposal-native-fixture.ts';

describe('native shared proposal detail read', () => {
	it('returns the authored plan from the exact TreeDX source and distinguishes absence, source failure, and project denial', async () => {
		const native = await proposalNativeFixture();
		try {
			const item: Record<string, unknown> = {
				id: 'verify-boundary', activity: 'acting', workspace: 'read-only', review: 'required',
				objective: 'Independently verify the exact governed boundary.', dependsOn: [],
				requestedPermissions: { content: { read: ['proposal'], write: [] }, tools: [] },
				acceptanceCriteria: ['Read back the exact source and record independent verification.'],
				estimate: { expectedSeconds: 30, maximumSeconds: 60, rationale: 'Controlled own implementation estimate.' },
				reviewEstimate: { expectedSeconds: 10, maximumSeconds: 20, rationale: 'Controlled own independent review estimate.' },
				maximumReviewCycles: 2,
			};
			const definition: Record<string, unknown> = {
				schemaVersion: 'treeseed.proposal/v2', id: 'proposal', projectId: 'project', title: 'Governed boundary',
				request: 'Verify the exact governed boundary.', summary: 'One bounded, independently reviewed work item.',
				status: 'draft', groupIds: ['portfolio-runtime'], executionPlan: { workItems: [item] },
			};
			item.estimateRef = { store: 'postgresql', model: 'assignment-attempt', id: 'authored-estimate', revision: 7 };
			const authoredPlan = structuredClone(definition.executionPlan);
			const proposalStore = { ...native.store, ensureInitialized: async () => undefined };
			let exact = await native.publish(definition);
			const row = await getGovernanceProposalMethod.call(proposalStore as never, 'proposal');
			expect(row).toMatchObject({ id: 'proposal', projectId: 'project', activeContentHash: exact.digest });
			const exactRead = await readExactProposal(native.store, row!);
			expect(exactRead.source).toBe(exact.source);
			expect(exactRead.ref).toMatchObject({ revision: 1, commit: exact.commit, digest: `sha256:${exact.digest}` });
			const store = {
				...native.store,
				getProjectDetails: async () => ({ project: { id: 'project', teamId: 'team' } }),
				principalCanAccessTeam: async (principal: { id?: string }, teamId: string) => principal.id === 'reader' && teamId === 'team',
				getGovernanceProposal: getGovernanceProposalMethod.bind(proposalStore as never),
				listGovernanceProposalVotes: async () => [],
				listGovernanceEvents: async () => [],
				governanceProposalReadiness: async () => ({ contentReady: true }),
				getGovernanceDecision: async () => null,
			};
			const service = createGovernanceService(store, { create: async () => ({}) });
			const principal = { id: 'reader', roles: ['member'] };

			const detail = await service.proposal(principal, 'project', 'proposal');
			expect.soft(detail.executionPlan).toEqual(authoredPlan);
			const operation = createGovernanceOperations({ governance: service }).find(candidate =>
				candidate.binding.descriptor.operationId === 'governance.proposals.show')!;
			const rest = operation.binding.descriptor.rest!;
			const route = rest.path.replace('{projectId}', ':projectId').replace('{proposalId}', ':proposalId');
			const app = new Hono();
			app.on(rest.method, route, createOperationHttpHandler(operation, async () => ({ token: 'test-token',
				clientId: 'client', scopes: [...operation.binding.descriptor.oauthScopes],
				extra: { principal: { id: 'reader', roles: ['member'] } },
			}), 'sha256:test'));
			const response = await app.request(route.replace(':projectId', 'project').replace(':proposalId', 'proposal'), {
				headers: { authorization: 'Bearer test-token' },
			});
			expect(response.status).toBe(200);
			const envelope = await response.json() as { data: Record<string, unknown> };
			expect(envelope.data.executionPlan).toEqual(authoredPlan);
			if (detail.executionPlan) {
				expect(detail.executionPlan.workItems[0]).not.toHaveProperty('requiredCapabilities');
				expect(detail.executionPlan.workItems[0].estimateRef).toEqual(item.estimateRef);
			}
			expect(detail).toMatchObject({ votes: [], events: [], readiness: { contentReady: true }, decision: null });

			const withoutPlan = { ...definition };
			delete (withoutPlan as Record<string, unknown>).executionPlan;
			exact = await native.publish(withoutPlan);
			const noPlanRow = await getGovernanceProposalMethod.call(proposalStore as never, 'proposal');
			const noPlanSource = await readExactProposal(native.store, noPlanRow!);
			expect(noPlanSource.source).toBe(exact.source);
			expect(noPlanSource.source).not.toContain('executionPlan:');
			await expect.soft(service.proposal(principal, 'project', 'proposal')).resolves.toMatchObject({ executionPlan: null });

			await native.query("UPDATE governance_proposals SET metadata_json='{}' WHERE id='proposal'");
			await expect.soft(service.proposal(principal, 'project', 'proposal')).rejects.toMatchObject({ code: 'proposal_exact_source_missing' });
			await native.query('UPDATE governance_proposals SET metadata_json=? WHERE id=?', [JSON.stringify({ contentProvenance: {
				repositoryId: 'repository', contentPath: 'proposals/proposal.mdx', commitSha: exact.commit, digest: exact.digest } }), 'proposal']);
			await native.query('UPDATE governance_proposals SET active_version=0 WHERE id=?', ['proposal']);
			const wrongVersionRow = await getGovernanceProposalMethod.call(proposalStore as never, 'proposal');
			await expect(readExactProposal(native.store, wrongVersionRow!)).rejects.toMatchObject({ code: 'proposal_exact_source_missing' });
			await expect.soft(service.proposal(principal, 'project', 'proposal')).rejects.toMatchObject({ code: 'proposal_exact_source_missing' });
			await native.query('UPDATE governance_proposals SET active_version=1 WHERE id=?', ['proposal']);

			for (const fault of ['denied', 'moved'] as const) {
				native.setFault(fault);
				await expect.soft(service.proposal(principal, 'project', 'proposal')).rejects.toThrow();
			}
			native.setFault('none');
			await native.query('UPDATE governance_proposals SET active_content_hash=? WHERE id=?', ['f'.repeat(64), 'proposal']);
			await expect.soft(service.proposal(principal, 'project', 'proposal')).rejects.toMatchObject({ code: 'proposal_digest_mismatch' });
			await native.query('UPDATE governance_proposals SET active_content_hash=? WHERE id=?', [exact.digest, 'proposal']);
			const invalid = { ...definition, executionPlan: { workItems: [] } };
			exact = await native.publish(invalid);
			await native.query('UPDATE governance_proposals SET active_content_hash=?,metadata_json=? WHERE id=?', [exact.digest,
				JSON.stringify({ contentProvenance: { repositoryId: 'repository', contentPath: 'proposals/proposal.mdx', commitSha: exact.commit, digest: exact.digest } }), 'proposal']);
			const invalidRow = await getGovernanceProposalMethod.call(proposalStore as never, 'proposal');
			await expect(readExactProposal(native.store, invalidRow!)).rejects.toMatchObject({ status: 422, code: 'proposal_execution_plan_invalid' });
			await expect.soft(service.proposal(principal, 'project', 'proposal')).rejects.toMatchObject({
				status: 422, code: 'proposal_execution_plan_invalid',
			});
			await expect.soft(service.proposal({ id: 'outsider' }, 'project', 'proposal')).rejects.toMatchObject({
				status: 403, code: 'project_access_denied',
			});
		} finally {
			await native.close();
		}
	});
});
