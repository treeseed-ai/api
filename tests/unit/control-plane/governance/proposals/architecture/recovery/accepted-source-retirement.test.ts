import { afterEach, expect, it, vi } from 'vitest';
import { subscriberSourceFixture, subscriberSourceProposal } from '../native-subscriber-inputs.ts';
import { readyContributionProposal } from '../ready-proposal-fixture.ts';
import { loadTeamExecutableProposalSources } from '../../../../../../../src/api/capacity/services/capacity/execution/executable-proposal-source.ts';
import { projectTeamExecutionGraph } from '../../../../../../../src/api/capacity/policy/execution/execution-graph-projector.ts';

afterEach(() => vi.unstubAllEnvs());

it('materializes accepted subscriber work after condition-only history while retiring delivered work and preserving failed recovery', async () => {
	vi.stubEnv('TREESEED_TREEDX_URL', ''); vi.stubEnv('TREESEED_TREEDX_BASE_URL', ''); vi.stubEnv('TREESEED_ENVIRONMENT', 'test');
	const f = await subscriberSourceFixture();
	try {
		// Controlled canonical inputs through owning SQL, committed Git and the
		// official HTTP reader; these are not live agents or a live approval.
		const definition = subscriberSourceProposal(readyContributionProposal());
		const published = await f.publishCurrent(definition);
		const ref = { store: 'treedx', model: 'proposal', id: 'proposal', revision: 1,
			repository: 'repository', path: 'proposals/proposal.mdx', commit: published.commit, digest: `sha256:${published.digest}` };
		const time = '2026-10-27T10:33:50.061Z';
		const decision = f.publishContent('decisions/decision.mdx', { schemaVersion: 'treeseed.decision/v1', id: 'decision',
			projectId: 'project', decisionClass: 'proposal', decisionMethod: 'authority', subjectRef: ref, disposition: 'approved',
			rationale: 'Controlled accepted source for the real condition-only retirement regression.',
			authorityRefs: [{ store: 'postgresql', model: 'user', id: 'operator' }],
			decidedByRefs: [{ store: 'postgresql', model: 'user', id: 'operator' }], decidedAt: time });
		const decisionRef = { store: 'treedx', model: 'decision', id: 'decision', revision: 1,
			repository: 'repository', path: 'decisions/decision.mdx', commit: decision.commit, digest: `sha256:${decision.digest}` };
		await f.query(`INSERT INTO governance_decisions
			(id,team_id,project_id,proposal_id,proposal_version,proposal_content_hash,status,title,summary,
			governance_provider_id,decision_record_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
			['decision', 'team', 'project', 'proposal', 1, published.digest, 'accepted', definition.title, definition.summary,
				'default', JSON.stringify({ proposalRef: ref, decisionRef }), time, time]);
		await f.query("UPDATE governance_proposals SET status='accepted',decision_id='decision' WHERE id='proposal'");
		const initial = await loadTeamExecutableProposalSources(f.store, 'team'); expect(initial).toHaveLength(1);
		const profiles = Object.fromEntries((await f.store.all('SELECT handler_refs_json FROM project_agent_classes')).flatMap(row =>
			JSON.parse(String(row.handler_refs_json)).agents.map((agent: { id: string }) => [`project:${agent.id}`, agent])));
		const graph = projectTeamExecutionGraph({ teamId: 'team', revision: 1, sources: initial, profiles });
		expect(graph.nodes.filter(node => node.kind === 'acting')).toHaveLength(2);
		expect(graph.nodes.filter(node => node.kind === 'reviewing')).toHaveLength(2);
		const insert = async (node: typeof graph.nodes[number], status: string) => f.query(`INSERT INTO execution_nodes
			(id,team_id,project_id,kind,pair_role,source_ref_json,rule_revision,node_revision,status,
			graph_revision_created,graph_revision_updated,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
			[node.id, 'team', 'project', node.kind, node.pairRole, JSON.stringify(node.sourceRef), 3, 1, status, 1, 1, time, time]);
		const condition = graph.nodes.find(node => node.kind === 'condition')!;
		await insert(condition, 'completed');
		const conditionOnly = await f.snapshot();
		for (const sources of await Promise.all([loadTeamExecutableProposalSources(f.store, 'team'), loadTeamExecutableProposalSources(f.store, 'team')])) {
			expect(sources).toEqual(initial);
			const replay = projectTeamExecutionGraph({ teamId: 'team', revision: 2, sources, profiles });
			expect(replay.nodes.map(node => node.id)).toEqual(graph.nodes.map(node => node.id));
			expect(replay.edges.map(edge => edge.id)).toEqual(graph.edges.map(edge => edge.id));
		}
		expect(await f.snapshot()).toEqual(conditionOnly);
		for (const fault of ['moved', 'denied'] as const) {
			f.setFault(fault); await expect(loadTeamExecutableProposalSources(f.store, 'team')).rejects.toThrow();
			expect(await f.snapshot()).toEqual(conditionOnly);
		}
		f.setFault('none');
		for (const node of graph.nodes.filter(node => node.kind !== 'condition')) await insert(node, 'completed');
		const delivered = await f.snapshot();
		expect(await loadTeamExecutableProposalSources(f.store, 'team')).toEqual([]);
		expect(await f.snapshot()).toEqual(delivered);
		for (const node of graph.nodes.filter(node => node.kind !== 'condition')) for (const status of ['failed', 'cancelled', 'blocked', 'ready']) {
			await f.query('UPDATE execution_nodes SET status=? WHERE id=?', [status, node.id]);
			const recoverable = await f.snapshot();
			expect(await loadTeamExecutableProposalSources(f.store, 'team')).toEqual(initial);
			expect(await f.snapshot()).toEqual(recoverable);
			await f.query("UPDATE execution_nodes SET status='completed' WHERE id=?", [node.id]);
		}
		expect(await f.snapshot()).toEqual(delivered);
	} finally { await f.close(); }
});
