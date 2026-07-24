import { compact, compareDatesAsc, normalizeOperationalArtifact, safeArray, uniqueStrings, type OperationalArtifact } from '../operational-artifacts.js';
import { workdayRef, objectValue, parseJson } from './index.js';

export function collectArtifacts(bundle: any, assignmentIds: Set<string>): OperationalArtifact[] {
    const workday = bundle.workday;
    const fromAgents = [
        ...safeArray(bundle.agents?.generatedArtifacts),
        ...safeArray(bundle.agents?.knowledgeDrafts).map((entry: any) => entry?.knowledgeDraft ?? entry),
        ...safeArray(bundle.agents?.runtimeReports),
    ]
        .filter((artifact: any) => artifactBelongsToWorkday(artifact, workday.id, assignmentIds))
        .map((artifact: any) => normalizeArtifact(bundle, artifact, 'Operational artifact'));
    const fromModeRuns = bundle.assignmentDetails.flatMap((entry: any) => safeArray(entry.modeRuns).flatMap((run: any) => {
        const body = objectValue(run?.outputs) ?? parseJson(run?.outputsJson, {});
        const generated = safeArray(body?.generatedArtifacts ?? body?.artifacts);
        const outputArtifacts = generated.length > 0 ? generated : body?.artifactKind ? [body] : [];
        return outputArtifacts.map((artifact: any) => normalizeArtifact(bundle, {
            ...artifact,
            assignmentId: artifact?.assignmentId ?? entry.assignment?.id,
            modeRunId: artifact?.modeRunId ?? run?.id,
            workDayId: artifact?.workDayId ?? entry.assignment?.workDayId ?? workday.id,
            outputRef: artifact?.outputRef ?? body?.outputRef ?? null,
            createdAt: run?.completedAt ?? run?.createdAt ?? artifact?.createdAt ?? null,
        }, 'Mode run output'));
    }));
    const byId = new Map<string, OperationalArtifact>();
    for (const artifact of [...fromAgents, ...fromModeRuns]) {
        byId.set(artifact.id, {
            ...(byId.get(artifact.id) ?? {}),
            ...artifact,
            repositories: uniqueStrings([...(byId.get(artifact.id)?.repositories ?? []), ...artifact.repositories]),
        });
    }
    return [...byId.values()].sort((left, right) => compareDatesAsc(left.createdAt, right.createdAt));
}

export function normalizeArtifact(bundle: any, artifact: any, producedBy: string): OperationalArtifact {
    const repositories = safeArray(bundle.projectSummary?.repositories);
    return normalizeOperationalArtifact({
        artifact,
        workdayId: bundle.workday.id,
        projectId: bundle.project?.id,
        projectName: compact(bundle.project?.name, compact(bundle.project?.slug, 'Project')),
        producedBy,
        defaultKind: 'Operational artifact',
        repositories,
    });
}

export function artifactBelongsToWorkday(artifact: any, workdayId: string, assignmentIds: Set<string>) {
    const relatedWorkday = workdayRef(artifact);
    if (relatedWorkday)
        return relatedWorkday === workdayId;
    const assignmentId = compact(artifact?.assignmentId, compact(artifact?.assignment_id, ''));
    if (assignmentId)
        return assignmentIds.has(assignmentId);
    return false;
}

export function modeRunArtifactRefs(run: any) {
    const outputs = objectValue(run?.outputs) ?? parseJson(run?.outputsJson, {});
    return uniqueStrings([
        ...safeArray(outputs?.artifactRefs),
        ...safeArray(outputs?.artifacts).map((artifact: any) => compact(artifact?.id, '')),
        ...safeArray(outputs?.generatedArtifacts).map((artifact: any) => compact(artifact?.id, '')),
    ]);
}
