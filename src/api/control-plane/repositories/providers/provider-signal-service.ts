import type { AgentSignalContract, GroupMembershipSnapshot } from '@treeseed/sdk/agent-capacity';
import { resolveEffectiveGroupMembership } from '../../../governance/group-membership.ts';
import { CapacityGovernanceError } from '../../../capacity/database.ts';
import { recordPlanningParticipantRequest, validatePlanningParticipantRequest } from '../../../capacity/services/capacity/workdays/scheduling/planning-participant-request-service.ts';
import { decodeWorkdayPlanningGraphSnapshot } from '../../../capacity/services/capacity/workdays/policy/workday-planning-graph-policy.ts';
import { redactTranscriptValue } from './transcript-redaction.ts';
import { enforceProviderSignalContract, resolveSignalSubjectGroups } from './provider-signal-policy.ts';
import { providerPrincipal } from './provider-runtime-service.ts';
import { assignmentActivityType, assignmentRecord as record, assertProviderOwnsAssignment, type ProviderAssignmentStore } from './provider-assignment-support.ts';

function signalInput(assignment: Record<string, unknown>, body: Record<string, unknown>, contract: AgentSignalContract,
	groupMembershipSnapshot: GroupMembershipSnapshot | null, groupMembershipSource: string) {
	const contractId = typeof body.contractId === 'string' ? body.contractId.trim().replace(/_/gu, '-') : '';
	const subjectKind = typeof body.subjectKind === 'string' ? body.subjectKind.trim() : '';
	const subjectId = typeof body.subjectId === 'string' ? body.subjectId.trim() : '';
	const causationId = typeof body.causationId === 'string' ? body.causationId.trim() : '';
	const correlationId = typeof body.correlationId === 'string' ? body.correlationId.trim() : causationId;
	const declared = Array.isArray(record(assignment.allowedOutputs).publishedSignals) ? record(assignment.allowedOutputs).publishedSignals as unknown[] : [];
	if (!declared.some((entry) => String(entry).replace(/_/gu, '-') === contractId)) throw new CapacityGovernanceError('assignment_signal_not_declared', 'Assignment cannot publish this signal contract.', 403, { contractId });
	if (!/^[a-z0-9][a-z0-9-]{1,119}$/u.test(contractId)) throw new CapacityGovernanceError('assignment_signal_contract_invalid', 'Signal contract ID is invalid.', 400);
	if (!subjectKind || !subjectId || !causationId || !correlationId) throw new CapacityGovernanceError('assignment_signal_identity_required', 'Signal subject, causation, and correlation identities are required.', 400);
	const evidence = record(body.evidence); const mutationReceipt = record(evidence.mutationReceipt);
	const commitSha = typeof evidence.commitSha === 'string' ? evidence.commitSha.trim() : '';
	const evidenceRef = typeof evidence.controlPlaneRef === 'string' ? evidence.controlPlaneRef.trim() : '';
	if (!commitSha && !evidenceRef) throw new CapacityGovernanceError('assignment_signal_evidence_required', 'A signal requires immutable commit evidence or a durable control-plane evidence reference.', 400);
	const changeSummary = typeof body.changeSummary === 'string' ? body.changeSummary.trim() : '';
	if (!changeSummary || changeSummary.length > 4_000) throw new CapacityGovernanceError('assignment_signal_summary_invalid', 'Signal change summary must contain at most 4,000 characters.', 400);
	const sanitized = redactTranscriptValue({ payload: body.payload, evidence, metadata: body.metadata }) as Record<string, unknown>;
	if (JSON.stringify(sanitized).length > 262_144) throw new CapacityGovernanceError('assignment_signal_payload_too_large', 'Signal evidence exceeds 256 KiB.', 413);
	const metadata = record(assignment.metadata); const idempotencyKey = enforceProviderSignalContract(assignment, body, contract);
	return { id: `signal:${String(assignment.id)}:${contractId}:${idempotencyKey}`, contractId, subjectKind, subjectId, causationId, correlationId,
		changeSummary, commitSha: commitSha || null, immutableRef: typeof evidence.immutableRef === 'string' ? evidence.immutableRef : null,
		digest: typeof evidence.digest === 'string' ? evidence.digest : null, changedPaths: Array.isArray(evidence.changedPaths) ? evidence.changedPaths.filter((entry) => typeof entry === 'string') : [],
		evidenceRef: evidenceRef || (typeof mutationReceipt.id === 'string' ? `artifact-mutation-receipt:${mutationReceipt.id}` : null), payload: record(sanitized.payload),
		metadata: { ...record(sanitized.metadata), producerProfile: assignmentActivityType(assignment) ?? null, groupMembershipSnapshot, groupMembershipSource,
			mutationReceipt: Object.keys(mutationReceipt).length ? mutationReceipt : null },
		workdayRunId: typeof metadata.workdayRunId === 'string' ? metadata.workdayRunId : null };
}

