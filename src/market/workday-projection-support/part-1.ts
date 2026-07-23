import { compact, compareDatesAsc, describeState, latestDate, normalizeOperationalArtifact, safeArray, titleFromKind, toneForState, uniqueStrings, type OperationalArtifact, type OperationalTone, } from '../operational-artifacts.js';
import { MAX_CAPACITY_PAGE_LIMIT } from '@treeseed/sdk/capacity-pagination';
import type { OperationalPhase, OperationalPhaseKey, OperationalTimelineEvent, WorkdayProjection } from '../workday-projection.js';
import { phaseState, currentPhase, capacityProjection, repositoryContextFor, normalizeWorkday, artifactBelongsToWorkday, modeRunArtifactRefs, riskClassification, phaseForEvent, phaseForAssignment, categoryForPhase, matchesWorkdayId, workdayRef, objectValue, parseJson, numberValue, numberOrNull, compareTimelineAsc } from './index.js';

export const phaseDefinitions: Array<Pick<OperationalPhase, 'key' | 'label' | 'description'>> = [
    { key: 'research', label: 'Research', description: 'Repository inspection, discovery, and operational context gathering.' },
    { key: 'implementation', label: 'Implementation', description: 'Planned work, patches, configuration, and coordinated execution.' },
    { key: 'verification', label: 'Verification', description: 'Checks, tests, audits, and confidence-building work.' },
    { key: 'governance', label: 'Governance', description: 'Approvals, escalations, decisions, and audit checkpoints.' },
    { key: 'knowledge', label: 'Knowledge', description: 'Reports, release guidance, decisions, and institutional memory.' },
];

export async function boundedProjectionPage(load: () => Promise<any>, collection: string) {
    const result = await load().catch(() => null);
    if (!result || !Array.isArray(result.items) || !result.page)
        return [];
    if (result.page.hasMore) {
        throw Object.assign(new Error(`Workday projection exceeded the ${MAX_CAPACITY_PAGE_LIMIT}-record ${collection} bound; inspect the paginated operator collection directly.`), {
            code: 'workday_projection_collection_bound_exceeded',
            status: 409,
            details: { collection, limit: MAX_CAPACITY_PAGE_LIMIT, nextCursor: result.page.nextCursor ?? null },
        });
    }
    return result.items;
}

export function boundedEvidencePage(result: any, collection: string) {
    if (!result || !Array.isArray(result.items) || !result.page)
        return [];
    if (result.page.hasMore) {
        throw Object.assign(new Error(`Workday projection exceeded the ${MAX_CAPACITY_PAGE_LIMIT}-record ${collection} bound; inspect the paginated operator collection directly.`), {
            code: 'workday_projection_collection_bound_exceeded',
            status: 409,
            details: { collection, limit: MAX_CAPACITY_PAGE_LIMIT, nextCursor: result.page.nextCursor ?? null },
        });
    }
    return result.items;
}

export async function loadProjectWorkdayBundle(store: any, principal: any, project: any, envelope: any) {
    const projectId = compact(project?.id);
    const [summaryReport, projectSummary, agents, approvals, capacitySummary] = await Promise.all([
        store.getWorkdayCapacitySummary(envelope.id, { limit: MAX_CAPACITY_PAGE_LIMIT }),
        store.getProjectSummary(projectId, principal),
        store.getProjectAgentsSummary(projectId, principal),
        store.listApprovalRequestsForProject(projectId, 200),
        store.getProjectCapacitySummary(projectId, compact(envelope.metadata?.environment, 'staging')),
    ]);
    if (!summaryReport?.payload) {
        throw Object.assign(new Error(`Canonical workday summary is unavailable for ${envelope.id}.`), {
            code: 'workday_projection_summary_missing',
            status: 409,
            details: { workdayId: envelope.id, projectId },
        });
    }
    const evidence = summaryReport.payload.evidence ?? {};
    const assignments = boundedEvidencePage(evidence.assignments, 'assignments');
    const modeRuns = boundedEvidencePage(evidence.modeRuns, 'mode runs');
    const reservations = boundedEvidencePage(evidence.reservations, 'reservations');
    const usageActuals = boundedEvidencePage(evidence.usageActuals, 'usage actuals');
    const ledgerEntries = boundedEvidencePage(evidence.ledgerEntries, 'ledger entries');
    const workday = normalizeWorkday(project, envelope, summaryReport.payload);
    const assignmentDetails = assignments.map((assignment: any) => ({
        assignment,
        modeRuns: modeRuns.filter((run: any) => compact(run?.providerAssignmentId ?? run?.provider_assignment_id) === compact(assignment?.id)),
    }));
    return {
        project,
        workday,
        summary: summaryReport.payload,
        runtime: null,
        agents,
        projectSummary,
        assignmentDetails,
        approvals: safeArray(approvals).filter((approval: any) => !workdayRef(approval) || workdayRef(approval) === workday.id),
        capacityOperations: null,
        capacitySummary,
        ledgerEntries,
        reservations,
        usageActuals,
    };
}

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

