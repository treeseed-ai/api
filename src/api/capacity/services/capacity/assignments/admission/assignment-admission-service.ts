import type { AgentExecutionMode } from '@treeseed/sdk/agent-capacity';
import type { CapacityGovernanceDatabase } from '../../../../database.ts';
import { CapacityGovernanceError } from '../../../../database.ts';
import type { DurableProviderAssignment } from '../../../../repositories/capacity/assignments/assignment.ts';
import { commitCapacityAdmission } from '../../../support/admission-service.ts';
import { loadCapacityAdmissionState } from '../../../support/admission-state-service.ts';
import { compileAssignmentProjectContext } from '../context/assignment-context-service.ts';
import type { ProviderLeasePrincipal } from '../../../accounts/lease-authority-service.ts';

type JsonRecord = Record<string, unknown>;

export interface SynthesizedProviderAssignmentInput {
	assignmentId: string;
	reservationId?: string | null;
	synthesisKey: string;
	synthesizedFrom?: string | null;
	projectId: string;
	environment?: string | null;
	providerSessionId?: string | null;
	projectAgentClassId: string;
	mode: AgentExecutionMode;
	workDayId: string | null;
	requestedCredits: number;
	executionProviderId?: string | null;
	laneId?: string | null;
	decisionId?: string | null;
	proposalId?: string | null;
	taskId?: string | null;
	agentId?: string | null;
	handlerId?: string | null;
	fallbackOutputId?: string | null;
	requiredCapabilities?: unknown[];
	capacityEnvelope?: JsonRecord;
	decisionInput?: JsonRecord;
	workspaceContext?: JsonRecord;
	allowedOutputs?: JsonRecord;
	explanation?: JsonRecord;
	treedxProxyHandle?: JsonRecord;
	metadata?: JsonRecord;
}

interface SynthesizedAssignmentAdmissionStore extends CapacityGovernanceDatabase {
	getProviderAssignment(teamId: string, assignmentId: string): Promise<DurableProviderAssignment | null>;
	getProject(projectId: string): Promise<JsonRecord | null>;
	getTeam(teamId: string): Promise<JsonRecord | null>;
	listHubRepositories(projectId: string): Promise<JsonRecord[]>;
	getProjectArchitecture(projectId: string): Promise<JsonRecord | null>;
}

function record(value: unknown): JsonRecord {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

export async function admitSynthesizedProviderAssignment(
	store: SynthesizedAssignmentAdmissionStore,
	principal: ProviderLeasePrincipal,
	input: SynthesizedProviderAssignmentInput,
): Promise<DurableProviderAssignment | null> {
	if (!principal.membershipId) {
		throw new CapacityGovernanceError(
			'capacity_membership_required',
			'Approved provider membership is required for assignment admission.',
			403,
		);
	}
	if (!input.workDayId) {
		throw new CapacityGovernanceError(
			'capacity_workday_required',
			'An active governed workday is required for assignment admission.',
			409,
		);
	}
	const admission = await loadCapacityAdmissionState(store, {
		teamId: principal.teamId,
		providerId: principal.capacityProviderId,
		membershipId: principal.membershipId,
		projectId: input.projectId,
		environment: input.environment ?? 'local',
		projectAgentClassId: input.projectAgentClassId,
		mode: input.mode,
		workDayId: input.workDayId,
		requestedCredits: input.requestedCredits,
		executionProviderId: input.executionProviderId ?? null,
		laneId: input.laneId ?? null,
		providerSessionId: input.providerSessionId ?? null,
		decisionId: input.decisionId ?? null,
		requiredCapabilities: (input.requiredCapabilities ?? []).map(String).filter(Boolean),
	});
	const workspaceContext: JsonRecord = {
		...record(input.workspaceContext),
		project: await compileAssignmentProjectContext(store, input.projectId),
	};
	const committed = await commitCapacityAdmission(store, {
		idempotencyKey: input.synthesisKey,
		admission,
		reservationId: input.reservationId,
		assignmentId: input.assignmentId,
		assignment: {
			projectAgentClassId: input.projectAgentClassId,
			providerSessionId: input.providerSessionId ?? null,
			executionProviderId: input.executionProviderId ?? null,
			laneId: input.laneId ?? null,
			workDayId: input.workDayId,
			taskId: input.taskId ?? null,
			agentId: input.agentId ?? null,
			handlerId: input.handlerId ?? null,
			capacityEnvelope: record(input.capacityEnvelope),
			decisionInput: record(input.decisionInput),
			workspaceContext,
			allowedOutputs: record(input.allowedOutputs),
			explanation: record(input.explanation),
			synthesizedFrom: input.synthesizedFrom ?? null,
			synthesisKey: input.synthesisKey,
			decisionId: input.decisionId ?? null,
			proposalId: input.proposalId ?? null,
			fallbackOutputId: input.fallbackOutputId ?? null,
			treedxProxyHandle: record(input.treedxProxyHandle ?? workspaceContext.treedxProxyHandle),
			metadata: {
				...record(input.metadata),
				synthesisKey: input.synthesisKey,
				synthesizedFrom: input.synthesizedFrom ?? null,
				requiredCapabilities: admission.request.requiredCapabilities,
				availableCapabilities: admission.providerCapacity.capabilities ?? [],
			},
		},
	});
	return store.getProviderAssignment(principal.teamId, String(committed.assignment.id));
}
