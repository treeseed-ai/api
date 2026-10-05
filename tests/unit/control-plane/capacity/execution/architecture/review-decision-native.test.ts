import { describe, expect, it, vi } from 'vitest';
import type { CapacityGovernanceDatabase } from '../../../../../../src/api/capacity/database.ts';
import { resolveReviewDisposition } from '../../../../../../src/api/capacity/services/capacity/assignments/context/review-result.ts';
import { proposalNativeFixture } from '../../../governance/proposals/architecture/proposal-native-fixture.ts';
import { actorResult, assignedAt, candidateCommit, reviewAssignment, reviewDecision, reviewResult } from './review-decision-fixture.ts';

// Original migration SQL, real PGlite, official FetchTransport and native committed YAML.
// The isolated HTTP endpoint is not a full TreeDX server or managed/provider proof.
async function nativeReview() {
	vi.stubEnv('TREESEED_TREEDX_URL', '');
	const fixture = await proposalNativeFixture();
	try {
		for (const [id, pairRole, kind] of [['actor-node', 'actor', 'acting'], ['review-node', 'reviewer', 'reviewing']]) {
			await fixture.query(`INSERT INTO execution_nodes (id,team_id,project_id,kind,pair_role,source_ref_json,rule_revision,
				node_revision,status,workspace,graph_revision_created,graph_revision_updated,created_at,updated_at)
				VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [id, 'team', 'project', kind, pairRole,
				JSON.stringify({ store: 'git', model: 'source', id: 'candidate', repository: 'source', commit: candidateCommit }),
				1, 1, pairRole === 'actor' ? 'completed' : 'running', 'read-only', 1, 1, assignedAt, assignedAt]);
		}
		await fixture.query(`INSERT INTO execution_edges (id,team_id,from_node_id,to_node_id,provenance,
			graph_revision_created,created_at) VALUES (?,?,?,?,?,?,?)`, ['pair', 'team', 'actor-node', 'review-node', 'review-pair', 1, assignedAt]);
		await fixture.query(`INSERT INTO capacity_provider_assignments (id,membership_id,team_id,project_id,capacity_provider_id,
			project_agent_class_id,mode,status,execution_node_id,execution_node_revision,assignment_result_json,completed_at,created_at,updated_at)
			VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, ['actor-assignment', 'membership', 'team', 'project', 'provider',
				'arbitrary-author', 'acting', 'completed', 'actor-node', 1, JSON.stringify(actorResult()), actorResult().completedAt, assignedAt, assignedAt]);
		const resolve = (commit: string, otherCommit?: string) => {
			const result = reviewResult(commit);
			if (otherCommit) result.references.push({ kind: 'treedx', projectId: 'project', repository: 'repository',
				commit: otherCommit, path: 'decisions/review-two.mdx', workspaceId: 'workspace' });
			return resolveReviewDisposition(fixture.store as unknown as CapacityGovernanceDatabase, reviewAssignment(), result);
		};
		return { ...fixture, resolve };
	} catch (error) { await fixture.close(); throw error; }
}

describe('native classed work-review authority', () => {
	it('reads exact committed authority, approval and vote evidence repeatedly and concurrently without mutation', async () => {
		const fixture = await nativeReview();
		try {
			for (const decisionMethod of ['authority', 'approval', 'vote']) {
				const decision = { ...reviewDecision(), decisionMethod, ...(decisionMethod === 'authority' ? {} : {
					positions: [{ actorRef: reviewDecision().decidedByRefs[0], position: 'approve', recordedAt: reviewDecision().decidedAt }] }) };
				const source = fixture.publishContent('decisions/review-one.mdx', decision), before = await fixture.snapshot();
				await expect(fixture.resolve(source.commit)).resolves.toBe('approved');
				expect(await Promise.all([fixture.resolve(source.commit), fixture.resolve(source.commit)])).toEqual(['approved', 'approved']);
				expect(await fixture.snapshot()).toEqual(before);
				expect(fixture.requests.slice(-3)).toEqual(Array(3).fill({ ref: source.commit, path: 'decisions/review-one.mdx' }));
			}
		} finally { await fixture.close(); }
	});
	it('rejects method labels without exact signed positions through native content readback', async () => {
		const fixture = await nativeReview();
		try {
			for (const decisionMethod of ['approval', 'vote']) {
				const source = fixture.publishContent('decisions/review-one.mdx', { ...reviewDecision(), decisionMethod });
				const before = await fixture.snapshot();
				await expect(fixture.resolve(source.commit)).rejects.toMatchObject({ code: 'review_decision_required' });
				expect(await fixture.snapshot()).toEqual(before);
			}
		} finally { await fixture.close(); }
	});
	it('denies missing and malformed classed authority from actual committed YAML without changing SQL', async () => {
		const fixture = await nativeReview();
		try {
			const mutations: Array<Record<string, unknown>> = Object.keys(reviewDecision()).map(field => {
				const value: Record<string, unknown> = reviewDecision(); delete value[field]; return value;
			});
			mutations.push({ ...reviewDecision(), decisionClass: 'proposal' }, { ...reviewDecision(), disposition: 'rejected' },
				{ ...reviewDecision(), executionPlan: {} }, { ...reviewDecision(), decisionMethod: 'guess' });
			for (const value of mutations) {
				const source = fixture.publishContent('decisions/review-one.mdx', value), before = await fixture.snapshot();
				await expect(fixture.resolve(source.commit)).rejects.toMatchObject({ code: 'review_decision_required' });
				expect(await fixture.snapshot()).toEqual(before);
			}
		} finally { await fixture.close(); }
	});
	it('rejects conflicting committed dispositions instead of treating reference order as authority', async () => {
		const fixture = await nativeReview();
		try {
			const first = fixture.publishContent('decisions/review-one.mdx', reviewDecision());
			const second = fixture.publishContent('decisions/review-two.mdx', { ...reviewDecision(), id: 'review-two', disposition: 'request-changes' });
			const before = await fixture.snapshot();
			await expect(fixture.resolve(first.commit, second.commit)).rejects.toMatchObject({ code: 'review_decision_required' });
			expect(await fixture.snapshot()).toEqual(before);
			for (const mutation of ['maker', 'project', 'candidate', 'clock']) for (const foreignFirst of [false, true]) {
				const foreign = { ...reviewDecision(),
					...(mutation === 'maker' ? { decidedByRefs: [{ ...reviewDecision().decidedByRefs[0]!, id: 'unassigned-reviewer' }] } : {}),
					...(mutation === 'project' ? { projectId: 'foreign-project' } : {}),
					...(mutation === 'candidate' ? { subjectRef: { ...reviewDecision().subjectRef, commit: 'e'.repeat(40) } } : {}),
					...(mutation === 'clock' ? { decidedAt: '2026-10-02T12:00:11.000Z' } : {}) };
				const nextFirst = fixture.publishContent('decisions/review-one.mdx', foreignFirst ? foreign : reviewDecision());
				const nextSecond = fixture.publishContent('decisions/review-two.mdx', { ...(foreignFirst ? reviewDecision() : foreign), id: 'review-two' });
				const retained = await fixture.snapshot();
				await expect(fixture.resolve(nextFirst.commit, nextSecond.commit)).rejects.toMatchObject({ code: 'review_decision_required' });
				expect(await fixture.snapshot()).toEqual(retained);
			}
		} finally { await fixture.close(); }
	});
	it('denies committed evidence attributed to a different reviewing identity', async () => {
		const fixture = await nativeReview();
		try {
			const source = fixture.publishContent('decisions/review-one.mdx', { ...reviewDecision(),
				decidedByRefs: [{ ...reviewDecision().decidedByRefs[0]!, id: 'unassigned-reviewer' }] });
			const before = await fixture.snapshot();
			await expect(fixture.resolve(source.commit)).rejects.toMatchObject({ code: 'review_decision_required' });
			expect(await fixture.snapshot()).toEqual(before);
		} finally { await fixture.close(); }
	});
	it('rejects stale or future committed Decision times relative to the original review assignment and result', async () => {
		const fixture = await nativeReview();
		try {
			for (const decidedAt of ['2026-10-02T11:59:00.000Z', '2026-10-02T12:00:11.000Z']) {
				const source = fixture.publishContent('decisions/review-one.mdx', { ...reviewDecision(), decidedAt });
				const before = await fixture.snapshot();
				await expect(fixture.resolve(source.commit)).rejects.toMatchObject({ code: 'review_decision_required' });
				expect(await fixture.snapshot()).toEqual(before);
			}
		} finally { await fixture.close(); }
	});
	it('denies moved and forbidden source readback without changing persisted authority', async () => {
		const fixture = await nativeReview();
		try {
			const source = fixture.publishContent('decisions/review-one.mdx', reviewDecision()), before = await fixture.snapshot();
			for (const fault of ['denied', 'moved'] as const) {
				fixture.setFault(fault); await expect(fixture.resolve(source.commit)).rejects.toBeDefined();
				expect(await fixture.snapshot()).toEqual(before);
			}
		} finally { await fixture.close(); }
	});
	it('does not approve a stale candidate outside immutable predecessor result identities', async () => {
		const fixture = await nativeReview();
		try {
			const source = fixture.publishContent('decisions/review-one.mdx', reviewDecision());
			await fixture.query('UPDATE capacity_provider_assignments SET assignment_result_json=? WHERE id=?',
				[JSON.stringify({ ...actorResult(), id: 'unassigned-result' }), 'actor-assignment']);
			const before = await fixture.snapshot();
			await expect(fixture.resolve(source.commit)).rejects.toMatchObject({ code: 'review_candidate_reference_missing' });
			expect(await fixture.snapshot()).toEqual(before);
		} finally { await fixture.close(); }
	});
});
