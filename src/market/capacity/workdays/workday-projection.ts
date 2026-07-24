import { compact, compareDatesAsc, describeState, latestDate, normalizeOperationalArtifact, safeArray, titleFromKind, toneForState, uniqueStrings, type OperationalArtifact, type OperationalTone, } from '../../operations/operational-artifacts.js';
import { MAX_CAPACITY_PAGE_LIMIT } from '@treeseed/sdk/capacity-pagination';
import { phaseDefinitions, boundedProjectionPage, boundedEvidencePage, loadProjectWorkdayBundle, projectWorkdayProjection, agentActivityProjection, collectArtifacts, normalizeArtifact, assignmentTimelineEvents, governanceEvent, objectiveEvent, artifactTimelineEvent, buildPhases, phaseState, currentPhase, capacityProjection, repositoryContextFor, normalizeWorkday, artifactBelongsToWorkday, modeRunArtifactRefs, riskClassification, phaseForEvent, phaseForAssignment, categoryForPhase, matchesWorkdayId, workdayRef, objectValue, parseJson, numberValue, numberOrNull, compareTimelineAsc } from "../../workday-projection-support/index.js";
export type { OperationalArtifact, OperationalTone } from '../../operations/operational-artifacts.js';
export type OperationalPhaseKey = 'research' | 'implementation' | 'verification' | 'governance' | 'knowledge';
export interface OperationalTimelineEvent {
    id: string;
    title: string;
    description?: string;
    category: 'objective' | 'research' | 'execution' | 'governance' | 'knowledge' | 'infrastructure';
    phase: OperationalPhaseKey;
    state?: string;
    tone?: OperationalTone;
    timestamp?: string | null;
    href?: string;
    meta?: string;
    artifactRefs?: string[];
    repositoryRefs?: string[];
    governanceRefs?: string[];
}
export interface OperationalPhase {
    key: OperationalPhaseKey;
    label: string;
    description: string;
    state: string;
    tone: OperationalTone;
    eventCount: number;
    artifactCount: number;
}
export interface WorkdayProjection {
    workday: any;
    phases: OperationalPhase[];
    timeline: OperationalTimelineEvent[];
    artifacts: OperationalArtifact[];
    repositoryContext: any[];
    governance: OperationalTimelineEvent[];
    capacity: any;
    knowledgeOutputs: OperationalArtifact[];
    agentActivity: any[];
}
interface BuildWorkdayProjectionInput {
    store: any;
    principal?: any;
    projects?: any[];
    workdayId: string;
}
export async function buildWorkdayProjection(input: BuildWorkdayProjectionInput): Promise<WorkdayProjection | null> {
    const store = input.store;
    const workdayId = compact(input.workdayId);
    if (!store || !workdayId)
        return null;
    const envelope = await store.getWorkdayCapacityEnvelope(workdayId);
    if (!envelope)
        return null;
    const project = safeArray(input.projects).find((candidate) => compact(candidate?.id) === compact(envelope.projectId));
    if (!project)
        return null;
    return projectWorkdayProjection(await loadProjectWorkdayBundle(store, input.principal, project, envelope));
}
