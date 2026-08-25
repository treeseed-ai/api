import { type AgentCapacityEnvelope,type DecisionExecutionInput,type ProviderAssignment } from '@treeseed/sdk/agent-capacity';
import type { AgentCapacityPlanRecord,AgentCapacityPlanWorkUnit,DecisionExecutionInputRecord,DecisionPlanningStatus,PlanningInputRequest } from '@treeseed/sdk/agent-capacity';
import { normalizeAgentExecutionMode } from './support-primitives.ts';
import { numberOrNull,record,stableStringify } from './support-primitives.ts';

export function computeDecisionScopeHash(scope: unknown): string {
	const text = stableStringify(scope ?? {});
	let hash = 5381;
	for (let index = 0; index < text.length; index += 1) {
		hash = ((hash << 5) + hash) ^ text.charCodeAt(index);
	}
	return `scope_${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export function isDecisionReadyForActing(status?: Pick<DecisionPlanningStatus, 'executionReadiness' | 'planningInputsStatus'> | null): boolean {
	if (!status) return false;
	const readiness = status.executionReadiness;
	const planning = status.planningInputsStatus;
	return (readiness === 'ready' || readiness === 'waived') && (planning === 'complete' || planning === 'waived');
}

export function isPlanningInputOpen(request: Pick<PlanningInputRequest, 'status'>): boolean {
	return request.status === 'requested' || request.status === 'stale';
}

export function isDecisionExecutionInputAccepted(input: Pick<DecisionExecutionInputRecord, 'status'>): boolean {
	return input.status === 'accepted';
}

export function isAgentCapacityPlanAccepted(plan?: Pick<AgentCapacityPlanRecord, 'status'> | null): boolean {
	return Boolean(plan && ['accepted', 'scheduled', 'active'].includes(String(plan.status)));
}

export function isAgentCapacityPlanStaleOrSuperseded(plan: Pick<AgentCapacityPlanRecord, 'status'> & { scopeHash?: string | null }, currentScopeHash?: string | null): boolean {
	if (plan.status === 'superseded') return true;
	return Boolean(currentScopeHash && plan.scopeHash && currentScopeHash !== plan.scopeHash);
}

export function hasAcceptedCapacityPlanProvenance(input: {
	assignment?: Pick<ProviderAssignment, 'metadata' | 'decisionInput' | 'capacityEnvelope' | 'synthesizedFrom'> | null;
	decisionInput?: DecisionExecutionInput | null;
	capacityEnvelope?: AgentCapacityEnvelope | null;
}): boolean {
	const assignmentMetadata = record(input.assignment?.metadata);
	const decisionMetadata = record(input.decisionInput?.metadata ?? record(input.assignment?.decisionInput).metadata);
	const capacityMetadata = record(input.capacityEnvelope?.metadata ?? record(input.assignment?.capacityEnvelope).metadata);
	const status = String(assignmentMetadata.capacityPlanStatus ?? decisionMetadata.capacityPlanStatus ?? capacityMetadata.capacityPlanStatus ?? '');
	const capacityPlanId = assignmentMetadata.capacityPlanId ?? decisionMetadata.capacityPlanId ?? capacityMetadata.capacityPlanId;
	const synthesizedFrom = input.assignment?.synthesizedFrom ?? assignmentMetadata.synthesizedFrom ?? capacityMetadata.synthesizedFrom;
	return Boolean(capacityPlanId && (['accepted', 'scheduled', 'active'].includes(status) || synthesizedFrom === 'capacity_plan'));
}

export function normalizeDecisionExecutionEstimate(input: DecisionExecutionInputRecord | DecisionExecutionInput): {
	expectedSeconds: number;
	highSeconds: number;
	requiredCapabilities: string[];
	dependencies: string[];
	blockers: string[];
	assumptions: string[];
	confidence: number | null;
	environmentNeeds: string[];
	risk: Record<string, unknown>;
} {
	const source = 'input' in input && input.input && 'input' in input.input
		? input.input.input
		: record((input as DecisionExecutionInput).input);
	const metadata = record((input as DecisionExecutionInputRecord).metadata ?? (input as DecisionExecutionInput).metadata);
	const estimate = record(source.estimate ?? metadata.estimate);
	const capabilities = Array.isArray(source.requiredCapabilities)
		? source.requiredCapabilities
		: Array.isArray(metadata.requiredCapabilities)
			? metadata.requiredCapabilities
			: [];
	const dependencies = Array.isArray(source.dependencies) ? source.dependencies : Array.isArray(metadata.dependencies) ? metadata.dependencies : [];
	const blockers = Array.isArray(source.blockers) ? source.blockers : Array.isArray(metadata.blockers) ? metadata.blockers : [];
	const assumptions = Array.isArray(source.assumptions) ? source.assumptions : Array.isArray(metadata.assumptions) ? metadata.assumptions : [];
	const environmentNeeds = Array.isArray(source.environmentNeeds) ? source.environmentNeeds : Array.isArray(metadata.environmentNeeds) ? metadata.environmentNeeds : [];
	const expectedSeconds = numberOrNull(estimate.expectedSeconds ?? source.expectedSeconds ?? metadata.expectedSeconds) ?? 900;
	const highSeconds = Math.max(expectedSeconds, numberOrNull(estimate.highSeconds ?? source.highSeconds ?? metadata.highSeconds) ?? expectedSeconds);
	const confidence = numberOrNull(estimate.confidence ?? source.confidence ?? metadata.confidence);
	return {
		expectedSeconds,
		highSeconds,
		requiredCapabilities: capabilities.map(String).filter(Boolean),
		dependencies: dependencies.map(String).filter(Boolean),
		blockers: blockers.map(String).filter(Boolean),
		assumptions: assumptions.map(String).filter(Boolean),
		confidence,
		environmentNeeds: environmentNeeds.map(String).filter(Boolean),
		risk: record(source.risk ?? metadata.risk),
	};
}

export function buildAgentCapacityPlanDraft(input: {
	id: string;
	teamId: string;
	projectId: string;
	decisionId: string;
	scopeHash: string;
	executionInputs: DecisionExecutionInputRecord[];
	allocationSetId?: string | null;
	workDayId?: string | null;
	status?: DurableAgentCapacityPlanStatus;
	metadata?: Record<string, unknown>;
	now?: string;
}): AgentCapacityPlanRecord {
	const timestamp = input.now ?? new Date().toISOString();
	const accepted = input.executionInputs.filter(isDecisionExecutionInputAccepted);
	const workUnits = accepted.map((entry, index): AgentCapacityPlanWorkUnit => {
		const estimate = normalizeDecisionExecutionEstimate(entry);
		const decisionInput = entry.input;
		const mode = normalizeAgentExecutionMode(entry.mode, 'acting');
		const estimateId = typeof entry.estimateId === 'string' && entry.estimateId.trim()
			? entry.estimateId.trim()
			: typeof decisionInput.estimateId === 'string' && decisionInput.estimateId.trim()
				? decisionInput.estimateId.trim()
			: typeof entry.metadata?.estimateId === 'string' && entry.metadata.estimateId.trim()
					? entry.metadata.estimateId.trim() : null;
		const workGraphNodeId = typeof decisionInput.workGraphNodeId === 'string' && decisionInput.workGraphNodeId.trim()
			? decisionInput.workGraphNodeId.trim()
			: null;
		if (mode === 'acting' && !workGraphNodeId) {
			throw new Error(`Acting decision execution input ${entry.id} requires workGraphNodeId provenance.`);
		}
		if (mode === 'acting' && !estimateId) throw new Error(`Acting decision execution input ${entry.id} requires accepted estimate provenance.`);
		const capacityEnvelope = {
			...decisionInput.capacity,
			teamId: input.teamId,
			projectId: input.projectId,
			workDayId: decisionInput.capacity?.workDayId ?? input.workDayId ?? null,
			allocationSetId: decisionInput.capacity?.allocationSetId ?? input.allocationSetId ?? null,
			mode: normalizeAgentExecutionMode(decisionInput.mode, 'acting'),
			projectAgentClassId: entry.projectAgentClassId,
			metadata: {
				...(decisionInput.capacity?.metadata ?? {}),
				capacityPlanId: input.id,
				decisionExecutionInputId: entry.id,
			},
		};
		return {
			id: `${input.id}:wu:${index + 1}`,
			decisionExecutionInputId: entry.id,
			decisionId: input.decisionId,
			workGraphNodeId,
			estimateId,
			projectAgentClassId: entry.projectAgentClassId,
			mode,
			...(decisionInput.activityType ? { activityType: decisionInput.activityType } : {}),
			taskId: decisionInput.taskId ?? null,
			agentId: decisionInput.agentId ?? null,
			handlerId: decisionInput.handlerId ?? null,
			workDayId: capacityEnvelope.workDayId ?? null,
			expectedSeconds: estimate.expectedSeconds,
			highSeconds: estimate.highSeconds,
			requiredCapabilities: estimate.requiredCapabilities,
			dependencies: estimate.dependencies,
			blockers: estimate.blockers,
			risk: estimate.risk,
			assumptions: estimate.assumptions,
			confidence: estimate.confidence,
			capacityEnvelope,
			decisionInput: {
				...decisionInput,
				estimateId,
				capacity: capacityEnvelope,
				metadata: {
					...(decisionInput.metadata ?? {}),
					capacityPlanId: input.id,
					decisionExecutionInputId: entry.id,
				},
			},
			metadata: entry.metadata ?? {},
		};
	});
	const unique = (values: string[]) => [...new Set(values.filter(Boolean))].sort((left, right) => left.localeCompare(right));
	return {
		id: input.id,
		teamId: input.teamId,
		projectId: input.projectId,
		decisionId: input.decisionId,
		status: input.status ?? 'draft',
		scopeHash: input.scopeHash,
		allocationSetId: input.allocationSetId ?? null,
		workDayId: input.workDayId ?? null,
		expectedSeconds: workUnits.reduce((sum, unit) => sum + unit.expectedSeconds, 0),
		highSeconds: workUnits.reduce((sum, unit) => sum + unit.highSeconds, 0),
		workUnits,
		capabilityNeeds: unique(workUnits.flatMap((unit) => unit.requiredCapabilities)),
		environmentNeeds: unique(accepted.flatMap((entry) => normalizeDecisionExecutionEstimate(entry).environmentNeeds)),
		reserves: { highSeconds: workUnits.reduce((sum, unit) => sum + unit.highSeconds, 0) },
		blockers: unique(workUnits.flatMap((unit) => unit.blockers)),
		priorityRationale: typeof input.metadata?.priorityRationale === 'string' ? input.metadata.priorityRationale : null,
		review: {},
		metadata: input.metadata ?? {},
		acceptedAt: null,
		scheduledAt: null,
		createdAt: timestamp,
		updatedAt: timestamp,
	};
}