export function agentActivityProjection(bundle: any): any[] {
    const byAgent = new Map<string, any>();
    for (const entry of safeArray(bundle.assignmentDetails)) {
        const assignment = entry.assignment ?? {};
        const agentId = compact(assignment.agentId ?? assignment.agent_id ?? assignment.projectAgentClassId ?? assignment.project_agent_class_id, 'unassigned');
        const record = byAgent.get(agentId) ?? {
            id: agentId,
            name: titleFromKind(agentId, agentId === 'unassigned' ? 'Unassigned' : agentId),
            assignmentCount: 0,
            completedCount: 0,
            failedCount: 0,
            assignments: [],
            modeRuns: [],
        };
        record.assignmentCount += 1;
        if (String(assignment.status ?? '').toLowerCase() === 'completed')
            record.completedCount += 1;
        if (['failed', 'blocked', 'rejected', 'cancelled'].includes(String(assignment.status ?? '').toLowerCase()))
            record.failedCount += 1;
        record.assignments.push({
            id: compact(assignment.id, 'assignment'),
            type: compact(assignment.mode, 'assignment'),
            state: compact(assignment.status, 'recorded'),
            createdAt: latestDate(assignment.createdAt, assignment.created_at),
            updatedAt: latestDate(assignment.updatedAt, assignment.updated_at, assignment.completedAt, assignment.completed_at),
        });
        record.modeRuns.push(...safeArray(entry.modeRuns).map((run: any) => ({
            id: compact(run.id, `${assignment.id}-mode-run`),
            mode: compact(run.mode, compact(assignment.mode, 'planning')),
            state: compact(run.status, 'recorded'),
            createdAt: latestDate(run.createdAt, run.created_at),
            updatedAt: latestDate(run.completedAt, run.failedAt, run.updatedAt, run.updated_at),
        })));
        byAgent.set(agentId, record);
    }
    return [...byAgent.values()].sort((left, right) => left.name.localeCompare(right.name));
}

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

export function assignmentTimelineEvents(entry: any): OperationalTimelineEvent[] {
    const assignment = entry.assignment;
    const phase = phaseForAssignment(assignment);
    const runs = safeArray(entry.modeRuns);
    if (runs.length === 0) {
        return [{
                id: `assignment-${assignment.id}`,
                title: titleFromKind(assignment?.mode, 'Assignment'),
                description: `Assignment state: ${describeState(assignment?.status, 'recorded')}.`,
                category: categoryForPhase(phase),
                phase,
                state: compact(assignment?.status, 'recorded'),
                tone: toneForState(assignment?.status),
                timestamp: latestDate(assignment?.leaseClaimedAt, assignment?.createdAt, assignment?.updatedAt),
                meta: titleFromKind(assignment?.mode, 'Assignment'),
            }];
    }
    return runs.map((run: any) => ({
        id: `mode-run-${compact(run?.id, `${assignment.id}-run`)}`,
        title: titleFromKind(run?.handlerId ?? run?.handler_id, titleFromKind(run?.mode ?? assignment?.mode, 'Mode run')),
        description: `${titleFromKind(run?.mode ?? assignment?.mode)} execution ${describeState(run?.status, 'recorded')}.`,
        category: categoryForPhase(phaseForEvent(run?.handlerId ?? run?.mode, assignment?.mode)),
        phase: phaseForEvent(run?.handlerId ?? run?.mode, assignment?.mode),
        state: compact(run?.status ?? assignment?.status, 'recorded'),
        tone: toneForState(run?.status ?? assignment?.status),
        timestamp: latestDate(run?.startedAt, run?.completedAt, run?.failedAt, run?.createdAt, assignment?.updatedAt),
        meta: titleFromKind(run?.executionProviderId ?? assignment?.executionProviderId ?? assignment?.mode, 'Execution'),
        artifactRefs: modeRunArtifactRefs(run),
    }));
}

export function governanceEvent(approval: any): OperationalTimelineEvent {
    const id = compact(approval?.id, 'approval');
    return {
        id: `approval-${id}`,
        title: compact(approval?.title, 'Approval requested'),
        description: compact(approval?.summary, titleFromKind(approval?.kind, 'Operational review')),
        category: 'governance',
        phase: 'governance',
        state: compact(approval?.state, 'pending'),
        tone: toneForState(approval?.state ?? approval?.severity),
        timestamp: latestDate(approval?.createdAt, approval?.decidedAt, approval?.updatedAt),
        href: `/app/work/decisions/${encodeURIComponent(id)}`,
        meta: `${describeState(approval?.severity, 'review')} severity`,
        governanceRefs: [id],
    };
}

export function objectiveEvent(workday: any): OperationalTimelineEvent {
    return {
        id: `workday-${workday.id}-objective`,
        title: 'Objective received',
        description: workday.objective,
        category: 'objective',
        phase: 'research',
        state: 'received',
        tone: 'info',
        timestamp: latestDate(workday.startedAt, workday.createdAt, workday.updatedAt),
        meta: workday.environment,
    };
}

export function artifactTimelineEvent(artifact: OperationalArtifact): OperationalTimelineEvent {
    return {
        id: `artifact-${artifact.id}`,
        title: artifact.title,
        description: artifact.description,
        category: 'knowledge',
        phase: 'knowledge',
        state: artifact.state,
        tone: artifact.tone,
        timestamp: artifact.createdAt,
        href: artifact.href,
        meta: artifact.type,
        artifactRefs: [artifact.id],
        repositoryRefs: artifact.repositories,
    };
}

export function buildPhases(timeline: OperationalTimelineEvent[], artifacts: OperationalArtifact[], governance: OperationalTimelineEvent[], workday: any): OperationalPhase[] {
    return phaseDefinitions.map((definition) => {
        const events = timeline.filter((event) => event.phase === definition.key);
        const phaseArtifacts = definition.key === 'knowledge' ? artifacts : [];
        const phaseGovernance = definition.key === 'governance' ? governance : [];
        const state = phaseState(definition.key, events, phaseArtifacts, phaseGovernance, workday);
        return {
            ...definition,
            state,
            tone: toneForState(state),
            eventCount: events.length,
            artifactCount: phaseArtifacts.length,
        };
    });
}
