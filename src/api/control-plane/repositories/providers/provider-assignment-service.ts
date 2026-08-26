import { createHash } from 'node:crypto';
import { CapacityGovernanceError } from '../../../capacity/database.ts';
import { reportCapacityUsage } from '../../../capacity/services/capacity/accounting/usage-report-service.ts';
import { settleCapacityReservationExactlyOnce, type CapacitySettlementRequest } from '../../../capacity/services/capacity/accounting/settlement-service.ts';
import { startAssignmentCloseoutWindow, startAssignmentExecutionWindow } from '../../../capacity/services/capacity/assignments/lifecycle/assignment-execution-window-service.ts';
import { reconcileBlockedDiscussionInvocations } from '../../../capacity/services/capacity/invocations/discussion-invocation-service.ts';
import { admitDiscussionInvocations } from '../../../capacity/services/capacity/invocations/discussion-invocation-service.ts';
import { parseCommunicationAddresses } from '@treeseed/sdk/operator-contracts';
import { modeRunActivityEvent } from '../../../capacity/services/capacity/workdays/content/mode-run-activity-event.ts';
import { redactTranscriptValue } from './transcript-redaction.ts';
import { providerPrincipal, type ProviderPrincipal } from './provider-runtime-service.ts';
import { assignmentActivityType, assignmentRecord as record, assertProviderOwnsAssignment, type ProviderAssignmentStore } from './provider-assignment-support.ts';
import { commitDiscussionMessage } from '../../../discussions/content.ts';
import { suspendAssignmentForDiscussionResponse } from '../../../capacity/services/capacity/assignments/lifecycle/assignment-discussion-suspension-service.ts';

type SessionEvents = { subscribe(teamId: string, listener: (event: { eventType: string; payload: Record<string, unknown> }) => void): Promise<() => void> };

function objectValue(value: unknown): Record<string, unknown> { return record(value); }

export function discussionInvocationProvenance(invocation: Record<string, unknown>) {
	let metadata = record(invocation.metadata_json);
	if (typeof invocation.metadata_json === 'string') try { metadata = record(JSON.parse(invocation.metadata_json)); } catch { metadata = {}; }
	return {
		metadata,
		discussionId: String(metadata.discussionId ?? '').trim(),
		sourceMessageId: String(metadata.sourceMessageId ?? '').trim(),
	};
}

function providerEventInput(assignment: Record<string, unknown>, body: Record<string, unknown>) {
	const id = typeof body.id === 'string' ? body.id.trim() : '';
	const eventType = typeof body.eventType === 'string' ? body.eventType.trim() : '';
	const component = typeof body.component === 'string' ? body.component.trim() : '';
	const message = typeof body.message === 'string' ? body.message.trim() : '';
	const status = typeof body.status === 'string' ? body.status : 'recorded';
	if (!/^[a-z0-9][a-z0-9_.:-]{0,159}$/u.test(id)) throw new CapacityGovernanceError('provider_runtime_event_id_invalid', 'Provider runtime event id is invalid.', 400);
	if (!/^provider\.[a-z0-9_.-]{1,120}$/u.test(eventType)) throw new CapacityGovernanceError('provider_runtime_event_type_invalid', 'Provider runtime event type is invalid.', 400);
	if (!['provider-manager', 'provider-runner', 'lease', 'execution-provider', 'recovery'].includes(component)) throw new CapacityGovernanceError('provider_runtime_event_component_invalid', 'Provider runtime event component is invalid.', 400);
	if (!['recorded', 'active', 'completed', 'warning', 'error', 'failed'].includes(status)) throw new CapacityGovernanceError('provider_runtime_event_status_invalid', 'Provider runtime event status is invalid.', 400);
	if (!message || message.length > 4_000) throw new CapacityGovernanceError('provider_runtime_event_message_invalid', 'Provider runtime event message must contain at most 4,000 characters.', 400);
	const sanitized = redactTranscriptValue({ context: body.context, refs: body.refs, metrics: body.metrics }) as Record<string, unknown>;
	if (JSON.stringify(sanitized).length > 262_144) throw new CapacityGovernanceError('provider_runtime_event_payload_too_large', 'Provider runtime event evidence exceeds 256 KiB.', 413);
	return { id: `provider-runtime:${String(assignment.id)}:${id}`, eventType, status, title: eventType, message,
		assignmentId: assignment.id, projectId: assignment.projectId, workdayId: assignment.workDayId, createdAt: body.createdAt,
		context: { ...record(sanitized.context), component, agentId: assignment.agentId, agentClassId: assignment.projectAgentClassId,
			handlerId: assignment.handlerId, capacityProviderId: assignment.capacityProviderId, runnerId: assignment.runnerId,
			executionProviderId: assignment.executionProviderId, activityType: assignmentActivityType(assignment) },
		refs: record(sanitized.refs), metadata: { severity: status === 'failed' || status === 'error' ? 'error' : status === 'warning' ? 'warning' : 'info', metrics: record(sanitized.metrics), redactionStatus: 'sanitized' } };
}

