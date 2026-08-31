import { createHash,randomUUID } from 'node:crypto';
import { evaluateMinimumAssignmentDuration } from '../../../policy/timing/assignment-duration.ts';
import { CapacityGovernanceError } from '../../../database.ts';

type Row = Record<string, unknown>;

interface DiscussionInvocationStore {
	first(query: string, params?: unknown[]): Promise<Row | null>;
	all(query: string, params?: unknown[]): Promise<Row[]>;
	run(query: string, params?: unknown[]): Promise<unknown>;
	createCapacityWorkdayRun(teamId: string, input: Row): Promise<Row>;
	tickCapacityWorkdayRun(teamId: string, runId: string, now?: string, idempotencyKey?: string): Promise<Row>;
	updateCapacityWorkdayRun(teamId: string, runId: string, input: Row): Promise<Row | null>;
}

export async function terminalizeCompletedConversationInvocation(
	store: Pick<DiscussionInvocationStore, 'first' | 'run' | 'updateCapacityWorkdayRun'>,
	teamId: string,
	invocationId: string,
) {
	const invocation = await store.first(`SELECT invocation.status,invocation.execution_id,invocation.assignment_id,
		EXISTS (SELECT 1 FROM audit_events audit WHERE audit.target_type='capacity_provider_assignment'
			AND audit.target_id=invocation.assignment_id AND audit.event_type='assignment.content.integrated') AS integration_ready
		FROM agent_invocation_requests invocation WHERE invocation.id=? AND invocation.team_id=? LIMIT 1`, [invocationId, teamId]);
	if (!invocation || text(invocation.status) !== 'completed' || !text(invocation.execution_id)) return { terminalized: false, reason: 'invocation_not_completed' };
	if (!Boolean(invocation.integration_ready)) return { terminalized: false, reason: 'content_integration_pending' };
	const assignmentExecution = text(invocation.assignment_id) ? await store.first(
		`SELECT workday_run_id FROM capacity_workday_demands WHERE team_id=? AND assignment_id=? ORDER BY updated_at DESC LIMIT 1`,
		[teamId, text(invocation.assignment_id)],
	) : null;
	const executionId = text(assignmentExecution?.workday_run_id) || text(invocation.execution_id);
	const execution = await store.first(`SELECT status,execution_kind FROM capacity_workday_runs WHERE id=? AND team_id=? LIMIT 1`, [executionId, teamId]);
	if (!execution || text(execution.execution_kind) !== 'conversation') throw new CapacityGovernanceError('conversation_execution_provenance_invalid', 'Completed communication invocation does not resolve to its exact conversation execution.', 409, { invocationId, executionId });
	await store.run(`UPDATE agent_invocation_requests SET execution_id=?,blocking_state_json='{}',updated_at=? WHERE id=? AND team_id=?`, [executionId, new Date().toISOString(), invocationId, teamId]);
	if (text(execution.status) === 'completed') return { terminalized: false, reason: 'already_completed', executionId };
	if (text(execution.status) !== 'running') throw new CapacityGovernanceError('conversation_execution_terminal_state_invalid', `Successful communication invocation cannot finish with execution status ${text(execution.status) || 'missing'}.`, 409, { invocationId, executionId });
	const updated = await store.updateCapacityWorkdayRun(teamId, executionId, { status: 'completed', summary: { invocationId, outcome: 'durable_final_response' } });
	if (!updated || text(updated.status) !== 'completed') throw new CapacityGovernanceError('conversation_execution_terminalization_failed', 'Conversation execution did not reach completed after its durable final response.', 409, { invocationId, executionId });
	return { terminalized: true, executionId };
}

export interface DiscussionInvocationInput {
	teamId: string;
	projectId: string;
	projectSlug: string;
	discussionId: string;
	messageId: string;
	messagePath: string;
	messageCommit: string;
	contextRefs: unknown[];
	agentSlugs: string[];
	idempotencyKey: string;
	parentWorkdayId?: string | null;
	parentAssignmentId?: string | null;
	continuationOfAssignmentId?: string | null;
	handoffRootId?: string | null;
	handoffParentId?: string | null;
	handoffDepth?: number | null;
	triggerKind?: 'discussion' | 'agent-handoff';
	subject?: string | null;
	durationSeconds: number;
	requestedById?: string | null;
	communication?: Row;
	addressRequirements?: Record<string, 'required' | 'optional'>;
}

function record(value: unknown): Row {
	if (value && typeof value === 'object' && !Array.isArray(value)) return value as Row;
	if (typeof value === 'string') try { return record(JSON.parse(value)); } catch { return {}; }
	return {};
}
function text(value: unknown): string { return typeof value === 'string' ? value.trim() : ''; }
function list(value:unknown):string[]{if(Array.isArray(value))return value.map(String);if(typeof value==='string')try{return list(JSON.parse(value));}catch{return [];}return [];}
function records(value: unknown): Row[] { if (Array.isArray(value)) return value.map(record); if (typeof value === 'string') try { return records(JSON.parse(value)); } catch { return []; } return []; }
function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function stableId(scope: string, value: string): string { return createHash('sha256').update(`${scope}:${value}`).digest('hex').slice(0, 32); }

