import { readFileSync } from 'node:fs';
import { splitPostgresSqlStatements } from '../../../../../../src/api/persistence/postgres-sql-statements.ts';
import { graphProfiles } from '../../../capacity/execution/graph/architecture/living/living-graph-fixture.ts';
import { proposalNativeFixture } from './proposal-native-fixture.ts';
import { loadProposalGroupContributions } from '../../../../../../src/api/capacity/services/capacity/execution/proposal-contributions.ts';
import assert from 'node:assert/strict';
import { expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { stringify } from 'yaml';
import { assignmentAttemptSchema, assignmentResultSchema, type ExactEntityReference, type AgentDefinition, type ExecutionNode } from '@treeseed/sdk/agent-capacity';
import { assignment as original } from '../../../capacity/execution/fixtures/assignment.ts';
import { readyContributionProposal, nativeProposalProfileInputs } from './ready-proposal-fixture.ts';
import type { relationAuthoringDatabase } from '../../../knowledge/workspaces/architecture/relation-authoring-fixture.ts';
import { verifyAssignmentContent, recordAssignmentContentIntegration } from '../../../../../../src/api/capacity/services/capacity/assignments/lifecycle/assignment-content-readback.ts';
import { compileWorkdayAgentProfileSnapshot } from '../../../../../../src/api/capacity/services/capacity/workdays/policy/workday-agent-profile-policy.ts';

/** Controlled governance inputs, not live agents, estimates, settlement or usage. */
export function nativeSubscriberInputs(configured: Record<string, AgentDefinition>, projectId: string, id: string, canonicalSupply: boolean) {
	const { profileInputs, closeout } = nativeProposalProfileInputs(configured, projectId, canonicalSupply);
	const subscribers = profileInputs.slice(0, 2); assert.equal(subscribers.length, 2);
	for (const [index, profile] of subscribers.entries()) {
		const acting = profile.definition.activityProfiles.acting; assert.ok(acting);
		const { dependsOn: _dependency, ...independent } = acting;
		profile.definition.groupIds = ['portfolio-runtime'];
		for (const activity of ['chat', 'planning', 'estimating', 'acting', 'reviewing'] as const) {
			profile.definition.activityProfiles[activity] = { ...structuredClone(independent),
				...(activity === 'acting' && index === 1 ? { dependsOn: { agents: [subscribers[0]!.definition.id.split('/').at(-1)!] } } : {}) };
		}
		profile.definition.activityProfiles.estimating!.permissions.content.write = ['proposal'];
		profile.raw = `---\n${stringify(profile.definition)}---\n`;
	}
	const base = readyContributionProposal(), item = base.executionPlan.workItems[0]!;
	const declaration = { ...base, id, projectId, executionPlan: { workItems: subscribers.map((profile, index) => ({
		...structuredClone(item), id: index ? 'peer-contribution' : item.id,
		objective: `Controlled own contribution from ${profile.definition.name}.`,
		estimateRef: { ...item.estimateRef, id: `controlled-estimate-${id}-${index}` },
		...(canonicalSupply ? { requiredCapabilities: ['treeseed.research.verification'],
			requestedPermissions: { content: { read: ['proposal', 'decision'], write: [] }, tools: [] } } : {}),
	})) } };
	return { declaration, profileInputs, subscribers, closeout };
}

/** Supplied completed attempts/results enter the ORIGINAL exact read-back and
 * receipt writer. Never seed an integration receipt or an accepted Decision. */
export async function recordNativeSubscriberInputs(f: Awaited<ReturnType<typeof relationAuthoringDatabase>>,
	input: ReturnType<typeof nativeSubscriberInputs>, sourceRef: ExactEntityReference, open: Set<string>) {
	assert.ok(sourceRef.repository && sourceRef.commit && sourceRef.path);
	const now = new Date().toISOString(), ids: string[] = [];
	// Controlled assignment inputs must retain the original full SQL foreign keys.
	await f.query(`INSERT INTO capacity_providers (id,fingerprint,public_jwk_json,display_name,created_at,updated_at)
		VALUES ('controlled-provider','controlled-native-input','{}','Controlled input provider',?,?) ON CONFLICT(id) DO NOTHING`, [now, now]);
	await f.query(`INSERT INTO capacity_provider_team_memberships
		(id,team_id,capacity_provider_id,approved_at,approved_by_id,created_at,updated_at)
		VALUES ('controlled-membership','team','controlled-provider',?,'controlled-operator',?,?) ON CONFLICT(id) DO NOTHING`, [now, now, now]);
	for (const [index, profile] of input.subscribers.entries()) {
		const item = input.declaration.executionPlan.workItems[index]!;
		const created = await f.client.workspaces.create(sourceRef.repository, { baseRef: sourceRef.commit,
			branchName: `refs/heads/controlled-estimate-${randomUUID()}`, mode: 'writable', allowedPaths: [sourceRef.path] });
		assert.ok(created && typeof created === 'object' && 'workspaceId' in created && typeof created.workspaceId === 'string');
		const workspaceId = created.workspaceId; open.add(workspaceId);
		const estimating = profile.definition.activityProfiles.estimating!;
		const attempt = assignmentAttemptSchema.parse({ ...original, id: item.estimateRef.id, idempotencyKey: item.estimateRef.id,
			workdayId: `controlled-workday-${item.estimateRef.id}`,
			projectId: input.declaration.projectId, agentClass: profile.definition.agentClass, workItemId: undefined, sourceRef,
			status: 'completed', createdAt: now, deadline: new Date(Date.parse(now) + Date.parse(original.deadline) - Date.parse(original.createdAt)).toISOString(),
			effectiveProfile: { ...original.effectiveProfile, handler: estimating.handler, prompt: estimating.prompt,
				activity: 'estimating', permissionCeiling: estimating.permissions,
				profileRef: { store: 'treedx', model: 'agent', id: profile.definition.id, repository: sourceRef.repository, commit: sourceRef.commit, path: profile.path } },
			workspace: { mode: 'treedx', workspaceId, repository: sourceRef.repository, baseCommit: sourceRef.commit, writablePaths: [sourceRef.path] },
			grant: { contentRead: [sourceRef], contentWrite: [sourceRef], sourceRead: [], sourceWrite: [], tools: [] } });
		const result = assignmentResultSchema.parse({ schemaVersion: 'treeseed.assignment-result/v1', id: `result-${attempt.id}`,
			assignmentId: attempt.id, status: 'completed', summary: 'Controlled native governance INPUT, no live completion or usage claimed.',
			references: [{ kind: 'treedx', projectId: attempt.projectId, repository: sourceRef.repository,
				commit: sourceRef.commit, path: sourceRef.path, workspaceId }], verification: [], diagnostics: [], usage: { elapsedSeconds: 0 }, completedAt: now });
		await freezeEstimatorWorkday(f, attempt, input.declaration.groupIds);
		await f.query(`INSERT INTO capacity_provider_assignments
			(id,membership_id,team_id,project_id,capacity_provider_id,project_agent_class_id,mode,status,agent_id,work_day_id,
			assignment_attempt_json,assignment_result_json,completed_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
			[attempt.id, 'controlled-membership', 'team', attempt.projectId, 'controlled-provider', `${attempt.projectId}:${attempt.agentClass}`,
				'planning', 'completed', profile.definition.id, attempt.workdayId, JSON.stringify(attempt), JSON.stringify(result), now, now, now]);
		const scope = { id: attempt.id, teamId: 'team', projectId: attempt.projectId, agentId: profile.definition.id, assignmentAttempt: attempt };
		const references = await verifyAssignmentContent(f.store, scope, result);
		await recordAssignmentContentIntegration(f.store, scope, result, references);
		await f.client.workspaces.close(workspaceId); open.delete(workspaceId); ids.push(attempt.id);
	}
	return ids.sort();
}

/** Original persisted profile authority for these controlled completed estimates. */
async function freezeEstimatorWorkday(f: { query(sql: string, parameters?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> },
	attempt: import('@treeseed/sdk/agent-capacity').AssignmentAttempt, groups: readonly string[]) {
	const classes = (await f.query('SELECT * FROM project_agent_classes WHERE project_id=? ORDER BY id', [attempt.projectId])).rows;
	const snapshot = compileWorkdayAgentProfileSnapshot(classes.map(row => ({ ...row,
		handlerRefs: typeof row.handler_refs_json === 'string' ? JSON.parse(row.handler_refs_json) : row.handler_refs_json })), undefined, groups);
	await f.query(`INSERT INTO capacity_workday_runs
		(id,team_id,capacity_provider_id,status,execution_kind,execution_mode,trigger_kind,parameters_json,created_at,updated_at)
		VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`, [attempt.workdayId, attempt.teamId, 'controlled-provider',
		'completed', 'workday', 'simulation', 'manual', JSON.stringify({ scheduledProjectIds: [attempt.projectId],
			agentProfilesByProjectId: { [attempt.projectId]: snapshot } }), attempt.createdAt, attempt.createdAt]);
}

export function expectNativeSubscriberGraph(input: ReturnType<typeof nativeSubscriberInputs>, nodes: ExecutionNode[]) {
	expect(nodes.filter(node => node.pairRole === 'actor')).toHaveLength(2);
	expect(nodes.filter(node => node.pairRole === 'reviewer')).toHaveLength(2);
	for (const [index, subscriber] of input.subscribers.entries()) {
		const workItemId = input.declaration.executionPlan.workItems[index]!.id;
		const actor = nodes.find(node => node.workItemId === workItemId && node.pairRole === 'actor'); assert.ok(actor);
		const reviewer = nodes.find(node => node.workItemId === workItemId && node.pairRole === 'reviewer'); assert.ok(reviewer);
		expect(actor.authorityRefs).toContainEqual(expect.objectContaining({ model: 'agent', id: subscriber.definition.id }));
		expect(actor.authorityRefs).toContainEqual(input.declaration.executionPlan.workItems[index]!.estimateRef);
		expect(reviewer.authorityRefs).toContainEqual(expect.objectContaining({ model: 'agent', id: subscriber.definition.id }));
		expect(reviewer.authorityRefs).toContainEqual(input.declaration.executionPlan.workItems[index]!.estimateRef);
		expect(reviewer.id).not.toBe(actor.id);
		expect(reviewer.kind).toBe('reviewing');
		expect(reviewer.estimate).toEqual(input.declaration.executionPlan.workItems[index]!.reviewEstimate);
	}
}

/** Each controlled author supplies separate own work and peer-review capacity. */
export function subscriberSourceProposal<T extends { executionPlan: { workItems: Array<Record<string, unknown>> } }>(input: T) {
	const items = input.executionPlan.workItems.map(item => ({ ...item,
		estimateRef: { store: 'postgresql', model: 'assignment-attempt', id: 'controlled-estimate-proposal-0', revision: 1 } }));
	return { ...input, executionPlan: { workItems: [...items, ...items.map((item, index) => ({ ...item,
		id: `controlled-peer-${index}`, dependsOn: [], estimateRef: { ...item.estimateRef, id: 'controlled-estimate-proposal-1' },
	}))] } };
}

/** Owning SQL, official client and committed Git. The HTTP server, completed
 * attempts and results are controlled INPUTS; no live agents or TreeDX claimed. */
export async function subscriberSourceFixture() {
	const f = await proposalNativeFixture();
	try {
		for (const sql of splitPostgresSqlStatements(readFileSync('drizzle/control-plane/0031_workday_execution_mode_authority.sql', 'utf8'))) await f.query(sql);
		const ddl = splitPostgresSqlStatements(readFileSync('drizzle/control-plane/0000_control_plane.sql', 'utf8'));
		for (const table of ['project_agent_classes', 'audit_events']) {
			const statement = ddl.find(sql => sql.startsWith(`CREATE TABLE "${table}" (`));
			if (!statement) throw new Error(`Original DDL required: ${table}`); await f.query(statement);
		}
		const profiles = nativeSubscriberInputs(graphProfiles(), 'project', 'proposal', false).subscribers
			.map(profile => ({ ...profile, path: profile.path.replace(/\.md$/u, '.mdx') }));
		for (const profile of profiles) f.publishContent(profile.path, { ...profile.definition });
		const store = { ...f.store, run: (sql: string, params: unknown[] = []) => f.query(sql, params),
			ensureInitialized: async () => {}, listTeamProjects: async () => [{ id: 'project' }] };
		const publishCurrent = async (definition: Record<string, unknown>) => {
			const exact = await f.publish(definition), path = 'proposals/proposal.mdx';
			const sourceRef = { store: 'treedx', model: 'proposal', id: 'proposal', revision: 1,
				repository: 'repository', commit: exact.commit, path, digest: `sha256:${exact.digest}` };
			for (const [index, profile] of profiles.entries()) {
				const id = `controlled-estimate-proposal-${index}`;
				await f.query(`INSERT INTO project_agent_classes (id,team_id,project_id,slug,name,handler_refs_json,metadata_json,created_at,updated_at)
					VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET metadata_json=EXCLUDED.metadata_json`,
					[profile.definition.agentClass, 'team', 'project', profile.definition.agentClass, profile.definition.name,
						JSON.stringify({ agents: [profile.definition] }), JSON.stringify({ source: 'project-library', immutableRef: exact.commit,
							definitionPaths: [profile.path] }), original.createdAt, original.createdAt]);
				const attempt = assignmentAttemptSchema.parse({ ...original, id, workItemId: undefined, sourceRef, status: 'completed',
					workdayId: `controlled-workday-${id}`,
					agentClass: profile.definition.agentClass,
					effectiveProfile: { ...original.effectiveProfile, activity: 'estimating', handler: 'writer',
						profileRef: { store: 'treedx', model: 'agent', id: profile.definition.id, repository: 'repository', commit: exact.commit, path: profile.path } },
					workspace: { mode: 'treedx', workspaceId: `controlled-${id}`, repository: 'repository', baseCommit: exact.commit, writablePaths: [path] },
					grant: { contentRead: [sourceRef], contentWrite: [sourceRef], sourceRead: [], sourceWrite: [], tools: [] } });
				const result = assignmentResultSchema.parse({ schemaVersion: 'treeseed.assignment-result/v1', id: `result-${id}-${exact.commit}`,
					assignmentId: id, status: 'completed', summary: 'Controlled source-intake INPUT, no live agent completion or usage claimed.',
					references: [{ kind: 'treedx', projectId: 'project', repository: 'repository', commit: exact.commit, path, workspaceId: `controlled-${id}` }],
					verification: [], diagnostics: [], usage: { elapsedSeconds: 0 }, completedAt: original.createdAt });
				await freezeEstimatorWorkday(f, attempt, Array.isArray(definition.groupIds) ? definition.groupIds.map(String) : []);
				await f.query(`INSERT INTO capacity_provider_assignments
					(id,membership_id,team_id,project_id,capacity_provider_id,project_agent_class_id,mode,status,agent_id,work_day_id,
					assignment_attempt_json,assignment_result_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
					ON CONFLICT(id) DO UPDATE SET assignment_attempt_json=EXCLUDED.assignment_attempt_json,assignment_result_json=EXCLUDED.assignment_result_json,work_day_id=EXCLUDED.work_day_id`,
					[id, 'controlled-membership', 'team', 'project', 'controlled-provider', profile.definition.agentClass, 'planning', 'completed',
						profile.definition.id, attempt.workdayId, JSON.stringify(attempt), JSON.stringify(result), original.createdAt, original.createdAt]);
				const scope = { id, teamId: 'team', projectId: 'project', agentId: profile.definition.id, assignmentAttempt: attempt };
				const references = await verifyAssignmentContent(store, scope, result);
				await recordAssignmentContentIntegration(store, scope, result, references);
			}
			const contributions = await loadProposalGroupContributions(store as never,
				{ id: 'proposal', projectId: 'project', teamId: 'team' }, definition);
			if (!contributions.current) throw new Error(`Controlled current subscriber source is incomplete: ${JSON.stringify(contributions.missing)}`);
			return exact;
		};
		return { ...f, store, publishCurrent };
	} catch (error) { await f.close(); throw error; }
}