export function createProviderSignalService(store: ProviderAssignmentStore) {
	return async (auth: unknown, assignmentId: string, body: Record<string, unknown>) => {
		const principal = providerPrincipal(auth, ['provider:assignments:write']);
		const assignment = assertProviderOwnsAssignment(await store.getProviderAssignment(principal.teamId, assignmentId), principal, 'publish signals for');
		if (!['leased', 'running'].includes(String(assignment.status))) throw new CapacityGovernanceError('assignment_signal_execution_required', 'Signals may only be published while an assignment is executing.', 409);
		const workdayRunId = record(assignment.metadata).workdayRunId;
		const run = typeof workdayRunId === 'string' ? await store.first('SELECT parameters_json FROM capacity_workday_runs WHERE id = ? AND team_id = ?', [workdayRunId, principal.teamId]) : null;
		if (!run) throw new CapacityGovernanceError('assignment_signal_workday_snapshot_required', 'Signal publication requires its frozen workday graph snapshot.', 409);
		let parameters: Record<string, unknown> = {};
		try { parameters = record(JSON.parse(String(run.parameters_json ?? '{}'))); }
		catch { throw new CapacityGovernanceError('assignment_signal_workday_snapshot_invalid', 'The frozen workday parameters are corrupt.', 500); }
		const snapshot = decodeWorkdayPlanningGraphSnapshot(record(parameters.planningGraphByProjectId)[String(assignment.projectId)], String(assignment.projectId));
		const contractId = String(body.contractId ?? '').trim().replace(/_/gu, '-'); const contract = snapshot.signalContracts[contractId];
		if (!contract) throw new CapacityGovernanceError('assignment_signal_contract_not_frozen', 'Signal contract is not part of this workday graph revision.', 403, { contractId });
		const activityType = String(assignmentActivityType(assignment) ?? '').trim();
		const evidence = record(body.evidence); const knownGroupIds = new Set([...Object.keys(snapshot.groups), ...snapshot.agents.flatMap((agent) => agent.groupIds)]);
		const subjectGroups = resolveSignalSubjectGroups(body, knownGroupIds);
		const membership = subjectGroups.directGroupIds.length ? resolveEffectiveGroupMembership({ projectId: String(assignment.projectId), directGroupIds: subjectGroups.directGroupIds, edges: Object.values(snapshot.groupEdges) }) : null;
		const membershipSnapshot: GroupMembershipSnapshot | null = membership ? { ...membership, projectId: String(assignment.projectId), graphRevision: snapshot.revision,
			immutableRef: typeof evidence.immutableRef === 'string' ? evidence.immutableRef : String(evidence.commitSha ?? snapshot.revision),
			digest: typeof evidence.digest === 'string' ? evidence.digest : snapshot.revision, capturedAt: new Date().toISOString() } : null;
		const signal = signalInput(assignment, body, contract, membershipSnapshot, subjectGroups.source);
		let participantRequest: Awaited<ReturnType<typeof validatePlanningParticipantRequest>> | null = null;
		if (contractId === 'proposal-participant-requested') participantRequest = await validatePlanningParticipantRequest({ database: store, assignment, snapshot, payload: record(body.payload) });
		const now = new Date().toISOString();
		await store.run(`INSERT INTO agent_signals
			(id,contract_id,subject_kind,subject_id,team_id,project_id,workday_run_id,assignment_id,agent_id,activity_type,capacity_provider_id,causation_id,correlation_id,origin,commit_sha,immutable_ref,digest,changed_paths_json,change_summary,evidence_ref,payload_json,metadata_json,created_at)
			VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'agent-tool',?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`, [signal.id, signal.contractId, signal.subjectKind, signal.subjectId,
			principal.teamId, assignment.projectId, signal.workdayRunId, assignment.id, assignment.agentId ?? null, activityType || null, principal.capacityProviderId,
			signal.causationId, signal.correlationId, signal.commitSha, signal.immutableRef, signal.digest, JSON.stringify(signal.changedPaths), signal.changeSummary,
			signal.evidenceRef, JSON.stringify(signal.payload), JSON.stringify(signal.metadata), now]);
		if (participantRequest) await recordPlanningParticipantRequest(store, participantRequest, signal.id, now);
		return store.first('SELECT * FROM agent_signals WHERE id = ? AND assignment_id = ?', [signal.id, assignment.id]);
	};
}

export type ProviderSignalService = ReturnType<typeof createProviderSignalService>;