const TERMINAL_ASSIGNMENT_STATUSES = ['completed', 'failed', 'cancelled', 'returned', 'expired'];

async function appendInvocationFailureEvent(store: DiscussionInvocationStore, invocation: Row, assignmentId: string | null, blockingState: Row, now: string) {
	const metadata = record(invocation.metadata_json), communication = record(metadata.communication);
	const topicId = text(communication.topicId), sendId = text(communication.sendId);
	if (!topicId) return;
	const project = await store.first('SELECT slug FROM projects WHERE id=? LIMIT 1', [invocation.project_id]);
	const actorHandle = `@${text(project?.slug, text(invocation.project_id))}/${text(invocation.agent_id, 'agent')}`;
	const eventId = `topic-event-${stableId(topicId, `${assignmentId ?? text(invocation.execution_id)}:terminal-invocation-failure`)}`;
	await store.run(`INSERT INTO communication_topic_events
		(id,topic_id,team_id,event_type,occurred_at,send_id,invocation_id,assignment_id,actor_kind,actor_id,actor_handle,summary,payload_json)
		VALUES (?, ?, ?, 'agent.failed', ?, ?, ?, ?, 'agent', ?, ?, ?, ?::jsonb) ON CONFLICT (id) DO NOTHING`,
	[eventId, topicId, invocation.team_id, now, sendId || null, invocation.id, assignmentId, invocation.agent_id, actorHandle,
		'The agent could not respond because its execution assignment ended.', JSON.stringify(blockingState)]);
}

/** Reconcile provider-terminal assignments before they can serialize later topic messages forever. */
export async function reconcileTerminalConversationInvocations(store: DiscussionInvocationStore, teamId: string) {
	const active = await store.all(`SELECT * FROM agent_invocation_requests
		WHERE team_id=? AND execution_kind='conversation' AND status IN ('admitted','running')
		ORDER BY requested_at LIMIT 100`, [teamId]);
	let reconciled = 0;
	for (const invocation of active) {
		const assignment = await store.first(`SELECT id,status,lifecycle_code,lifecycle_reason FROM capacity_provider_assignments
			WHERE team_id=? AND invocation_id=? ORDER BY updated_at DESC LIMIT 1`, [teamId, invocation.id]);
		if (!assignment) {
			const executionId = text(invocation.execution_id);
			const usefulDemand = executionId ? await store.first(`SELECT id FROM capacity_workday_demands
				WHERE team_id=? AND workday_run_id=? AND status IN ('pending','claimed','admitted') LIMIT 1`, [teamId, executionId]) : null;
			if (usefulDemand) continue;
			const execution = executionId ? await store.first(`SELECT status FROM capacity_workday_runs WHERE id=? AND team_id=? LIMIT 1`, [executionId, teamId]) : null;
			if (!execution || !['completed','failed','cancelled','degraded'].includes(text(execution.status))) continue;
			const now = new Date().toISOString();
			const blockingState = { code: 'terminal_conversation_without_assignment', executionStatus: execution.status, executionId };
			await store.run(`UPDATE agent_invocation_requests SET status='failed',completed_at=COALESCE(completed_at,?),blocking_state_json=?,updated_at=?
				WHERE id=? AND team_id=? AND status IN ('admitted','running')`, [now, JSON.stringify(blockingState), now, invocation.id, teamId]);
			await appendInvocationFailureEvent(store, invocation, null, blockingState, now);
			reconciled += 1;
			continue;
		}
		if (!TERMINAL_ASSIGNMENT_STATUSES.includes(text(assignment.status))) continue;
		const integrated = text(assignment.status) === 'completed' && text(invocation.final_message_ref)
			? await store.first("SELECT id FROM audit_events WHERE target_type='capacity_provider_assignment' AND target_id=? AND event_type='assignment.content.integrated' LIMIT 1", [assignment.id])
			: null;
		const successful = text(assignment.status) === 'completed' && Boolean(text(invocation.final_message_ref)) && Boolean(integrated);
		const now = new Date().toISOString();
		const blockingState = successful
			? { code: 'durable_final_response', assignmentStatus: assignment.status }
			: { code: 'terminal_assignment_without_final_response', assignmentStatus: assignment.status,
				lifecycleCode: assignment.lifecycle_code ?? null, lifecycleReason: assignment.lifecycle_reason ?? null };
		await store.run(`UPDATE agent_invocation_requests SET status=?,assignment_id=?,completed_at=COALESCE(completed_at,?),blocking_state_json=?,updated_at=?
			WHERE id=? AND team_id=? AND status IN ('admitted','running')`,
		[successful ? 'completed' : 'failed', assignment.id, now, JSON.stringify(blockingState), now, invocation.id, teamId]);
		if (!successful) await appendInvocationFailureEvent(store, invocation, text(assignment.id), blockingState, now);
		reconciled += 1;
	}
	return { reconciled };
}

