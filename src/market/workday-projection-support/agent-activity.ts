import { compact, latestDate, safeArray, titleFromKind } from '../operations/operational-artifacts.js';

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
