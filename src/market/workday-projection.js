import { compact, compareDatesAsc, describeState, latestDate, normalizeOperationalArtifact, safeArray, titleFromKind, toneForState, uniqueStrings, } from './operational-artifacts.js';
const phaseDefinitions = [
    { key: 'research', label: 'Research', description: 'Repository inspection, discovery, and operational context gathering.' },
    { key: 'implementation', label: 'Implementation', description: 'Planned work, patches, configuration, and coordinated execution.' },
    { key: 'verification', label: 'Verification', description: 'Checks, tests, audits, and confidence-building work.' },
    { key: 'governance', label: 'Governance', description: 'Approvals, escalations, decisions, and audit checkpoints.' },
    { key: 'knowledge', label: 'Knowledge', description: 'Reports, release guidance, decisions, and institutional memory.' },
];
export async function buildWorkdayProjection(input) {
    const store = input.store;
    const workdayId = compact(input.workdayId);
    if (!store || !workdayId)
        return null;
    for (const project of safeArray(input.projects)) {
        const bundle = await loadProjectWorkdayBundle(store, input.principal, project, workdayId);
        if (!bundle.workday)
            continue;
        return projectWorkdayProjection(bundle);
    }
    return null;
}
async function loadProjectWorkdayBundle(store, principal, project, workdayId) {
    const projectId = compact(project?.id);
    const [workdaySummaries, runtimeWorkdays, agents] = await Promise.all([
        typeof store.listProjectWorkdaySummaries === 'function' ? store.listProjectWorkdaySummaries(projectId, null).catch(() => []) : [],
        typeof store.listRuntimeWorkDays === 'function' ? store.listRuntimeWorkDays(projectId, { limit: 1000 }).catch(() => []) : [],
        typeof store.getProjectAgentsSummary === 'function' ? store.getProjectAgentsSummary(projectId, principal).catch(() => null) : null,
    ]);
    const summary = safeArray(workdaySummaries).find((entry) => matchesWorkdayId(entry, workdayId)) ?? null;
    const runtime = safeArray(runtimeWorkdays).find((entry) => matchesWorkdayId(entry, workdayId)) ?? null;
    const current = matchesWorkdayId(agents?.currentWorkday, workdayId) ? agents.currentWorkday : null;
    const source = summary ?? runtime ?? current;
    if (!source) {
        return { project, workday: null };
    }
    const workday = normalizeWorkday(project, source, runtime, summary);
    const [projectSummary, tasks, approvals, capacityOperations, capacitySummary, ledgerEntries, routingDecisions] = await Promise.all([
        typeof store.getProjectSummary === 'function' ? store.getProjectSummary(projectId, principal).catch(() => null) : null,
        typeof store.listRuntimeTasks === 'function' ? store.listRuntimeTasks(projectId, { workDayId: workday.id, limit: 1000 }).catch(() => []) : [],
        typeof store.listApprovalRequestsForProject === 'function' ? store.listApprovalRequestsForProject(projectId, 200).catch(() => []) : [],
        typeof store.getProjectCapacityOperations === 'function' ? store.getProjectCapacityOperations(projectId, workday.environment).catch(() => null) : null,
        typeof store.getProjectCapacitySummary === 'function' ? store.getProjectCapacitySummary(projectId, workday.environment).catch(() => null) : null,
        typeof store.listCapacityLedgerEntries === 'function' ? store.listCapacityLedgerEntries(projectId, workday.id).catch(() => []) : [],
        typeof store.listCapacityRoutingDecisionsForProject === 'function' ? store.listCapacityRoutingDecisionsForProject(projectId, 200).catch(() => []) : [],
    ]);
    const taskDetails = await Promise.all(safeArray(tasks).map(async (task) => {
        const [events, outputs] = await Promise.all([
            typeof store.listRuntimeTaskEvents === 'function' ? store.listRuntimeTaskEvents(projectId, task.id).catch(() => []) : [],
            typeof store.listRuntimeTaskOutputs === 'function' ? store.listRuntimeTaskOutputs(projectId, task.id).catch(() => []) : [],
        ]);
        return {
            task,
            events: safeArray(events),
            outputs: safeArray(outputs),
        };
    }));
    return {
        project,
        workday,
        summary,
        runtime,
        agents,
        projectSummary,
        taskDetails,
        approvals: safeArray(approvals).filter((approval) => !workdayRef(approval) || workdayRef(approval) === workday.id),
        capacityOperations,
        capacitySummary: capacityOperations?.summary ?? capacitySummary,
        ledgerEntries: safeArray(capacityOperations?.ledgerEntries ?? ledgerEntries),
        routingDecisions: safeArray(capacityOperations?.routingDecisions ?? routingDecisions).filter((decision) => !workdayRef(decision) || workdayRef(decision) === workday.id),
        reservations: safeArray(capacityOperations?.reservations),
        usageActuals: safeArray(capacityOperations?.usageActuals).filter((actual) => !workdayRef(actual) || workdayRef(actual) === workday.id),
    };
}
function projectWorkdayProjection(bundle) {
    const taskIds = new Set(bundle.taskDetails.map((entry) => compact(entry.task?.id)).filter(Boolean));
    const approvals = safeArray(bundle.approvals);
    const artifacts = collectArtifacts(bundle, taskIds);
    const governance = approvals.map((approval) => governanceEvent(approval));
    const timeline = [
        objectiveEvent(bundle.workday),
        ...bundle.taskDetails.flatMap((entry) => taskTimelineEvents(entry)),
        ...governance,
        ...artifacts.map((artifact) => artifactTimelineEvent(artifact)),
    ].sort(compareTimelineAsc);
    const repositoryContext = repositoryContextFor(bundle, artifacts);
    const phases = buildPhases(timeline, artifacts, governance, bundle.workday);
    return {
        workday: {
            ...bundle.workday,
            budget: {
                capacityBudget: numberValue(bundle.runtime?.capacityBudget, numberValue(bundle.workday?.summary?.capacityBudget, 0)),
                capacityUsed: numberValue(bundle.runtime?.capacityUsed, numberValue(bundle.workday?.summary?.capacityUsed, 0)),
            },
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
function agentActivityProjection(bundle) {
    const byAgent = new Map();
    for (const entry of safeArray(bundle.taskDetails)) {
        const task = entry.task ?? {};
        const agentId = compact(task.agentId ?? task.agent_id, 'unassigned');
        const record = byAgent.get(agentId) ?? {
            id: agentId,
            name: titleFromKind(agentId, agentId === 'unassigned' ? 'Unassigned' : agentId),
            taskCount: 0,
            completedCount: 0,
            failedCount: 0,
            tasks: [],
            events: [],
            outputs: [],
        };
        record.taskCount += 1;
        if (String(task.state ?? '').toLowerCase() === 'completed')
            record.completedCount += 1;
        if (['failed', 'blocked', 'rejected'].includes(String(task.state ?? '').toLowerCase()))
            record.failedCount += 1;
        record.tasks.push({
            id: compact(task.id, 'task'),
            type: compact(task.type, 'task'),
            state: compact(task.state, 'recorded'),
            createdAt: latestDate(task.createdAt, task.created_at),
            updatedAt: latestDate(task.updatedAt, task.updated_at, task.completedAt, task.completed_at),
        });
        record.events.push(...safeArray(entry.events).map((event) => ({
            id: compact(event.id, `${task.id}-event`),
            kind: compact(event.kind, 'event'),
            createdAt: latestDate(event.createdAt, event.created_at),
        })));
        record.outputs.push(...safeArray(entry.outputs).map((output) => ({
            id: compact(output.id ?? output.outputRef ?? output.output_ref, `${task.id}-output`),
            ref: compact(output.outputRef ?? output.output_ref, ''),
            createdAt: latestDate(output.createdAt, output.created_at),
        })));
        byAgent.set(agentId, record);
    }
    return [...byAgent.values()].sort((left, right) => left.name.localeCompare(right.name));
}
function collectArtifacts(bundle, taskIds) {
    const workday = bundle.workday;
    const fromAgents = [
        ...safeArray(bundle.agents?.generatedArtifacts),
        ...safeArray(bundle.agents?.knowledgeDrafts).map((entry) => entry?.knowledgeDraft ?? entry),
        ...safeArray(bundle.agents?.runtimeReports),
    ]
        .filter((artifact) => artifactBelongsToWorkday(artifact, workday.id, taskIds))
        .map((artifact) => normalizeArtifact(bundle, artifact, 'Operational artifact'));
    const fromOutputs = bundle.taskDetails.flatMap((entry) => safeArray(entry.outputs).flatMap((output) => {
        const body = outputBody(output);
        const generated = safeArray(body?.generatedArtifacts);
        const outputArtifacts = generated.length > 0 ? generated : body?.artifactKind ? [body] : [];
        return outputArtifacts.map((artifact) => normalizeArtifact(bundle, {
            ...artifact,
            taskId: artifact?.taskId ?? entry.task?.id,
            workDayId: artifact?.workDayId ?? entry.task?.workDayId ?? workday.id,
            outputRef: output?.outputRef ?? artifact?.outputRef ?? body?.outputRef ?? null,
            createdAt: output?.createdAt ?? artifact?.createdAt ?? null,
        }, 'Task output'));
    }));
    const byId = new Map();
    for (const artifact of [...fromAgents, ...fromOutputs]) {
        byId.set(artifact.id, {
            ...(byId.get(artifact.id) ?? {}),
            ...artifact,
            repositories: uniqueStrings([...(byId.get(artifact.id)?.repositories ?? []), ...artifact.repositories]),
        });
    }
    return [...byId.values()].sort((left, right) => compareDatesAsc(left.createdAt, right.createdAt));
}
function normalizeArtifact(bundle, artifact, producedBy) {
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
function taskTimelineEvents(entry) {
    const task = entry.task;
    const phase = phaseForTask(task);
    const events = safeArray(entry.events);
    if (events.length === 0) {
        return [{
                id: `task-${task.id}`,
                title: titleFromKind(task?.type),
                description: `Execution state: ${describeState(task?.state, 'recorded')}.`,
                category: categoryForPhase(phase),
                phase,
                state: compact(task?.state, 'recorded'),
                tone: toneForState(task?.state),
                timestamp: latestDate(task?.startedAt, task?.createdAt, task?.updatedAt),
                meta: titleFromKind(task?.type),
            }];
    }
    return events.map((event) => ({
        id: `task-event-${compact(event?.id, `${task.id}-${event?.seq ?? 'event'}`)}`,
        title: titleFromKind(event?.kind, titleFromKind(task?.type)),
        description: `${titleFromKind(task?.type)} moved through ${describeState(event?.kind, 'execution')}.`,
        category: categoryForPhase(phaseForEvent(event?.kind, task?.type)),
        phase: phaseForEvent(event?.kind, task?.type),
        state: compact(task?.state, 'recorded'),
        tone: toneForState(task?.state),
        timestamp: latestDate(event?.createdAt, task?.updatedAt),
        meta: titleFromKind(task?.type),
        artifactRefs: outputRefs(entry.outputs),
    }));
}
function governanceEvent(approval) {
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
function objectiveEvent(workday) {
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
function artifactTimelineEvent(artifact) {
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
function buildPhases(timeline, artifacts, governance, workday) {
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
function phaseState(phase, events, artifacts, governance, workday) {
    const workdayState = compact(workday?.state, '').toLowerCase();
    if (workdayState === 'failed' || workdayState === 'rejected')
        return workdayState;
    if (events.some((event) => ['failed', 'blocked', 'rejected'].includes(compact(event.state).toLowerCase())))
        return 'blocked';
    if (phase === 'governance' && governance.some((event) => ['pending', 'under_review', 'escalated'].includes(compact(event.state).toLowerCase())))
        return 'pending';
    if (phase === 'knowledge' && artifacts.some((artifact) => ['published', 'approved'].includes(compact(artifact.state).toLowerCase())))
        return 'completed';
    if (events.some((event) => ['running', 'active', 'claimed', 'executing', 'verifying'].includes(compact(event.state).toLowerCase())))
        return 'active';
    if (events.length > 0 || artifacts.length > 0 || governance.length > 0)
        return 'completed';
    return 'waiting';
}
function currentPhase(phases, workday) {
    const state = compact(workday?.state, '').toLowerCase();
    if (['completed', 'failed', 'rejected'].includes(state))
        return describeState(state, 'Completed');
    const active = phases.find((phase) => ['active', 'pending', 'blocked'].includes(phase.state));
    const waiting = phases.find((phase) => phase.state === 'waiting');
    return active?.label ?? waiting?.label ?? 'Knowledge';
}
function capacityProjection(bundle) {
    const ledgerEntries = safeArray(bundle.ledgerEntries);
    const routingDecisions = safeArray(bundle.routingDecisions);
    const reservations = safeArray(bundle.reservations).filter((reservation) => !workdayRef(reservation) || workdayRef(reservation) === bundle.workday.id);
    const usageActuals = safeArray(bundle.usageActuals);
    const derivedEntries = safeArray(bundle.capacitySummary?.derivedCapacity?.entries ?? bundle.capacityOperations?.plan?.derivedCapacity?.entries);
    const nativeUsage = usageActuals.map((actual) => ({
        id: compact(actual?.id, compact(actual?.taskId, 'usage')),
        taskId: compact(actual?.taskId ?? actual?.task_id, ''),
        nativeUnit: compact(actual?.nativeUsage?.nativeUnit ?? actual?.native_usage?.nativeUnit ?? actual?.nativeUnit, ''),
        amount: numberOrNull(actual?.nativeUsage?.amount ?? actual?.nativeUsage?.nativeAmount ?? actual?.nativeUsage?.usd ?? actual?.nativeUsage?.wallMinutes ?? actual?.nativeUsage?.quotaMinutes),
        actualCredits: numberOrNull(actual?.actualCredits ?? actual?.actual_credits),
        source: compact(actual?.actualCreditsSource ?? actual?.actual_credits_source ?? actual?.source, ''),
    }));
    return {
        summary: bundle.capacitySummary ?? null,
        ledgerEntries,
        routingDecisions,
        reservations,
        usageActuals,
        nativeUsage,
        derivedEntries,
        totalCredits: ledgerEntries.reduce((sum, entry) => sum + numberValue(entry?.credits, 0), 0),
        totalUsd: ledgerEntries.reduce((sum, entry) => sum + numberValue(entry?.usd, 0), 0),
        totalReservedNative: reservations.reduce((sum, reservation) => sum + numberValue(reservation?.reservedNativeAmount, 0), 0),
        totalConsumedNative: reservations.reduce((sum, reservation) => sum + numberValue(reservation?.consumedNativeAmount, 0), 0),
        routingDecisionCount: routingDecisions.length,
    };
}
function repositoryContextFor(bundle, artifacts) {
    const repositories = safeArray(bundle.projectSummary?.repositories).map((repository) => ({
        ...repository,
        href: bundle.project?.id ? `/app/projects/${encodeURIComponent(bundle.project.id)}` : '/app/projects',
        projectName: compact(bundle.project?.name, compact(bundle.project?.slug, 'Project')),
    }));
    const artifactRefs = uniqueStrings(artifacts.flatMap((artifact) => artifact.repositories));
    if (artifactRefs.length === 0)
        return repositories;
    return [
        ...repositories,
        {
            id: `refs-${bundle.workday.id}`,
            title: 'Referenced operational files',
            description: `${artifactRefs.slice(0, 4).join(', ')}${artifactRefs.length > 4 ? ` and ${artifactRefs.length - 4} more` : ''}`,
            meta: `${artifactRefs.length} reference${artifactRefs.length === 1 ? '' : 's'}`,
            status: 'referenced',
            tone: 'info',
            href: bundle.project?.id ? `/app/projects/${encodeURIComponent(bundle.project.id)}#development` : '/app/projects',
        },
    ];
}
function normalizeWorkday(project, source, runtime, summaryEntry) {
    const summary = objectValue(summaryEntry?.summary) ?? objectValue(source?.summary) ?? parseJson(source?.summaryJson, {});
    const contentSnapshot = objectValue(summary?.contentSnapshot) ?? {};
    const docsAutomation = objectValue(summary?.docsAutomation) ?? {};
    const id = compact(workdayRef(source), compact(workdayRef(runtime), compact(source?.id, 'workday')));
    return {
        id,
        recordId: compact(source?.id, id),
        projectId: compact(source?.projectId, compact(project?.id, '')),
        projectName: compact(project?.name, compact(project?.slug, 'Project')),
        projectSlug: compact(project?.slug, ''),
        environment: compact(source?.environment, 'staging'),
        kind: compact(source?.kind, 'workday'),
        state: compact(source?.state, compact(runtime?.state, 'active')),
        objective: compact(summary?.objective, compact(summary?.title, compact(contentSnapshot?.title, `Operational workday ${id}`))),
        startedAt: latestDate(source?.startedAt, runtime?.startedAt, summary?.startedAt),
        endedAt: latestDate(source?.endedAt, runtime?.endedAt, summary?.endedAt),
        updatedAt: latestDate(source?.updatedAt, runtime?.updatedAt, source?.createdAt, runtime?.createdAt),
        summary,
        docsAutomation,
        contentSnapshot,
        href: project?.id ? `/app/projects/${encodeURIComponent(project.id)}#development` : '/app/projects',
        tone: toneForState(source?.state ?? runtime?.state),
    };
}
function artifactBelongsToWorkday(artifact, workdayId, taskIds) {
    const relatedWorkday = workdayRef(artifact);
    if (relatedWorkday)
        return relatedWorkday === workdayId;
    const taskId = compact(artifact?.taskId, compact(artifact?.task_id, ''));
    if (taskId)
        return taskIds.has(taskId);
    return false;
}
function outputBody(output) {
    if (output?.output && typeof output.output === 'object')
        return output.output;
    return parseJson(output?.outputJson, {});
}
function outputRefs(outputs) {
    return uniqueStrings(safeArray(outputs).map((output) => output?.outputRef));
}
function riskClassification(approvals) {
    const severities = safeArray(approvals).map((approval) => compact(approval?.severity, '').toLowerCase());
    if (severities.includes('critical'))
        return 'Critical';
    if (severities.includes('high'))
        return 'High';
    if (severities.includes('moderate') || severities.includes('medium'))
        return 'Moderate';
    if (severities.includes('low'))
        return 'Low';
    return 'Unclassified';
}
function phaseForEvent(kind, taskType) {
    const value = `${String(kind ?? '')} ${String(taskType ?? '')}`.toLowerCase();
    if (value.includes('approval') || value.includes('governance') || value.includes('policy') || value.includes('escalat'))
        return 'governance';
    if (value.includes('knowledge') || value.includes('report') || value.includes('publish') || value.includes('release') || value.includes('docs'))
        return 'knowledge';
    if (value.includes('verify') || value.includes('test') || value.includes('check') || value.includes('audit'))
        return 'verification';
    if (value.includes('research') || value.includes('analysis') || value.includes('inspect') || value.includes('inventory') || value.includes('discover') || value.includes('graph'))
        return 'research';
    return 'implementation';
}
function phaseForTask(task) {
    return phaseForEvent(task?.type, task?.type);
}
function categoryForPhase(phase) {
    if (phase === 'research')
        return 'research';
    if (phase === 'governance')
        return 'governance';
    if (phase === 'knowledge')
        return 'knowledge';
    return 'execution';
}
function matchesWorkdayId(value, id) {
    return Boolean(value && (workdayRef(value) === id || compact(value?.id) === id || compact(value?.recordId) === id));
}
function workdayRef(value) {
    return compact(value?.workDayId, compact(value?.work_day_id, ''));
}
function objectValue(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}
function parseJson(value, fallback) {
    if (!value || typeof value !== 'string')
        return fallback;
    try {
        return JSON.parse(value);
    }
    catch {
        return fallback;
    }
}
function numberValue(value, fallback = 0) {
    const next = Number(value);
    return Number.isFinite(next) ? next : fallback;
}
function numberOrNull(value) {
    const next = Number(value);
    return Number.isFinite(next) ? next : null;
}
function compareTimelineAsc(left, right) {
    return compareDatesAsc(left.timestamp, right.timestamp);
}
