import { compact, safeArray, type OperationalArtifact } from '../operations/operational-artifacts.js';
import { type WorkdayProjection } from '../capacity/workdays/workday-projection.js';
import { currentPhase, capacityProjection, repositoryContextFor, riskClassification, compareTimelineAsc, agentActivityProjection, collectArtifacts, assignmentTimelineEvents, governanceEvent, objectiveEvent, artifactTimelineEvent, buildPhases } from './index.js';

export function projectWorkdayProjection(bundle: any): WorkdayProjection {
    const assignmentIds: Set<string> = new Set(bundle.assignmentDetails.map((entry: any) => compact(entry.assignment?.id)).filter(Boolean));
    const approvals = safeArray(bundle.approvals);
    const artifacts = collectArtifacts(bundle, assignmentIds);
    const governance = approvals.map((approval: any) => governanceEvent(approval));
    const timeline = [
        objectiveEvent(bundle.workday),
        ...bundle.assignmentDetails.flatMap((entry: any) => assignmentTimelineEvents(entry)),
        ...governance,
        ...artifacts.map((artifact: OperationalArtifact) => artifactTimelineEvent(artifact)),
    ].sort(compareTimelineAsc);
    const repositoryContext = repositoryContextFor(bundle, artifacts);
    const phases = buildPhases(timeline, artifacts, governance, bundle.workday);
    return {
        workday: {
            ...bundle.workday,
            budget: bundle.workday.budget,
            riskClassification: riskClassification(approvals),
            currentPhase: currentPhase(phases, bundle.workday),
        },
        phases,
        timeline,
        artifacts,
        repositoryContext,
        governance,
        capacity: capacityProjection(bundle),
        knowledgeOutputs: artifacts.filter((artifact) => artifact.type === 'Knowledge Entry' || artifact.type === 'Report' || artifact.type === 'Release Note' || artifact.type === 'Operational Decision' || artifact.type === 'Architecture Update'),
        agentActivity: agentActivityProjection(bundle),
    };
}
