import { compact, describeState, safeArray, toneForState, type OperationalArtifact } from '../operations/operational-artifacts.js';
import { type OperationalPhase, type OperationalPhaseKey, type OperationalTimelineEvent } from '../capacity/workdays/workday-projection.js';

export const phaseDefinitions: Array<Pick<OperationalPhase, 'key' | 'label' | 'description'>> = [
    { key: 'research', label: 'Research', description: 'Repository inspection, discovery, and operational context gathering.' },
    { key: 'implementation', label: 'Implementation', description: 'Planned work, patches, configuration, and coordinated execution.' },
    { key: 'verification', label: 'Verification', description: 'Checks, tests, audits, and confidence-building work.' },
    { key: 'governance', label: 'Governance', description: 'Approvals, escalations, decisions, and audit checkpoints.' },
    { key: 'knowledge', label: 'Knowledge', description: 'Reports, release guidance, decisions, and institutional memory.' },
];

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

export function phaseState(phase: OperationalPhaseKey, events: OperationalTimelineEvent[], artifacts: OperationalArtifact[], governance: OperationalTimelineEvent[], workday: any): string {
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

export function currentPhase(phases: OperationalPhase[], workday: any) {
    const state = compact(workday?.state, '').toLowerCase();
    if (['completed', 'failed', 'rejected'].includes(state))
        return describeState(state, 'Completed');
    const active = phases.find((phase) => ['active', 'pending', 'blocked'].includes(phase.state));
    const waiting = phases.find((phase) => phase.state === 'waiting');
    return active?.label ?? waiting?.label ?? 'Knowledge';
}

export function riskClassification(approvals: any[]) {
    const severities = safeArray(approvals).map((approval: any) => compact(approval?.severity, '').toLowerCase());
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

export function phaseForEvent(kind: unknown, taskType: unknown): OperationalPhaseKey {
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

export function phaseForAssignment(assignment: any): OperationalPhaseKey {
    return phaseForEvent(assignment?.handlerId ?? assignment?.mode, assignment?.mode);
}

export function categoryForPhase(phase: OperationalPhaseKey): OperationalTimelineEvent['category'] {
    if (phase === 'research')
        return 'research';
    if (phase === 'governance')
        return 'governance';
    if (phase === 'knowledge')
        return 'knowledge';
    return 'execution';
}