export async function resolveDiscussionInvocationAgents(store:Pick<DiscussionInvocationStore,'first'>,input:{
	teamId:string;projectId:string;discussionId:string;parentAssignmentId?:string|null;mentionedAgents:string[];
}) {
	if(input.mentionedAgents.length||!input.parentAssignmentId)return input.mentionedAgents;
	const assignment=await store.first(`SELECT agent_id,status,lease_state,execution_kind,lifecycle_code,metadata_json
		FROM capacity_provider_assignments WHERE id=? AND team_id=? AND project_id=? LIMIT 1`,[input.parentAssignmentId,input.teamId,input.projectId]);
	const metadata=record(assignment?.metadata_json);
	const valid=assignment&&text(assignment.status)==='returned'&&text(assignment.lease_state)==='released'
		&&text(assignment.execution_kind)==='conversation'&&text(assignment.lifecycle_code)==='discussion_response_required'
		&&text(metadata.operationalState)==='suspended'&&text(metadata.waitingDiscussionId)===input.discussionId;
	if(!valid||!text(assignment?.agent_id))throw new CapacityGovernanceError('discussion_continuation_parent_invalid','A mention-free continuation requires the exact suspended assignment waiting on this Discussion.',409,{parentAssignmentId:input.parentAssignmentId,discussionId:input.discussionId});
	return [text(assignment.agent_id)];
}

function frozenTopologyContainsAgent(parameters: Row, projectId: string, agentSlug: string): boolean {
	const topology = record(record(parameters.atlasTopologyByProjectId)[projectId]);
	const nodes = Array.isArray(topology.nodes) ? topology.nodes.map(record) : [];
	return nodes.some((node) => node.kind === 'agent' && [node.id, node.slug, node.agentId].some((value) => text(value) === agentSlug));
}

async function assertExactParent(store: DiscussionInvocationStore, input: DiscussionInvocationInput) {
	if (!input.parentWorkdayId && !input.parentAssignmentId) return null;
	let workdayId = text(input.parentWorkdayId);
	if (input.parentAssignmentId) {
		const assignment = await store.first(
			`SELECT id, work_day_id, team_id, project_id, status, lease_state, execution_kind, lifecycle_code, metadata_json
			 FROM capacity_provider_assignments WHERE id = ? LIMIT 1`,
			[input.parentAssignmentId],
		);
		if (!assignment || assignment.team_id !== input.teamId || assignment.project_id !== input.projectId) {
			throw new CapacityGovernanceError('discussion_parent_assignment_invalid', 'Discussion invocation requires an exact assignment in the selected team and project.', 409);
		}
		const metadata = record(assignment.metadata_json);
		const suspendedConversation = text(assignment.status) === 'returned'
			&& text(assignment.lease_state) === 'released'
			&& text(assignment.execution_kind) === 'conversation'
			&& text(assignment.lifecycle_code) === 'discussion_response_required'
			&& text(metadata.operationalState) === 'suspended';
		if (suspendedConversation && !input.parentWorkdayId) return null;
		const demand = await store.first(
			`SELECT workday_run_id FROM capacity_workday_demands
			 WHERE team_id = ? AND project_id = ? AND assignment_id = ? AND workday_id = ?
			 ORDER BY updated_at DESC LIMIT 1`,
			[input.teamId, input.projectId, input.parentAssignmentId, assignment.work_day_id],
		);
		const assignmentRunId = text(demand?.workday_run_id) || text(metadata.workdayRunId);
		if (!assignmentRunId) throw new CapacityGovernanceError(
			'discussion_parent_workday_provenance_missing',
			'Discussion parent assignment is not linked to an exact API-owned workday run.',
			409,
			{ parentAssignmentId: input.parentAssignmentId, workdayId: assignment.work_day_id },
		);
		if (workdayId && workdayId !== assignmentRunId) throw new CapacityGovernanceError('discussion_parent_mismatch', 'Discussion parent workday and assignment do not match.', 409);
		workdayId = assignmentRunId;
	}
	if (!workdayId) throw new CapacityGovernanceError('discussion_parent_workday_required', 'A parent assignment must belong to an exact workday.', 409);
	const run = await store.first(`SELECT * FROM capacity_workday_runs WHERE id = ? AND team_id = ? AND status = 'running' LIMIT 1`, [workdayId, input.teamId]);
	if (!run || text(run.execution_kind) !== 'workday') throw new CapacityGovernanceError('discussion_parent_workday_invalid', 'Discussion parent must be an active workday execution.', 409);
	return { id: workdayId, parameters: record(run.parameters_json) };
}

