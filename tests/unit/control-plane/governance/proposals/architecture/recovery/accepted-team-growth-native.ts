import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { stringify } from 'yaml';
import type { AgentDefinition } from '@treeseed/sdk/agent-capacity';
import type { relationAuthoringDatabase } from '../../../../knowledge/workspaces/architecture/relation-authoring-fixture.ts';
import { loadTeamExecutableProposalSources } from '../../../../../../../src/api/capacity/services/capacity/execution/executable-proposal-source.ts';
import { loadProposalGroupContributions } from '../../../../../../../src/api/capacity/services/capacity/execution/proposal-contributions.ts';

/** Native Git publication and original PostgreSQL readback, without model execution. */
export async function verifyNativeAcceptedTeamGrowth(f: Awaited<ReturnType<typeof relationAuthoringDatabase>>,
	projectId: string, proposalId: string, template: AgentDefinition) {
	const before = (await loadTeamExecutableProposalSources(f.store, 'team')).find(source => source.frontmatter.id === proposalId);
	assert.ok(before);
	const held = { assignments: await f.store.all('SELECT * FROM capacity_provider_assignments ORDER BY id'),
		nodes: await f.store.all('SELECT * FROM execution_nodes ORDER BY id'),
		decisions: await f.store.all('SELECT * FROM governance_decisions ORDER BY id') };
	const newcomer: AgentDefinition = { ...structuredClone(template), id: 'project/new-subscriber',
		name: 'New subscriber', agentClass: 'new-subscriber' };
	const path = 'agents/new-subscriber.md';
	const workspace = await f.client.workspaces.create(before.repository, { baseRef: before.commit,
		branchName: `refs/heads/team-growth-${randomUUID()}`, mode: 'writable', allowedPaths: [path] });
	assert.ok(workspace && typeof workspace === 'object' && 'workspaceId' in workspace && typeof workspace.workspaceId === 'string');
	let commit: string;
	try {
		await f.client.files.write(workspace.workspaceId, { path, content: `---\n${stringify(newcomer)}---\n` });
		const result = await f.client.files.commit(workspace.workspaceId, { message: 'Controlled native team-growth input',
			author: { name: 'Governance fixture', email: 'governance-fixture@example.invalid' } });
		assert.ok(result && typeof result === 'object' && 'commitSha' in result && typeof result.commitSha === 'string'); commit = result.commitSha;
	} finally { await f.client.workspaces.close(workspace.workspaceId); }
	const at = new Date().toISOString();
	await f.query(`INSERT INTO project_agent_classes (id,team_id,project_id,slug,name,handler_refs_json,metadata_json,created_at,updated_at)
		VALUES (?,?,?,?,?,?,?,?,?)`, [`${projectId}:new-subscriber`, 'team', projectId, newcomer.agentClass, newcomer.name,
		JSON.stringify({ agents: [newcomer] }), JSON.stringify({ source: 'project-library', immutableRef: commit, definitionPaths: [path] }), at, at]);
	const after = (await loadTeamExecutableProposalSources(f.store, 'team')).find(source => source.frontmatter.id === proposalId);
	expect(after).toEqual(before);
	const draft = await loadProposalGroupContributions(f.store, { id: proposalId, teamId: 'team', projectId }, before.frontmatter);
	expect(draft.current).toBe(false); expect(draft.missing).toContain(`${projectId}/${newcomer.id}`);
	expect(await f.store.governanceProposalReadiness(proposalId)).toMatchObject({ executionPlanReady: true,
		participationVersionReady: true, missingParticipantEstimates: [] });
	expect(await f.store.all('SELECT * FROM capacity_provider_assignments ORDER BY id')).toEqual(held.assignments);
	expect(await f.store.all('SELECT * FROM execution_nodes ORDER BY id')).toEqual(held.nodes);
	expect(await f.store.all('SELECT * FROM governance_decisions ORDER BY id')).toEqual(held.decisions);
}
