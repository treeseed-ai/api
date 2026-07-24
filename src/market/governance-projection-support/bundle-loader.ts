import { type GovernanceBundle, type GovernanceContextInput } from '../projects/projects-core/governance-projection.js';
import { safeArray, compact } from './index.js';

export function approvalLookupKeys(value: unknown): Set<string> {
    const raw = compact(value, '');
    const decoded = decodeValue(raw);
    const values = new Set<string>();
    for (const candidate of [raw, decoded]) {
        if (!candidate)
            continue;
        values.add(candidate);
        values.add(candidate.replace(/^approval-/u, ''));
        values.add(candidate.replace(/^approval:/u, ''));
        values.add(candidate.replace(/^approval[-:]/u, 'approval:'));
        values.add(candidate.replace(/^approval[-:]/u, 'approval-'));
    }
    return values;
}

export function decodeValue(value: string): string {
    let decoded = value;
    for (let index = 0; index < 2; index += 1) {
        try {
            const next = decodeURIComponent(decoded);
            if (next === decoded)
                break;
            decoded = next;
        }
        catch {
            break;
        }
    }
    return decoded;
}

export async function loadGovernanceBundles(input: GovernanceContextInput): Promise<GovernanceBundle[]> {
    const store = input.store;
    if (!store)
        return [];
    const teams = safeArray(input.teams);
    const activeTeam = teams[0] ?? null;
    const inboxItems = activeTeam && typeof store.listPersistedTeamInboxItems === 'function'
        ? await store.listPersistedTeamInboxItems(activeTeam.id).catch(() => [])
        : [];
    const teamApprovals = activeTeam && typeof store.listApprovalRequestsForTeam === 'function'
        ? await store.listApprovalRequestsForTeam(activeTeam.id, { limit: 200 }).catch(() => [])
        : [];
    const teamAuditEvents = activeTeam && typeof store.listAuditEventsForTarget === 'function'
        ? await store.listAuditEventsForTarget('team', activeTeam.id, 100).catch(() => [])
        : [];
    const projects = safeArray(input.projects);
    const projectBundles = await Promise.all(projects.map(async (project: any) => {
        const [summary, agents, approvals, capacityOperations, workdays, auditEvents] = await Promise.all([
            typeof store.getProjectSummary === 'function' ? store.getProjectSummary(project.id, input.principal).catch(() => null) : null,
            typeof store.getProjectAgentsSummary === 'function' ? store.getProjectAgentsSummary(project.id, input.principal).catch(() => null) : null,
            typeof store.listApprovalRequestsForProject === 'function' ? store.listApprovalRequestsForProject(project.id, 200).catch(() => []) : [],
            typeof store.getProjectCapacityOperations === 'function' ? store.getProjectCapacityOperations(project.id, 'staging').catch(() => null) : null,
            typeof store.listWorkdayCapacityEnvelopes === 'function' ? store.listWorkdayCapacityEnvelopes(project.id) : [],
            typeof store.listAuditEventsForTarget === 'function' ? store.listAuditEventsForTarget('project', project.id, 100).catch(() => []) : [],
        ]);
        return {
            project,
            summary,
            agents,
            approvals: safeArray(approvals),
            capacityOperations,
            workdays: safeArray(workdays),
            inboxItems: safeArray(inboxItems).filter((item: any) => !item.projectId || item.projectId === project.id),
            auditEvents: safeArray(auditEvents),
        };
    }));
    const teamOnlyApprovals = safeArray(teamApprovals).filter((approval: any) => !projects.some((project: any) => project.id === approval.projectId));
    const teamBundle = activeTeam ? [{
            project: null,
            summary: null,
            agents: null,
            approvals: teamOnlyApprovals,
            capacityOperations: null,
            workdays: [],
            inboxItems: safeArray(inboxItems).filter((item: any) => !item.projectId),
            auditEvents: safeArray(teamAuditEvents),
        }] : [];
    return [...projectBundles, ...teamBundle];
}