async function communicationSupply(store: DiscussionInvocationStore, teamId: string, now = new Date().toISOString()) {
	const candidates = await store.all(
		`SELECT membership.id AS membership_id, membership.capacity_provider_id, execution.id AS execution_provider_id
		 FROM capacity_provider_team_memberships membership
		 JOIN capacity_execution_providers execution ON execution.capacity_provider_id = membership.capacity_provider_id
		 JOIN capacity_provider_lanes communication ON communication.capacity_provider_id = membership.capacity_provider_id
		   AND communication.execution_provider_id = execution.id AND communication.status = 'active' AND communication.purpose = 'communication'
		 WHERE membership.team_id = ? AND membership.status = 'approved' AND execution.status = 'active'
		 ORDER BY membership.approved_at ASC, execution.id ASC`,
		[teamId],
	);
	for (const candidate of candidates) {
		const session = await store.first(
			`SELECT execution_providers_json,metadata_json FROM capacity_provider_availability_sessions
			 WHERE membership_id = ? AND team_id = ? AND capacity_provider_id = ? AND status = 'open'
			   AND expires_at > ? AND (available_from IS NULL OR available_from <= ?)
			   AND (available_until IS NULL OR available_until > ?)
			 ORDER BY sequence DESC LIMIT 1`,
			[candidate.membership_id, teamId, candidate.capacity_provider_id, now, now, now],
		);
		const providers = records(session?.execution_providers_json);
		const provider = providers.find((value) => text(value.id) === text(candidate.execution_provider_id) && text(value.status) === 'active');
		if (!provider) continue;
		const lanes = Array.isArray(provider.lanes) ? provider.lanes.map(record) : [];
		const communicationLane = lanes.find((lane) => lane.purpose === 'communication');
		if (!communicationLane) continue;
		const durations = [provider.minimumAssignmentDuration, communicationLane.minimumAssignmentDuration]
			.filter((value): value is Parameters<typeof evaluateMinimumAssignmentDuration>[0] => Boolean(value));
		const minimumSeconds = Math.max(0, ...durations.map((duration) => evaluateMinimumAssignmentDuration(duration, now).minimumWindowSeconds));
		return { ...candidate, minimumSeconds, providerSourceClosureDigest: text(record(session?.metadata_json).sourceClosureDigest) || null };
	}
	return null;
}

