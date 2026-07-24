import { randomUUID } from 'node:crypto';
import { advanceResearchWorkflow, compileResearchWorkflow, RESEARCH_WORKFLOW_STAGES, type ResearchStageCompletion } from '@treeseed/sdk/agent-capacity';
import type { CapacityGovernanceDatabase } from '../../database.ts';
import { CapacityGovernanceError } from '../../database.ts';
import { ResearchWorkflowRepository } from '../../repositories/operations/research-workflow.ts';

type JsonRecord = Record<string, unknown>;
interface ResearchWorkflowStore extends CapacityGovernanceDatabase { getProject(projectId: string): Promise<{ id: string; teamId: string } | null> }
function text(value: unknown) { return typeof value === 'string' ? value.trim() : ''; }
function records(value: unknown) { return Array.isArray(value) ? value.filter((item): item is JsonRecord => Boolean(item && typeof item === 'object' && !Array.isArray(item))) : []; }

export class ResearchWorkflowService {
	private readonly repository: ResearchWorkflowRepository;
	constructor(private readonly store: ResearchWorkflowStore) { this.repository = new ResearchWorkflowRepository(store); }
	get(id: string) { return this.repository.get(id); }
	list(projectId: string, status?: string) { return this.repository.list(projectId, status); }
	async create(projectId: string, input: JsonRecord) {
		const project = await this.store.getProject(projectId);
		if (!project) return null;
		const objectiveRef = text(input.objectiveRef);
		const questionRef = text(input.questionRef);
		const idempotencyKey = text(input.idempotencyKey);
		if (!objectiveRef || !questionRef || !idempotencyKey) throw new CapacityGovernanceError('research_workflow_input_required', 'objectiveRef, questionRef, and idempotencyKey are required.', 400);
		const existing = await this.repository.getByIdempotency(projectId, idempotencyKey);
		if (existing) return existing;
		const workflow = compileResearchWorkflow({
			id: text(input.id) || randomUUID(), teamId: project.teamId, projectId, objectiveRef, questionRef,
			minimumIndependentSources: Number(input.minimumIndependentSources ?? 2),
			maxRevisionCycles: Number(input.maxRevisionCycles ?? 3),
			metadata: input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata) ? input.metadata as JsonRecord : undefined,
		});
		return this.repository.create(workflow, idempotencyKey);
	}
	async completeStage(id: string, stage: string, input: JsonRecord) {
		const workflow = await this.repository.get(id);
		if (!workflow) return null;
		if (!RESEARCH_WORKFLOW_STAGES.includes(stage as never)) throw new CapacityGovernanceError('research_workflow_stage_invalid', `Unknown research workflow stage ${stage}.`, 400);
		try {
			const next = advanceResearchWorkflow(workflow, {
				expectedStateVersion: Number(input.expectedStateVersion), stage: stage as ResearchStageCompletion['stage'], assignmentId: text(input.assignmentId),
				artifactRefs: Array.isArray(input.artifactRefs) ? input.artifactRefs.map(String).filter(Boolean) : [],
				...(Array.isArray(input.citations) ? { citations: input.citations as ResearchStageCompletion['citations'] } : {}),
				...(Array.isArray(input.claims) ? { claims: records(input.claims) as unknown as ResearchStageCompletion['claims'] } : {}),
				...(input.reviewOutcome === 'approved' || input.reviewOutcome === 'rejected' ? { reviewOutcome: input.reviewOutcome } : {}),
				...(text(input.reviewReason) ? { reviewReason: text(input.reviewReason) } : {}),
				...(text(input.publicationRef) ? { publicationRef: text(input.publicationRef) } : {}),
				...(text(input.reportRef) ? { reportRef: text(input.reportRef) } : {}),
				metadata: input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata) ? input.metadata as JsonRecord : undefined,
			});
			return this.repository.advance(workflow, next);
		} catch (error) {
			const code = error instanceof Error ? error.message.split(':')[0]! : 'research_workflow_transition_invalid';
			throw new CapacityGovernanceError(code, `Research workflow stage transition was denied: ${code}.`, code === 'research_workflow_state_conflict' ? 409 : 400, { workflowId: id, stage });
		}
	}
}
