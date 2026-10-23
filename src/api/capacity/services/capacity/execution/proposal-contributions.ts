import type { ControlPlaneStore } from '../../../../persistence/store.ts';
import { assignmentAttemptSchema, assignmentResultSchema, type AssignmentAttempt, type AgentDefinition } from '@treeseed/sdk/agent-capacity';
import { resolveWorkdayAgentProfileSnapshot } from '../workdays/policy/workday-agent-profile-policy.ts';
import { isDeepStrictEqual } from 'node:util';
import { ProjectAgentClassRepository } from '../../../repositories/projects/agents/project-agent-class.ts';
import { isCurrentSubscriberContribution } from '../assignments/planning/estimates/integration.ts';
import { contributionBindings } from '../../../policy/execution/contribution-bindings.ts';

type Row = Record<string, unknown>;
function record(value: unknown): Row { if (value && typeof value === 'object' && !Array.isArray(value)) return value as Row; if (typeof value === 'string') try { return record(JSON.parse(value)); } catch { return {}; } return {}; }
function text(value: unknown) { return typeof value === 'string' ? value.trim() : ''; }

export async function loadProposalGroupContributions(store: ControlPlaneStore, proposal: Row, definition: Row) {
	const groups = Array.isArray(definition.groupIds) ? definition.groupIds.map(text) : [];
	if (definition.schemaVersion !== 'treeseed.proposal/v2' || !groups.length) return {
		missing: ['subscriber-owned group contribution plan'], current: false, independent: false,
		attempts: [] as AssignmentAttempt[], profiles: {} as Record<string, AgentDefinition> };
	const projects = await store.listTeamProjects(text(proposal.teamId));
	const classes = new ProjectAgentClassRepository(store);
	const members = (await Promise.all(projects.map(async project => {
		try {
			const snapshot = await resolveWorkdayAgentProfileSnapshot({ listProjectAgentClassesPage: (id, page) =>
				classes.listPage(id, { ...page, cursor: null }) }, project.id, undefined, groups);
			return snapshot.agents.filter(entry => entry.definition.groupIds?.some(id => groups.includes(id))
				&& Object.values(entry.definition.activityProfiles).some(profile => profile.handler !== 'reporter'))
				.map(entry => ({ key: `${project.id}/${entry.definition.id}`, id: entry.definition.id,
					projectId: project.id, definition: entry.definition, agentClass: entry.definition.agentClass }));
		} catch (error) {
			if (record(error).code === 'capacity_workday_agent_selection_empty') return [];
			throw error;
		}
	}))).flat();
	const required = new Map(members.map(member => [member.key, member]));
	const profiles = Object.fromEntries(members.map(member => [`${member.projectId}:${member.id}`, member.definition]));
	const completed = new Set<string>();
	const completedReferences = new Set<string>();
	const completedAttempts = new Map<string, AssignmentAttempt>();
	const rows = await store.all(`SELECT assignment.id,assignment.agent_id,assignment.project_id,assignment.team_id,
		assignment.assignment_attempt_json,assignment.assignment_result_json,audit.data_json AS integration_json
		FROM capacity_provider_assignments assignment JOIN audit_events audit ON audit.target_id=assignment.id
		AND audit.target_type='capacity_provider_assignment' AND audit.event_type='assignment.content.integrated'
		WHERE assignment.team_id=? AND assignment.status='completed'
		AND assignment.assignment_attempt_json::jsonb #>> '{sourceRef,model}'='proposal'
		AND assignment.assignment_attempt_json::jsonb #>> '{sourceRef,id}'=?
		AND assignment.assignment_attempt_json::jsonb #>> '{effectiveProfile,activity}'='estimating'
		ORDER BY assignment.completed_at,assignment.id`, [text(proposal.teamId), text(proposal.id)]);
	for (const row of rows) {
		const attempt = assignmentAttemptSchema.safeParse(record(row.assignment_attempt_json));
		const result = assignmentResultSchema.safeParse(record(row.assignment_result_json));
		if (!attempt.success || !result.success || result.data.status !== 'completed' || result.data.assignmentId !== row.id
			|| attempt.data.id !== row.id) continue;
		if (attempt.data.effectiveProfile.activity !== 'estimating'
			|| row.agent_id !== attempt.data.effectiveProfile.profileRef.id || row.project_id !== attempt.data.projectId
			|| row.team_id !== attempt.data.teamId || row.team_id !== proposal.teamId) continue;
		const key = `${attempt.data.projectId}/${attempt.data.effectiveProfile.profileRef.id}`, member = required.get(key);
		if (!member || member.agentClass !== attempt.data.agentClass) continue;
		const integrated = record(row.integration_json);
		if (integrated.resultId !== result.data.id || !isDeepStrictEqual(integrated.references,
			result.data.references.filter(reference => reference.kind === 'treedx'))) continue;
		if (await isCurrentSubscriberContribution(store, proposal, definition, { id: text(row.id), teamId: text(row.team_id),
			projectId: text(row.project_id), agentId: text(row.agent_id), assignmentAttempt: attempt.data }, result.data)) {
			completed.add(key); completedReferences.add(`${attempt.data.id}\u0000${attempt.data.attempt}`);
			completedAttempts.set(attempt.data.id, attempt.data);
		}
	}
	const missing = [...required.keys()].filter(key => !completed.has(key)).sort();
	if (!required.size) missing.push('shared group subscribers');
	if (!missing.length) for (const item of Array.isArray(record(definition.executionPlan).workItems)
		? (record(definition.executionPlan).workItems as unknown[]).map(record) : []) {
		const ref = record(item.estimateRef);
		if (!completedReferences.has(`${text(ref.id)}\u0000${Number(ref.revision)}`)) missing.push(`unverified contribution ${text(item.id)}`);
	}
	if (!missing.length) try {
		contributionBindings({ teamId: text(proposal.teamId), frontmatter: definition, estimatingAttempts: [...completedAttempts.values()] }, profiles);
	} catch (error) { missing.push(error instanceof Error ? error.message : 'independent contribution execution bindings'); }
	return { missing, current: missing.length === 0, attempts: [...completedAttempts.values()], profiles,
		independent: [...completed].some(key => required.get(key)!.id !== text(proposal.createdById)) };
}