async function ownedAssignment(store: ProviderAssignmentStore, assignmentId: string, principal: ProviderPrincipal) {
	const assignment = await store.first('SELECT * FROM capacity_provider_assignments WHERE id = ? AND team_id = ? AND membership_id = ? LIMIT 1', [assignmentId, principal.teamId, principal.membershipId]);
	if (!assignment) throw new CapacityGovernanceError('provider_assignment_not_found', 'Provider assignment does not exist for this membership.', 404);
	return assignment;
}

export function createProviderAssignmentService(storeValue: ProviderAssignmentStore, sessionEvents?: SessionEvents, contentStore: any = storeValue) {
	const store = storeValue;
	const principal = (auth: unknown, scopes: string[]) => providerPrincipal(auth, scopes);
	const lifecycle = async (auth: unknown, assignmentId: string, body: Record<string, unknown>, scope: string,
		method: 'renewProviderAssignmentLease' | 'returnProviderAssignment' | 'completeProviderAssignment') => {
		const result = await store[method](principal(auth, [scope]), assignmentId, body);
		if (!result) throw new CapacityGovernanceError('provider_assignment_conflict', 'Assignment lease transition was rejected.', 409);
		return result;
	};
	return {
		async next(auth: unknown, body: Record<string, unknown>, signal?: AbortSignal) {
			const actor = principal(auth, ['provider:assignments:read']);
			await reconcileBlockedDiscussionInvocations(store, actor.teamId);
			const waitMs = Math.max(0, Math.min(30, Number(body.waitSeconds) || 0)) * 1000;
			const deadline = Date.now() + waitMs;
			let wake: (() => void) | null = null; let unsubscribe: (() => void) | null = null;
			let result = await store.leaseNextProviderAssignment(actor, body);
			try {
				if (!result.assignment && waitMs > 0 && sessionEvents) unsubscribe = await sessionEvents.subscribe(actor.teamId, (event) => {
					if (event.eventType !== 'capacity.assignment.available') return;
					const purpose = typeof body.lanePurpose === 'string' ? body.lanePurpose : null;
					if (!purpose || !event.payload.lanePurpose || event.payload.lanePurpose === purpose) wake?.();
				});
				if (!result.assignment && unsubscribe) result = await store.leaseNextProviderAssignment(actor, body);
				while (!result.assignment && Date.now() < deadline && !signal?.aborted) {
					await new Promise<void>((resolve) => { wake = resolve; setTimeout(resolve, Math.min(250, Math.max(1, deadline - Date.now()))); }); wake = null;
					result = await store.leaseNextProviderAssignment(actor, body);
				}
			} finally { unsubscribe?.(); }
			return { assignment: result.assignment, leaseToken: result.leaseToken, leaseSeconds: result.leaseSeconds,
				diagnostics: result.diagnostics ?? null, leaseDiagnostics: result.diagnostics ?? null };
		},
		async show(auth: unknown, assignmentId: string) { const actor = principal(auth, ['provider:assignments:read']); return assertProviderOwnsAssignment(await store.getProviderAssignment(actor.teamId, assignmentId), actor, 'access'); },
		async explain(auth: unknown, assignmentId: string) { return record((await this.show(auth, assignmentId)).explanation); },
		renew: (auth: unknown, assignmentId: string, body: Record<string, unknown>) => lifecycle(auth, assignmentId, body, 'provider:assignments:read', 'renewProviderAssignmentLease'),
		startExecution: (auth: unknown, assignmentId: string, body: Record<string, unknown>) => startAssignmentExecutionWindow(store, principal(auth, ['provider:assignments:write']), assignmentId, body),
		startCloseout: (auth: unknown, assignmentId: string, body: Record<string, unknown>) => startAssignmentCloseoutWindow(store, principal(auth, ['provider:assignments:write']), assignmentId, body),
		preflight: (auth: unknown, assignmentId: string, body: Record<string, unknown>) => store.preflightProviderAssignmentCompletion(principal(auth, ['provider:assignments:write']), assignmentId, body),
		async respondToDiscussion(auth: unknown, assignmentId: string, body: Record<string, unknown>, idempotencyKey = '') {
			const actor = principal(auth, ['provider:assignments:write']);
			if (!idempotencyKey) throw new CapacityGovernanceError('idempotency_key_required', 'Discussion response requires an idempotency key.', 400);
			const assignment = assertProviderOwnsAssignment(await store.getProviderAssignment(actor.teamId, assignmentId), actor, 'respond to the discussion for');
			if (assignment.executionKind !== 'conversation' || !assignment.invocationId) throw new CapacityGovernanceError('provider_discussion_assignment_required', 'Only a conversation assignment can publish a discussion response.', 409);
			const invocation = await store.first('SELECT * FROM agent_invocation_requests WHERE id=? AND team_id=? AND assignment_id=? LIMIT 1', [assignment.invocationId, actor.teamId, assignment.id]);
			if (!invocation) throw new CapacityGovernanceError('communication_invocation_provenance_missing', 'Conversation assignment has no authoritative invocation.', 409);
			if (assignment.status === 'returned' && String(invocation.final_message_ref ?? '').trim()) return {
				schemaVersion: 'treeseed.provider-discussion-response-receipt/v1', assignmentId, invocationId: assignment.invocationId,
				messageRef: String(invocation.final_message_ref), status: String(record(invocation.response_json).outcome) === 'abstained' ? 'abstained' : 'responded', settledAt: String(invocation.completed_at ?? assignment.returnedAt ?? new Date().toISOString()),
			};
			const provenance = discussionInvocationProvenance(invocation); const invocationMetadata = provenance.metadata;
			const { discussionId, sourceMessageId } = provenance; const handle = record(assignment.treedxProxyHandle);
			const authoringRef = String(handle.branchName ?? '').trim();
			const outcome = body.outcome === 'abstained' ? 'abstained' : 'responded';
			const communication = record(invocationMetadata.communication);
			if (outcome === 'abstained' && String(communication.requirement ?? 'required') === 'required') throw new CapacityGovernanceError(
				'communication_required_response_missing', 'A directly addressed agent must respond and cannot abstain.', 409);
			const markdown = outcome === 'abstained'
				? `*${assignment.agentId ?? 'Agent'} abstained from this optional discussion assignment.*`
				: String(body.markdown ?? '').trim();
			const leaseToken = String(body.leaseToken ?? '').trim();
			if (!discussionId || !sourceMessageId || !markdown || !leaseToken || leaseToken !== assignment.leaseToken) throw new CapacityGovernanceError('provider_discussion_response_invalid', 'Discussion, response, and exact lease authority are required.', 409);
			const project = await contentStore.getProjectDetails(assignment.projectId);
			const projectSlug = String(project?.project?.slug ?? assignment.projectId);
			const addresses = outcome === 'responded' ? parseCommunicationAddresses(markdown) : [];
			for (const address of addresses) if (address.projectSlug && ![projectSlug, assignment.projectId].includes(address.projectSlug)) throw new CapacityGovernanceError(
				'communication_target_project_mismatch', `Agent target ${address.address} does not belong to project ${projectSlug}.`, 409);
			const existingChain = await store.all(`SELECT agent_id,trigger_kind FROM agent_invocation_requests WHERE team_id=? AND execution_kind='conversation'
				AND metadata_json::jsonb->'communication'->>'sendId'=?`, [actor.teamId, String(communication.sendId ?? '')]);
			const priorAgents = new Set(existingChain.map((row: Record<string, unknown>) => String(row.agent_id ?? '')));
			const followupRequirements = new Map<string, 'required' | 'optional'>();
			for (const address of addresses) if (!priorAgents.has(address.agentSlug)
				&& (!followupRequirements.has(address.agentSlug) || address.requirement === 'required')) followupRequirements.set(address.agentSlug, address.requirement);
			const followupCount = existingChain.filter((row: Record<string, unknown>) => String(row.trigger_kind ?? '') === 'agent-handoff').length;
			const followupAddresses = [...followupRequirements].slice(0, Math.min(2, Math.max(0, 16 - followupCount)))
				.map(([agentSlug, requirement]) => ({ agentSlug, requirement }));
			if (Number(invocation.handoff_depth ?? 0) >= 3 || followupCount >= 16) followupAddresses.splice(0);
			const messageId = `response-${createHash('sha256').update(`${assignmentId}:${idempotencyKey}`).digest('hex').slice(0, 24)}`;
			const workspaceId = String(handle.workspaceId ?? '').trim();
			const baseCommitSha = String(handle.baseCommitSha ?? handle.baseRef ?? '').trim();
			const baseRef = String(handle.baseRef ?? handle.baseCommitSha ?? '').trim();
			if (!workspaceId || !baseCommitSha || !baseRef) throw new CapacityGovernanceError('provider_discussion_workspace_required',
				'Discussion response requires the exact assignment authoring workspace.', 409);
			const authored = await commitDiscussionMessage({ store: contentStore, projectId: assignment.projectId, teamId: assignment.teamId,
				principal: { id: assignment.agentId ?? 'project-agent', displayName: assignment.agentId ?? 'Project agent', email: `${assignment.agentId ?? 'agent'}@agents.treeseed.local` },
				body: markdown, intent: 'discuss', discussionId, messageId, createDiscussion: false, replyTo: sourceMessageId,
				sourceMessageRefs: assignment.sourceMessageRefs, authorType: 'agent', authorAgentId: assignment.agentId,
				recipients: followupAddresses.map((address) => address.agentSlug),
				assignmentId: assignment.id, authoringRef, authoringWorkspace: { workspaceId, baseCommitSha, baseRef },
			});
			await suspendAssignmentForDiscussionResponse(store, { assignmentId, teamId: assignment.teamId, leaseToken,
				discussionId, messageId: authored.message.id, message: String(body.summary ?? markdown.slice(0, 500)),
				messagePath: authored.message.path, checkpoint: { summary: body.summary ?? null, usage: record(body.usage), commitSha: authored.commitSha },
			});
			await store.run(`UPDATE agent_invocation_requests SET response_json=?,updated_at=? WHERE id=? AND team_id=?`, [JSON.stringify({ outcome }), new Date().toISOString(), invocation.id, actor.teamId]);
			if (followupAddresses.length) {
				await admitDiscussionInvocations(store, { teamId: assignment.teamId, projectId: assignment.projectId,
					projectSlug, discussionId, messageId: authored.message.id, messagePath: authored.message.path, messageCommit: authored.commitSha,
					contextRefs: [], agentSlugs: followupAddresses.map((address) => address.agentSlug), idempotencyKey: `${idempotencyKey}:followup`,
					parentAssignmentId: assignment.id, handoffRootId: String(invocation.handoff_root_id ?? invocation.id), handoffParentId: String(invocation.id),
					handoffDepth: Number(invocation.handoff_depth ?? 0) + 1, triggerKind: 'agent-handoff', durationSeconds: 900, requestedById: String(assignment.agentId ?? ''),
					communication: { ...communication, parentInvocationId: invocation.id }, addressRequirements: Object.fromEntries(followupAddresses.map((address) => [address.agentSlug, address.requirement])) });
			}
			return { schemaVersion: 'treeseed.provider-discussion-response-receipt/v1', assignmentId,
				invocationId: assignment.invocationId, messageRef: authored.message.path, status: outcome, settledAt: new Date().toISOString() };
		},
		returnAssignment: (auth: unknown, assignmentId: string, body: Record<string, unknown>) => lifecycle(auth, assignmentId, body, 'provider:assignments:write', 'returnProviderAssignment'),
		complete: (auth: unknown, assignmentId: string, body: Record<string, unknown>) => lifecycle(auth, assignmentId, body, 'provider:assignments:write', 'completeProviderAssignment'),
		async fail(auth: unknown, assignmentId: string, body: Record<string, unknown>) {
			const scopes = ['provider:assignments:write']; if (body.usageActualId || body.modeRunId || body.usageActual || body.usage) scopes.push('provider:usage:write');
			const result = await store.failProviderAssignment(principal(auth, scopes), assignmentId, body);
			if (!result) throw new CapacityGovernanceError('provider_assignment_conflict', 'Assignment lease transition was rejected.', 409);
			return result;
		},
		async reportUsage(auth: unknown, assignmentId: string, body: Record<string, unknown>, idempotencyKey = '') {
			const actor = principal(auth, ['provider:usage:write']); const assignment = await ownedAssignment(store, assignmentId, actor);
			return reportCapacityUsage(store, { teamId: actor.teamId, membershipId: actor.membershipId, reservationId: String(assignment.reservation_id ?? ''), assignmentId: String(assignment.id), idempotencyKey,
				assignmentAttempt: body.assignmentAttempt == null ? null : Number(body.assignmentAttempt), usageDimension: String(body.usageDimension ?? ''), accountingMode: body.accountingMode === 'incremental' ? 'incremental' : 'informational',
				activeSeconds: Number(body.activeSeconds ?? 0), elapsedSeconds: Number(body.elapsedSeconds ?? 0), providerUnits: body.providerUnits == null ? null : Number(body.providerUnits), usd: body.usd == null ? null : Number(body.usd),
				modeRunId: typeof body.modeRunId === 'string' ? body.modeRunId : null, source: 'provider_usage_report', metadata: objectValue(body.metadata), usageActual: objectValue(body.usageActual) });
		},
		async settle(auth: unknown, assignmentId: string, body: Record<string, unknown>, idempotencyKey = '') {
			const actor = principal(auth, ['provider:usage:write']); const assignment = await ownedAssignment(store, assignmentId, actor);
			return settleCapacityReservationExactlyOnce(store, { settlementKey: idempotencyKey, teamId: actor.teamId, membershipId: actor.membershipId,
				reservationId: String(assignment.reservation_id ?? ''), assignmentId: String(assignment.id), assignmentAttempt: body.assignmentAttempt == null ? null : Number(body.assignmentAttempt),
				usageDimension: typeof body.usageDimension === 'string' ? body.usageDimension : 'aggregate', usageIdempotencyKey: typeof body.usageIdempotencyKey === 'string' ? body.usageIdempotencyKey : null,
				activeSeconds: Number(body.activeSeconds), elapsedSeconds: Number(body.elapsedSeconds), providerUnits: body.providerUnits == null ? null : Number(body.providerUnits), usd: body.usd == null ? null : Number(body.usd),
				modeRunId: typeof body.modeRunId === 'string' ? body.modeRunId : null, source: 'provider_usage_report', metadata: objectValue(body.metadata), usageActual: objectValue(body.usageActual) as CapacitySettlementRequest['usageActual'] });
		},
		async createModeRun(auth: unknown, assignmentId: string, body: Record<string, unknown>) {
			const actor = principal(auth, ['provider:assignments:write', 'provider:usage:write']);
			const assignment = assertProviderOwnsAssignment(await store.getProviderAssignment(actor.teamId, assignmentId), actor, 'update');
			const modeRun = await store.createAgentModeRun({ ...body, teamId: actor.teamId, providerAssignmentId: assignment.id });
			if (!modeRun) throw new CapacityGovernanceError('provider_assignment_not_found', 'Unknown assignment.', 404);
			const runId = record(assignment.metadata).workdayRunId;
			if (typeof runId === 'string' && runId && store.createCapacityWorkdayEvent) await store.createCapacityWorkdayEvent(actor.teamId, runId, modeRunActivityEvent({ assignment, modeRun }));
			return modeRun;
		},
		async createEvent(auth: unknown, assignmentId: string, body: Record<string, unknown>) {
			const actor = principal(auth, ['provider:assignments:write']);
			const assignment = assertProviderOwnsAssignment(await store.getProviderAssignment(actor.teamId, assignmentId), actor, 'report runtime events for');
			const runId = record(assignment.metadata).workdayRunId;
			if (typeof runId !== 'string' || !runId || !store.createCapacityWorkdayEvent) throw new CapacityGovernanceError('provider_runtime_event_workday_required', 'Provider runtime events require a durable workday assignment.', 409);
			return store.createCapacityWorkdayEvent(actor.teamId, runId, providerEventInput(assignment, body));
		},
	};
}

export type ProviderAssignmentService = ReturnType<typeof createProviderAssignmentService>;