async function persistInvocation(store: DiscussionInvocationStore, input: DiscussionInvocationInput, agentSlug: string, parent: Awaited<ReturnType<typeof assertExactParent>>) {
	const now = new Date().toISOString();
	const id = `invocation-${stableId(input.teamId, `${input.idempotencyKey}:${agentSlug}`)}`;
	const requestDigest = digest({
		projectId: input.projectId, discussionId: input.discussionId, messageId: input.messageId,
		messagePath: input.messagePath, messageCommit: input.messageCommit, contextRefs: input.contextRefs,
		agentSlug, triggerKind: input.triggerKind ?? 'discussion', subject: text(input.subject) || null,
		parentWorkdayId: parent?.id ?? null, parentAssignmentId: input.parentAssignmentId ?? null,
		handoffRootId: input.handoffRootId ?? null, handoffParentId: input.handoffParentId ?? null, handoffDepth: input.handoffDepth ?? null,
	});
	const agentClasses = await store.all(`SELECT id, handler_refs_json, metadata_json FROM project_agent_classes WHERE project_id = ? AND status = 'active' ORDER BY updated_at DESC`, [input.projectId]);
	let selectedAgent: Row | null = null;
	const agentClass = agentClasses.find((candidate) => {
		const agents = record(candidate.handler_refs_json).agents;
		selectedAgent = Array.isArray(agents) ? agents.map(record).find((agent) => {
			const chat = record(record(agent.activities).chat);
			return text(agent.slug ?? agent.agentId) === agentSlug && Object.keys(chat).length > 0 && chat.enabled !== false;
		}) ?? null : null;
		return Boolean(selectedAgent);
	});
	if (!agentClass) throw new CapacityGovernanceError('discussion_agent_chat_profile_missing', `Agent ${agentSlug} has no enabled Chat profile in the selected project.`, 409, { agentSlug });
	const profileExecution = record(record(record(selectedAgent).activities).chat).execution;
	const configuredSeconds = Number(record(profileExecution).maxRuntimeSeconds);
	const productiveSeconds = Number.isInteger(configuredSeconds) && configuredSeconds > 0 ? configuredSeconds : 900;
	const existing = await store.first(`SELECT * FROM agent_invocation_requests WHERE team_id = ? AND idempotency_key = ? LIMIT 1`, [input.teamId, `${input.idempotencyKey}:${agentSlug}`]);
	if (existing) {
		if (text(existing.request_digest) !== requestDigest) throw new CapacityGovernanceError('discussion_invocation_idempotency_conflict', 'Discussion invocation idempotency key is bound to different input.', 409, { invocationId: existing.id });
		let executionId = text(existing.execution_id) || null;
		let status = text(existing.status);
		if (executionId && ['admitted', 'running'].includes(status)) {
			const execution = await store.first(`SELECT status FROM capacity_workday_runs WHERE id = ? AND team_id = ? LIMIT 1`, [executionId, input.teamId]);
			const useful = await store.first(`SELECT id FROM capacity_provider_assignments WHERE invocation_id = ? AND team_id = ? AND status IN ('pending','leased') LIMIT 1`, [existing.id, input.teamId])
				?? await store.first(`SELECT id FROM capacity_workday_demands WHERE workday_run_id = ? AND status IN ('queued','claimed','admitted') LIMIT 1`, [executionId]);
			const updatedAt = Date.parse(text(existing.updated_at));
			const admissionIsFresh = Number.isFinite(updatedAt) && Date.now() - updatedAt < 60_000;
			if ((!execution && !admissionIsFresh) || ['failed', 'cancelled'].includes(text(execution?.status)) || (!useful && !admissionIsFresh)) {
				await store.run(`UPDATE agent_invocation_requests SET status='blocked',execution_id=NULL,blocking_state_json=? WHERE id=?`, [JSON.stringify({ code: 'conversation_execution_terminal_before_response', executionId }), existing.id]);
				executionId = null; status = 'blocked';
			}
		}
		if (status === 'completed') await terminalizeCompletedConversationInvocation(store, input.teamId, text(existing.id));
		return { id: text(existing.id), status, executionId, productiveSeconds, replayed: true };
	}
	const definitionRevision = text(record(agentClass.metadata_json).immutableRef);
	const chatProfileRevision = digest(record(record(selectedAgent).activities).chat);
	// A topic is durable conversation history, not one indefinitely reused execution
	// chain. Each posted message starts an independent root unless the caller supplies
	// explicit handoff/continuation provenance.
	const subjectDigest = digest({ discussionId: input.discussionId, messageId: input.messageId,
		sendId: text(input.communication?.sendId) || null, agentSlug, subject: text(input.subject) || null });
	const pending=await store.first(`SELECT id,content_refs_json FROM agent_invocation_requests WHERE team_id=? AND project_id=? AND agent_id=? AND subject_digest=? AND status IN ('queued','blocked') ORDER BY requested_at LIMIT 1`,[input.teamId,input.projectId,agentSlug,subjectDigest]);
	const prior = input.continuationOfAssignmentId ? await store.first(`SELECT id,assignment_id,handoff_root_id,handoff_depth FROM agent_invocation_requests WHERE team_id = ? AND project_id = ? AND agent_id = ? AND assignment_id = ? AND status = 'suspended' ORDER BY completed_at DESC,requested_at DESC LIMIT 1`, [input.teamId,input.projectId,agentSlug,input.continuationOfAssignmentId]) : null;
	const continuationParentAssignmentId = text(prior?.assignment_id) || input.continuationOfAssignmentId || input.parentAssignmentId || null;
	const handoffParentId = text(input.handoffParentId) || text(prior?.id) || null;
	const handoffRootId = text(input.handoffRootId) || text(prior?.handoff_root_id) || handoffParentId;
	const handoffDepth = Number.isInteger(input.handoffDepth) && Number(input.handoffDepth) >= 0
		? Number(input.handoffDepth) : handoffParentId ? Number(prior?.handoff_depth ?? 0) + 1 : 0;
	const inserted = await store.run(
		`INSERT INTO agent_invocation_requests (
		 id,team_id,project_id,project_agent_class_id,agent_id,agent_revision,mode,execution_kind,trigger_kind,status,scope_hash,prompt,
		 content_refs_json,parent_workday_id,parent_assignment_id,handoff_root_id,handoff_parent_id,handoff_depth,recipients_json,blocking_state_json,subject_digest,
		 priority_class,available_at,idempotency_key,request_digest,response_json,metadata_json,requested_at
		) VALUES (?,?,?,?,?,?,'planning','conversation',?,'queued',?,?,?, ?,?,?,?,?,?,'{}',?,?, ?,?,?,?,?,?)
		ON CONFLICT (id) DO NOTHING`,
		[id, input.teamId, input.projectId, agentClass.id, agentSlug, definitionRevision || input.messageCommit, input.triggerKind ?? 'discussion', requestDigest, null,
			JSON.stringify([input.messagePath, ...input.contextRefs]), parent?.id ?? null, continuationParentAssignmentId,
			handoffRootId,handoffParentId,handoffDepth,JSON.stringify([agentSlug]), subjectDigest,
			input.triggerKind === 'agent-handoff' ? 'agent-asynchronous' : 'human-interactive', now,
			`${input.idempotencyKey}:${agentSlug}`, requestDigest, '{}', JSON.stringify({ discussionId: input.discussionId, sourceMessageId: input.messageId, sourceCommit: input.messageCommit, definitionRevision, productiveSeconds,
				revisions: { project: input.messageCommit, library: definitionRevision || input.messageCommit, agentDefinition: definitionRevision || input.messageCommit, chatProfile: chatProfileRevision },
				...(input.communication ? { communication: { ...input.communication, requirement: input.addressRequirements?.[agentSlug] ?? 'required' } } : {}) }), now],
	);
	if (Number(record(record(inserted).meta).changes) === 0) {
		const replay = await store.first(`SELECT * FROM agent_invocation_requests WHERE id=? AND team_id=? LIMIT 1`, [id,input.teamId]);
		if (!replay || text(replay.request_digest) !== requestDigest) throw new CapacityGovernanceError('discussion_invocation_idempotency_conflict', 'Discussion invocation identity is bound to different input.', 409, { invocationId:id });
		if (text(replay.status) === 'completed') await terminalizeCompletedConversationInvocation(store,input.teamId,id);
		return { id,status:text(replay.status),executionId:text(replay.execution_id)||null,productiveSeconds,replayed:true };
	}
	if(pending){
		const combined=[...new Set([...list(pending.content_refs_json),input.messagePath,...input.contextRefs.map(String)])];
		await store.run(`UPDATE agent_invocation_requests SET content_refs_json=?,updated_at=? WHERE id=? AND status IN ('queued','blocked')`,[JSON.stringify(combined),now,pending.id]);
		await store.run(`UPDATE agent_invocation_requests SET status='coalesced',blocking_state_json=?,completed_at=? WHERE id=? AND status='queued'`,[JSON.stringify({code:'coalesced_before_admission',invocationId:pending.id}),now,id]);
		return {id,status:'coalesced',executionId:null,replayed:false,coalesced:true,coalescedIntoId:text(pending.id)};
	}
	return { id, status: 'queued', executionId: null, productiveSeconds, replayed: false, parentAssignmentId: continuationParentAssignmentId, handoffRootId, handoffParentId, handoffDepth };
}

