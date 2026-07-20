import type { ResearchClaim, ResearchWorkflowRecord } from '@treeseed/sdk/agent-capacity';
import { validateAgentArtifactManifest } from '@treeseed/sdk/agent-capacity';
import { decodeDurableJsonObject } from '../durable-json.ts';
import { CapacityGovernanceError } from '../database.ts';
import type { DurableProviderAssignment } from '../repositories/assignment.ts';
import { assignmentArtifactManifest } from './assignment-deliverable-service.ts';

type JsonRecord = Record<string, unknown>;
export interface ResearchWorkflowProjectionStore {
	first(query: string, params?: unknown[]): Promise<Record<string, unknown> | null>;
	getResearchWorkflow(id: string): Promise<ResearchWorkflowRecord | null>;
	completeResearchWorkflowStage(id: string, stage: string, input: JsonRecord): Promise<ResearchWorkflowRecord | null>;
}
function record(value: unknown): JsonRecord { return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}; }
function text(...values: unknown[]) { for (const value of values) if (typeof value === 'string' && value.trim()) return value.trim(); return ''; }

function claims(signals: Array<{ code: string; metadata?: JsonRecord }>): ResearchClaim[] | undefined {
	const values = signals.filter((signal) => signal.code === 'research_claim').map((signal) => record(signal.metadata)).map((claim) => ({
		id: text(claim.id), text: text(claim.text), material: claim.material !== false,
		status: claim.status as ResearchClaim['status'], citationIds: Array.isArray(claim.citationIds) ? claim.citationIds.map(String).filter(Boolean) : [],
	}));
	return values.length ? values : undefined;
}

export async function projectCompletedResearchWorkflow(
	store: ResearchWorkflowProjectionStore,
	assignment: DurableProviderAssignment,
	input: JsonRecord,
) {
	if (assignment.mode !== 'planning') return null;
	const demand = await store.first('SELECT id, payload_json FROM capacity_workday_demands WHERE assignment_id = ? AND source_type = ? LIMIT 1', [assignment.id, 'research-workflow']);
	if (!demand) return null;
	const payload = decodeDurableJsonObject(demand.payload_json, { owner: 'research workflow demand', ownerId: String(demand.id ?? ''), column: 'payload_json' });
	const workflowId = text(payload.researchWorkflowId);
	const stage = text(payload.researchStage);
	const expectedStateVersion = Number(payload.researchWorkflowStateVersion);
	if (!workflowId || !stage || !Number.isInteger(expectedStateVersion)) throw new CapacityGovernanceError('research_workflow_demand_corrupt', 'Research demand omits workflow stage provenance.', 500, { assignmentId: assignment.id });
	const workflow = await store.getResearchWorkflow(workflowId);
	if (!workflow) throw new CapacityGovernanceError('research_workflow_missing', 'Research assignment references a missing workflow.', 500, { assignmentId: assignment.id, workflowId });
	const prior = workflow.nodes.find((node) => node.stage === stage);
	if (workflow.stateVersion > expectedStateVersion && prior?.status === 'completed' && prior.assignmentId === assignment.id) return workflow;
	if (workflow.stateVersion !== expectedStateVersion) throw new CapacityGovernanceError('research_workflow_state_conflict', 'Research workflow changed before assignment completion.', 409, { assignmentId: assignment.id, workflowId, expectedStateVersion, actualStateVersion: workflow.stateVersion });
	const manifest = assignmentArtifactManifest(input);
	if (!manifest) throw new CapacityGovernanceError('research_artifact_manifest_required', 'Research stage completion requires the canonical artifact manifest.', 409, { assignmentId: assignment.id, workflowId, stage });
	const validation = validateAgentArtifactManifest(manifest);
	if (!validation.ok || manifest.assignmentId !== assignment.id || manifest.projectId !== assignment.projectId || manifest.teamId !== assignment.teamId || manifest.mode !== 'planning') throw new CapacityGovernanceError('research_artifact_manifest_invalid', validation.reason ?? 'Research artifact manifest scope is invalid.', 409, { assignmentId: assignment.id, workflowId, stage });
	const rejected = manifest.signals.find((signal) => signal.code === 'research_review_rejected');
	const approved = manifest.signals.find((signal) => signal.code === 'research_review_approved');
	const projectedClaims = claims(manifest.signals);
	const artifactRefs = manifest.contentReferences.map((reference) => reference.contentPath);
	const publication = manifest.contentReferences.find((reference) => reference.model === 'knowledge' || reference.artifactKind === 'knowledge_page');
	const report = manifest.contentReferences.find((reference) => reference.artifactKind === 'workday_summary');
	return store.completeResearchWorkflowStage(workflowId, stage, {
		expectedStateVersion, assignmentId: assignment.id, artifactRefs,
		...(manifest.citations.length ? { citations: manifest.citations } : {}),
		...(projectedClaims ? { claims: projectedClaims } : {}),
		...(rejected ? { reviewOutcome: 'rejected', reviewReason: rejected.message ?? text(rejected.metadata?.reason) } : approved ? { reviewOutcome: 'approved' } : {}),
		...(publication ? { publicationRef: publication.contentPath } : {}), ...(report ? { reportRef: report.contentPath } : {}),
		metadata: { modeRunId: manifest.modeRunId, artifactManifestId: `${manifest.assignmentId}:${manifest.modeRunId}` },
	});
}
