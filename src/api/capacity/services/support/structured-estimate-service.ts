import { randomUUID } from 'node:crypto';
import type { StructuredAgentEstimateRecord, StructuredAgentEstimateStatus } from '@treeseed/sdk/agent-capacity';
import { validateStructuredAgentEstimate } from '@treeseed/sdk/agent-capacity';
import type { CapacityGovernanceDatabase } from '../../database.ts';
import { CapacityGovernanceError } from '../../database.ts';
import { StructuredAgentEstimateRepository } from '../../repositories/support/structured-estimate.ts';
import { buildDecisionPlanningStatusRecord } from './planning-state-service.ts';

type JsonRecord = Record<string, unknown>;
interface StructuredEstimateStore extends CapacityGovernanceDatabase {
	getProject(projectId: string): Promise<{ id: string; teamId: string } | null>;
	scopeHash(value: unknown): string;
}

function record(value: unknown): JsonRecord { return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}; }
function strings(value: unknown): string[] { return Array.isArray(value) ? value.map(String).map((entry) => entry.trim()).filter(Boolean) : []; }
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function text(value: unknown): string { return typeof value === 'string' ? value.trim() : ''; }
function createStatus(value: unknown): StructuredAgentEstimateStatus {
	const selected = value ?? 'submitted';
	if (selected !== 'submitted' && selected !== 'accepted' && selected !== 'rejected') throw new CapacityGovernanceError('structured_agent_estimate_status_invalid', `Cannot create a structured estimate in ${String(selected)} state.`, 400);
	return selected;
}

export class StructuredAgentEstimateService {
	private readonly repository: StructuredAgentEstimateRepository;
	constructor(private readonly store: StructuredEstimateStore) { this.repository = new StructuredAgentEstimateRepository(store); }

	get(id: string) { return this.repository.get(id); }
	listDecision(decisionId: string, status?: StructuredAgentEstimateStatus | null) { return this.repository.listDecision(decisionId, status); }

	async create(decisionId: string, input: JsonRecord) {
		const projectId = text(input.projectId);
		if (!projectId) throw new CapacityGovernanceError('project_id_required', 'projectId is required.', 400);
		const project = await this.store.getProject(projectId);
		if (!project) return null;
		if (!decisionId) throw new CapacityGovernanceError('decision_id_required', 'decisionId is required.', 400);
		const now = new Date().toISOString();
		const status = createStatus(input.status);
		const minimum = Number(input.minCredits ?? 0);
		const expected = Number(input.expectedCredits ?? input.minCredits ?? 0);
		const maximum = Number(input.maxCredits ?? input.expectedCredits ?? input.minCredits ?? 0);
		const estimate: StructuredAgentEstimateRecord = {
			id: text(input.id) || randomUUID(), teamId: project.teamId, projectId: project.id, decisionId,
			proposalId: text(input.proposalId) || null, workUnitId: text(input.workUnitId) || null,
			agentClass: text(input.agentClass ?? input.projectAgentClassSlug ?? input.projectAgentClassId), agentId: text(input.agentId) || null,
			minCredits: minimum, expectedCredits: expected, maxCredits: maximum,
			confidence: (input.confidence ?? 'medium') as StructuredAgentEstimateRecord['confidence'], riskLevel: (input.riskLevel ?? 'medium') as StructuredAgentEstimateRecord['riskLevel'],
			assumptions: strings(input.assumptions), blockers: strings(input.blockers), dependencies: array(input.dependencies) as StructuredAgentEstimateRecord['dependencies'],
			expectedOutputs: array(input.expectedOutputs) as StructuredAgentEstimateRecord['expectedOutputs'], acceptanceCriteria: strings(input.acceptanceCriteria), completionEvidence: strings(input.completionEvidence),
			createdAt: text(input.createdAt) || now, metadata: record(input.metadata), status,
			acceptedAt: status === 'accepted' ? now : null, rejectedAt: status === 'rejected' ? now : null,
		};
		const validation = validateStructuredAgentEstimate(estimate);
		if (!validation.ok) throw new CapacityGovernanceError('invalid_structured_agent_estimate', 'Structured agent estimate is invalid.', 400, { diagnostics: validation.diagnostics });
		const scopeHash = this.store.scopeHash({ projectId: project.id, decisionId, estimateId: estimate.id });
		const planning = buildDecisionPlanningStatusRecord({
			teamId: project.teamId, projectId: project.id, decisionId, humanApprovalState: text(input.humanApprovalState) || 'approved',
			executionReadiness: 'blocked', planningInputsStatus: 'complete', scopeHash, now,
			metadata: { source: 'structured_agent_estimate', latestEstimateId: estimate.id },
		});
		return this.repository.create(estimate, record(input.recordMetadata), planning);
	}

	async transition(id: string, to: 'accepted' | 'rejected', input: JsonRecord) {
		const existing = await this.repository.get(id);
		if (!existing) return null;
		return this.repository.transition(id, ['submitted'], to, {
			...(existing.metadata ?? {}), ...record(input.metadata), reason: text(input.reason) || null,
		}, new Date().toISOString());
	}
}