async function nextConversationRunId(store: DiscussionInvocationStore, teamId: string, invocationId: string) {
	const base = `conversation-${invocationId}`;
	const rows = await store.all(`SELECT id,status FROM capacity_workday_runs WHERE team_id = ? AND (id = ? OR id LIKE ?) ORDER BY created_at`, [teamId, base, `${base}-retry-%`]);
	for (const row of rows) {
		if (!['pending', 'running'].includes(text(row.status))) continue;
		const useful = await store.first(`SELECT id FROM capacity_provider_assignments WHERE invocation_id=? AND work_day_id LIKE ? AND status IN ('pending','leased') LIMIT 1`, [invocationId, `workday-${text(row.id)}-%`])
			?? await store.first(`SELECT id FROM capacity_workday_demands WHERE workday_run_id=? AND status IN ('queued','claimed','admitted') LIMIT 1`, [row.id]);
		if (useful) return { id: text(row.id), existing: true };
	}
	return { id: rows.length ? `${base}-retry-${rows.length}` : base, existing: false };
}

export async function admitDiscussionInvocations(store: DiscussionInvocationStore, input: DiscussionInvocationInput) {
	await reconcileTerminalConversationInvocations(store, input.teamId);
	const parent = await assertExactParent(store, input);
	const supply = await communicationSupply(store, input.teamId);
	const results = [];
	for (const agentSlug of input.agentSlugs) {
		if (parent && !frozenTopologyContainsAgent(parent.parameters, input.projectId, agentSlug)) {
			throw new CapacityGovernanceError('discussion_parent_agent_not_frozen', `Agent ${agentSlug} is not in the parent workday's frozen topology.`, 409, { agentSlug, workdayId: parent.id });
		}
		const invocation = await persistInvocation(store, input, agentSlug, parent);
		if (invocation.executionId || invocation.coalesced || !['queued', 'blocked'].includes(invocation.status)) { results.push(invocation); continue; }
		const serial=await store.first(`SELECT id FROM agent_invocation_requests WHERE project_id=? AND agent_id=? AND subject_digest=(SELECT subject_digest FROM agent_invocation_requests WHERE id=?) AND id<>? AND status IN ('admitted','running') LIMIT 1`,[input.projectId,agentSlug,invocation.id,invocation.id]);
		if(serial){await store.run(`UPDATE agent_invocation_requests SET blocking_state_json=? WHERE id=? AND status='queued'`,[JSON.stringify({code:'discussion_agent_serialized',predecessorInvocationId:serial.id}),invocation.id]);results.push({...invocation,status:'queued',blocker:'discussion_agent_serialized'});continue;}
		if (!supply) {
			await store.run(`UPDATE agent_invocation_requests SET status = 'blocked', blocking_state_json = ? WHERE id = ? AND status = 'queued'`, [JSON.stringify({ code: 'communication_supply_unavailable', communicationReady: false }), invocation.id]);
			results.push({ ...invocation, status: 'blocked', blocker: 'communication_supply_unavailable' });
			continue;
		}
		try {
			const runIdentity = parent ? { id: parent.id, existing: true } : await nextConversationRunId(store, input.teamId, invocation.id);
			const effectiveSeconds = Math.max(input.durationSeconds, invocation.productiveSeconds, Number(supply.minimumSeconds ?? 0));
			if (!runIdentity.existing) {
				const claimToken=randomUUID();
				await store.run(`UPDATE agent_invocation_requests SET status='admitted',execution_id=?,blocking_state_json=?,updated_at=? WHERE id=? AND status IN ('queued','blocked') AND (execution_id IS NULL OR execution_id='')`, [runIdentity.id,JSON.stringify({code:'communication_admission_claimed',claimToken}),new Date().toISOString(), invocation.id]);
				const claimed = await store.first(`SELECT status,execution_id,blocking_state_json FROM agent_invocation_requests WHERE id=? LIMIT 1`, [invocation.id]);
				if (text(claimed?.execution_id) !== runIdentity.id||text(record(claimed?.blocking_state_json).claimToken)!==claimToken) { results.push({ ...invocation, status: text(claimed?.status), executionId: text(claimed?.execution_id) || null, replayed: true }); continue; }
			}
			const run = runIdentity.existing ? { id: runIdentity.id } : await store.createCapacityWorkdayRun(input.teamId, {
				id:runIdentity.id,
				capacityProviderId: text(supply.capacity_provider_id), scenarioId: `conversation:${input.discussionId}:${agentSlug}`,
				environment: 'local', executionKind: 'conversation', triggerKind: input.triggerKind ?? 'discussion', hidden: true, status: 'running', startedAt: new Date().toISOString(),
				parameters: { durationSeconds: effectiveSeconds, maxActiveAssignments: 1, planningOnly: true, projectSlugs: [input.projectSlug],
					providerSourceClosureDigest: supply.providerSourceClosureDigest,
					agentSelection: { agentSlugs: [agentSlug], activityTypes: ['chat'], classIds: [], classSlugs: [], mode: 'intersection' },
					timePolicy: { cooperativePlanningPercent: 100, governedExecutionPercent: 0, reservePercent: 0 }, planningSession: { rounds: 1, assignmentTimeboxSeconds: effectiveSeconds },
					discussion: { discussionId: input.discussionId, messageId: input.messageId, messagePath: input.messagePath, commitSha: input.messageCommit, contextRefs: input.contextRefs, invocationId: invocation.id, parentAssignmentId: invocation.parentAssignmentId ?? null, handoffRootId: invocation.handoffRootId ?? null, handoffParentId: invocation.handoffParentId ?? null, handoffDepth: invocation.handoffDepth ?? 0 },
				}, requestedById: input.requestedById ?? null,
			});
			if (!runIdentity.existing) {
				try {
					await store.tickCapacityWorkdayRun(input.teamId, text(run.id), new Date().toISOString(), `discussion-invocation:${invocation.id}:initial`);
				} catch (error) {
					await store.updateCapacityWorkdayRun(input.teamId, text(run.id), {
						status: 'failed', error: { code: 'conversation_initial_tick_failed', message: error instanceof Error ? error.message : String(error) },
					}).catch(() => null);
					throw error;
				}
			}
			await store.run(`UPDATE agent_invocation_requests SET status = 'admitted', execution_id = ?, blocking_state_json='{}', updated_at=? WHERE id = ? AND status IN ('queued','blocked','admitted') AND execution_id=?`, [run.id, new Date().toISOString(), invocation.id, run.id]);
			results.push({ ...invocation, status: 'admitted', executionId: run.id });
		} catch (error) {
			const claimedExecution = await store.first(`SELECT execution_id FROM agent_invocation_requests WHERE id=? AND team_id=? LIMIT 1`, [invocation.id,input.teamId]);
			await store.run(`UPDATE agent_invocation_requests SET status='blocked',execution_id=NULL,blocking_state_json=?,updated_at=? WHERE id=? AND team_id=? AND status IN ('queued','blocked','admitted') AND execution_id=?`, [JSON.stringify({ code: 'communication_admission_blocked', message: error instanceof Error ? error.message : String(error) }),new Date().toISOString(),invocation.id,input.teamId,text(claimedExecution?.execution_id)]);
			results.push({ ...invocation, status: 'blocked', blocker: error instanceof Error ? error.message : String(error) });
		}
	}
	return results;
}

