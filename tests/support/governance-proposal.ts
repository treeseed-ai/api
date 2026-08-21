import type { ControlPlaneStore } from '../../src/api/persistence/store.ts';

export function completeGovernanceProposalInput(overrides: Record<string, unknown> = {}) {
	return {
		title: 'Adopt evidence-backed proposal governance',
		summary: 'Use a complete, independently reviewable proposal record as the source of durable governance decisions.',
		body: 'This proposal establishes a bounded governance process whose objectives, delivery scope, evidence, risks, alternatives, and verification remain inspectable from an immutable repository revision.',
		proposalType: 'architecture',
		relatedObjectives: ['objective:governance-integrity'],
		evidenceRefs: ['evidence:governance-acceptance-suite'],
		plan: {
			desiredOutcome: 'Every accepted decision can be traced to a complete and immutable proposal record.',
			currentProblem: 'Incomplete proposal fixtures do not prove the production governance readiness contract.',
			proposedApproach: 'Require substantive proposal fields and exercise the same readiness checks used in production.',
			scope: ['Project proposal creation, discussion, voting, and decision projection.'],
			nonGoals: ['Granting publication authority or bypassing team governance policy.'],
			deliverables: ['A durable accepted proposal and its derived decision record.'],
			acceptanceCriteria: ['Readiness, review, voting, and decision evidence are all inspectable.'],
			risks: ['A stale fixture could stop representing the production proposal contract.'],
			dependencies: ['TreeDX repository access for immutable content provenance.'],
			alternatives: ['Retain incomplete proposals and weaken readiness enforcement.'],
			verification: ['Run the API governance integration suite through the public routes.'],
			openQuestions: [],
		},
		contentProvenance: {
			repositoryId: 'repo-governance',
			contentPath: 'src/content/proposals/governance-integrity.mdx',
			commitSha: 'a'.repeat(40),
			digest: 'b'.repeat(64),
		},
		...overrides,
	};
}

export async function bindGovernanceTreeDx(
	store: ControlPlaneStore,
	teamId: string,
	projectId: string,
) {
	store.config.fetchImpl = async (input, init) => {
		const url = new URL(typeof input === 'string' ? input : input.url);
		if (init?.method === 'POST' && /\/api\/v1\/repos\/[^/]+\/workspaces$/u.test(url.pathname)) {
			return Response.json({ ok: true, workspaceId: 'governance-workspace', baseCommitSha: 'a'.repeat(40), branchName: 'refs/heads/staging' });
		}
		if (init?.method === 'POST' && url.pathname === '/api/v1/workspaces/governance-workspace/changesets') {
			return Response.json({
				ok: true, contract: 'treedx.changeset/v1', repositoryId: 'repo-governance', workspaceId: 'governance-workspace',
				baseRef: 'refs/heads/staging', baseCommitSha: 'a'.repeat(40), resultCommitSha: null, branch: 'refs/heads/staging',
				changedPaths: ['src/content/notes/governance.mdx'], files: [], patchSha256: 'c'.repeat(64),
				idempotencyKey: 'governance-discussion', idempotentReplay: false, workspaceVersion: 'governance-v1',
			});
		}
		if (init?.method === 'POST' && url.pathname === '/api/v1/workspaces/governance-workspace/commit') {
			return Response.json({ ok: true, commitSha: 'd'.repeat(40), branchName: 'refs/heads/staging', changedPaths: ['src/content/notes/governance.mdx'] });
		}
		return Response.json({ ok: false, error: `Unexpected TreeDX request: ${init?.method ?? 'GET'} ${url.pathname}` }, { status: 404 });
	};
	await store.upsertTeamTreeDx(teamId, { baseUrl: 'http://127.0.0.1:4012', status: 'active' });
	await store.upsertProjectTreeDxLibrary(projectId, {
		libraryId: `${teamId}/governance`, repositoryId: 'repo-governance', contentPath: 'src/content',
		contentRepositoryRef: 'refs/heads/main', contentRepositoryDefaultBranch: 'refs/heads/main',
	});
}
