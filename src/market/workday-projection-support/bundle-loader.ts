import { compact, safeArray } from '../operational-artifacts.js';
import { MAX_CAPACITY_PAGE_LIMIT } from '@treeseed/sdk/capacity-pagination';
import { normalizeWorkday, workdayRef } from './index.js';

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