export async function reconcileBlockedDiscussionInvocations(store:DiscussionInvocationStore,teamId:string){
	await reconcileTerminalConversationInvocations(store,teamId);
	const supply=await communicationSupply(store,teamId);if(!supply)return {admitted:0,blocked:true};
	const now=new Date();const staleClaimBefore=new Date(now.getTime()-60_000).toISOString();
	const rows=await store.all(`SELECT invocation.*,project.slug AS project_slug FROM agent_invocation_requests invocation JOIN projects project ON project.id=invocation.project_id WHERE invocation.team_id=? AND invocation.execution_kind='conversation' AND (invocation.status IN ('queued','blocked') OR (invocation.status='admitted' AND invocation.assignment_id IS NULL AND invocation.updated_at<=?)) AND invocation.available_at<=? ORDER BY CASE invocation.priority_class WHEN 'human-interactive' THEN 400 WHEN 'workday-blocking-agent' THEN 300 WHEN 'agent-asynchronous' THEN 200 ELSE 100 END DESC,invocation.available_at,invocation.requested_at LIMIT 20`,[teamId,staleClaimBefore,now.toISOString()]);
	let admitted=0;
	const selectedSubjects=new Set<string>();
	for(const row of rows){
		const metadata=record(row.metadata_json);const refs=list(row.content_refs_json);
		const invocationId=text(row.id);
		if(text(row.status)==='admitted'){
			const blocking=record(row.blocking_state_json);if(text(blocking.code)!=='communication_admission_claimed')continue;
			const executionId=text(row.execution_id);const execution=executionId?await store.first(`SELECT status FROM capacity_workday_runs WHERE id=? AND team_id=? LIMIT 1`,[executionId,teamId]):null;
			const useful=await store.first(`SELECT id FROM capacity_provider_assignments WHERE invocation_id=? AND team_id=? AND status IN ('pending','leased') LIMIT 1`,[invocationId,teamId])
				??(executionId?await store.first(`SELECT id FROM capacity_workday_demands WHERE workday_run_id=? AND status IN ('queued','claimed','admitted') LIMIT 1`,[executionId]):null);
			if(useful){await store.run(`UPDATE agent_invocation_requests SET blocking_state_json='{}',updated_at=? WHERE id=? AND team_id=? AND status='admitted' AND execution_id=?`,[now.toISOString(),invocationId,teamId,executionId]);admitted+=1;continue;}
			if(execution&&text(execution.status)==='running'){
				try{await store.tickCapacityWorkdayRun(teamId,executionId,now.toISOString(),`discussion-invocation:${invocationId}:initial`);await store.run(`UPDATE agent_invocation_requests SET blocking_state_json='{}',updated_at=? WHERE id=? AND team_id=? AND status='admitted' AND execution_id=?`,[now.toISOString(),invocationId,teamId,executionId]);admitted+=1;continue;}
				catch(error){await store.updateCapacityWorkdayRun(teamId,executionId,{status:'failed',error:{code:'conversation_initial_tick_failed',message:error instanceof Error?error.message:String(error)}}).catch(()=>null);}
			}
			await store.run(`UPDATE agent_invocation_requests SET status='blocked',execution_id=NULL,blocking_state_json=?,updated_at=? WHERE id=? AND team_id=? AND status='admitted' AND assignment_id IS NULL AND execution_id=?`,[JSON.stringify({code:'communication_admission_recovered',priorExecutionId:executionId||null}),now.toISOString(),invocationId,teamId,executionId]);
		}
		const serialKey=`${text(row.project_id)}:${text(row.agent_id)}:${text(row.subject_digest)}`;
		const active=selectedSubjects.has(serialKey)||await store.first(`SELECT id FROM agent_invocation_requests WHERE project_id=? AND agent_id=? AND subject_digest=? AND id<>? AND status IN ('admitted','running') LIMIT 1`,[row.project_id,row.agent_id,row.subject_digest,invocationId]);
		if(active){await store.run(`UPDATE agent_invocation_requests SET blocking_state_json=? WHERE id=?`,[JSON.stringify({code:'discussion_agent_serialized'}),invocationId]);continue;}selectedSubjects.add(serialKey);
		try{
			const identity=text(row.parent_workday_id)?{id:text(row.parent_workday_id),existing:true}:await nextConversationRunId(store,teamId,invocationId); const productiveSeconds=Math.max(900,Number(metadata.productiveSeconds??0),Number(supply.minimumSeconds??0));
			if(!identity.existing){
				const claimToken=randomUUID();
				await store.run(`UPDATE agent_invocation_requests SET status='admitted',execution_id=?,blocking_state_json=?,updated_at=? WHERE id=? AND team_id=? AND status IN ('queued','blocked') AND (execution_id IS NULL OR execution_id='')`,[identity.id,JSON.stringify({code:'communication_admission_claimed',claimToken}),new Date().toISOString(),invocationId,teamId]);
				const claimed=await store.first(`SELECT status,execution_id,blocking_state_json FROM agent_invocation_requests WHERE id=? AND team_id=? LIMIT 1`,[invocationId,teamId]);
				if(text(claimed?.execution_id)!==identity.id||text(record(claimed?.blocking_state_json).claimToken)!==claimToken)continue;
			}
			const run=identity.existing?{id:identity.id}:await store.createCapacityWorkdayRun(teamId,{id:identity.id,capacityProviderId:text(supply.capacity_provider_id),scenarioId:`conversation:${text(metadata.discussionId)}:${text(row.agent_id)}`,environment:'local',executionKind:'conversation',triggerKind:text(row.trigger_kind)||'discussion',hidden:true,status:'running',startedAt:new Date().toISOString(),parameters:{durationSeconds:productiveSeconds,maxActiveAssignments:1,planningOnly:true,projectSlugs:[text(row.project_slug)],agentSelection:{agentSlugs:[text(row.agent_id)],activityTypes:['chat'],classIds:[],classSlugs:[],mode:'intersection'},timePolicy:{cooperativePlanningPercent:100,governedExecutionPercent:0,reservePercent:0},planningSession:{rounds:1,assignmentTimeboxSeconds:productiveSeconds},discussion:{discussionId:text(metadata.discussionId),messageId:text(metadata.sourceMessageId),messagePath:refs[0]??null,commitSha:text(metadata.sourceCommit),contextRefs:refs.slice(1),invocationId,parentAssignmentId:row.parent_assignment_id??null,handoffRootId:row.handoff_root_id??null,handoffParentId:row.handoff_parent_id??null,handoffDepth:Number(row.handoff_depth??0)}}});
			if(!identity.existing)await store.tickCapacityWorkdayRun(teamId,text(run.id),new Date().toISOString(),`discussion-invocation:${invocationId}:initial`);
			await store.run(`UPDATE agent_invocation_requests SET status='admitted',execution_id=?,blocking_state_json='{}',updated_at=? WHERE id=? AND team_id=? AND status IN ('queued','blocked','admitted') AND execution_id=?`,[run.id,new Date().toISOString(),invocationId,teamId,run.id]);admitted+=1;
		}catch(error){
			const claimed=await store.first(`SELECT execution_id FROM agent_invocation_requests WHERE id=? AND team_id=? LIMIT 1`,[invocationId,teamId]);
			await store.run(`UPDATE agent_invocation_requests SET status='blocked',execution_id=NULL,blocking_state_json=?,updated_at=? WHERE id=? AND team_id=? AND execution_id=?`,[JSON.stringify({code:'communication_admission_blocked',message:error instanceof Error?error.message:String(error)}),new Date().toISOString(),invocationId,teamId,text(claimed?.execution_id)]);
		}
	}
	return {admitted,blocked:false};
}
