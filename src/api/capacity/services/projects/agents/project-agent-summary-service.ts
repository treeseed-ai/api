import { collectProjectAgentArtifacts } from '../projects-core/project-agent-artifact-service.ts';

type Row = Record<string, unknown>;

interface SummaryStore {
	getProjectDetails(projectId: string): Promise<Row | null>;
	listApprovalRequestsForProject(projectId: string, limit: number): Promise<Row[]>;
	all(query: string, values?: unknown[]): Promise<Row[]>;
	listProviderAssignmentsPage(teamId: string, filters: { projectId: string; limit: number }): Promise<{ items: Row[]; page: { hasMore: boolean } }>;
}

function record(value: unknown): Row {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
}

export async function buildProjectAgentSummary(store: SummaryStore, projectId: string, principal: unknown = null) {
	const details = await store.getProjectDetails(projectId);
	if (!details) return null;
	const [approvals, workdays, assignmentPage] = await Promise.all([
		store.listApprovalRequestsForProject(projectId, 200),
		store.all(`SELECT id,status,summary_json::jsonb AS summary,created_at AS "createdAt",updated_at AS "updatedAt",completed_at AS "completedAt"
			FROM capacity_workday_runs WHERE team_id=? AND jsonb_exists(parameters_json::jsonb -> 'scheduledProjectIds', ?)
			ORDER BY created_at DESC,id DESC LIMIT 200`, [String(details.teamId), projectId]),
		store.listProviderAssignmentsPage(String(details.teamId), { projectId, limit: 200 }),
	]);
	const assignments = assignmentPage.items;
	const generatedArtifacts = await collectProjectAgentArtifacts(store, projectId, assignments);
	const byContentPath = (pattern: RegExp) => generatedArtifacts.filter((artifact) => pattern.test(String(artifact.contentPath ?? artifact.outputRef ?? '')));
	const researchNotes = byContentPath(/(?:^|\/)notes\/research\//u);
	const knowledgeDrafts = generatedArtifacts.filter((artifact) => ['book', 'knowledge', 'page'].includes(String(artifact.model ?? '')));
	const optimizationReports = byContentPath(/(?:optimization|review|report)/u);
	const pendingApprovals = approvals.filter((approval) => ['pending', 'waiting_for_approval', 'human_approval_pending'].includes(String(approval?.state ?? 'pending')));
	const activeAssignments = assignments.filter((assignment) => ['queued', 'leased', 'running'].includes(String(assignment.status)));
	const failedAssignments = assignments.filter((assignment) => String(assignment.status) === 'failed');
	const currentWorkday = workdays.find((workday) => ['running', 'queued'].includes(String(workday.status))) ?? null;
	const runtimeReports = workdays.slice(0, 6).map((workday) => ({
		id: workday.id,
		workDayId: workday.id,
		projectId,
		kind: 'workday_capacity_summary',
		state: workday.status,
		summary: record(workday.summary),
		createdAt: workday.completedAt ?? workday.updatedAt ?? workday.createdAt,
	}));
	const taskHealth = {
		activeTasks: activeAssignments,
		staleTasks: [],
		recoveredTaskCount: assignments.filter((assignment) => record(assignment.metadata).recovered === true).length,
		failedStaleTaskCount: failedAssignments.filter((assignment) => record(assignment.metadata).stale === true).length,
		retryBackoffPolicy: { source: 'provider_assignment_retry_policy' },
	};
	const docsAutomation = {
		activeWorkdayId: currentWorkday?.id ?? null,
		activeWorkdayState: currentWorkday?.status ?? null,
		generatedArtifactCount: generatedArtifacts.length,
		researchNoteCount: researchNotes.length,
		knowledgeDraftCount: knowledgeDrafts.length,
		optimizationReportCount: optimizationReports.length,
		pendingApprovalCount: pendingApprovals.length,
		docsMutationCount: generatedArtifacts.filter((artifact) => artifact.artifactKind === 'docs_mutation_result').length,
		verificationFailureCount: failedAssignments.length,
		repairTaskCount: assignments.filter((assignment) => record(assignment.metadata).repair === true).length,
		staleTaskCount: 0,
		recoveredTaskCount: taskHealth.recoveredTaskCount,
		failedStaleTaskCount: taskHealth.failedStaleTaskCount,
		latestReport: runtimeReports[0] ?? null,
	};
	const agentEntries: Array<[string, Row]> = assignments
		.map((assignment): [string, Row] => [String(assignment.agentId ?? ''), {
			agentSlug: assignment.agentId,
			status: activeAssignments.some((active) => (
				String(active.agentId ?? '') === String(assignment.agentId ?? '')
			)) ? 'active' : 'idle',
			}])
		.filter(([key]) => Boolean(key));
	const agents = [...new Map<string, Row>(agentEntries).values()];
	return {
		projectId,
		agents,
		generatedArtifacts,
		researchNotes,
		knowledgeDrafts,
		optimizationReports,
		approvals,
		taskHealth,
		docsAutomation,
		currentWorkday,
		runtimeReports,
		warnings: assignmentPage.page.hasMore
			? ['More than 200 assignments exist; use the paginated provider assignment API for complete history.']
			: [],
		workdaySummaries: runtimeReports,
	};
}
