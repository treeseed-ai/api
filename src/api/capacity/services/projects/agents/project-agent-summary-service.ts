import { collectProjectAgentArtifacts } from '../projects-core/project-agent-artifact-service.ts';

type Row = Record<string, unknown>;

interface SummaryStore {
	getProjectDetails(projectId: string): Promise<Row | null>;
	listApprovalRequestsForProject(projectId: string, limit: number): Promise<Row[]>;
	listWorkdayCapacityEnvelopes(projectId: string): Promise<Row[]>;
	listAgentModeRunsPage(projectId: string, filters: { limit: number }): Promise<{ items: Row[]; page: { hasMore: boolean } }>;
}

function record(value: unknown): Row {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
}

function values(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

export async function buildProjectAgentSummary(store: SummaryStore, projectId: string, principal: unknown = null) {
	const details = await store.getProjectDetails(projectId);
	if (!details) return null;
	const [approvals, workdays, modeRunPage] = await Promise.all([
		store.listApprovalRequestsForProject(projectId, 200),
		store.listWorkdayCapacityEnvelopes(projectId),
		store.listAgentModeRunsPage(projectId, { limit: 200 }),
	]);
	const modeRuns = modeRunPage.items;
	const generatedArtifacts = await collectProjectAgentArtifacts(store, projectId, modeRuns);
	const byContentPath = (pattern: RegExp) => generatedArtifacts.filter((artifact) => pattern.test(String(artifact.contentPath ?? artifact.outputRef ?? '')));
	const researchNotes = byContentPath(/(?:^|\/)notes\/research\//u);
	const knowledgeDrafts = generatedArtifacts.filter((artifact) => ['book', 'knowledge', 'page'].includes(String(artifact.model ?? '')));
	const optimizationReports = byContentPath(/(?:optimization|review|report)/u);
	const pendingApprovals = approvals.filter((approval) => ['pending', 'waiting_for_approval', 'human_approval_pending'].includes(String(approval?.state ?? 'pending')));
	const activeModeRuns = modeRuns.filter((run) => ['queued', 'running'].includes(String(run.status)));
	const failedModeRuns = modeRuns.filter((run) => String(run.status) === 'failed');
	const currentWorkday = workdays.find((workday) => ['active', 'paused', 'queued'].includes(String(workday.status))) ?? null;
	const runtimeReports = workdays.slice(0, 6).map((workday) => ({
		id: workday.id,
		workDayId: workday.id,
		projectId: workday.projectId,
		kind: 'workday_capacity_summary',
		state: workday.status,
		summary: record(workday.metadata).summary ?? {},
		createdAt: workday.completedAt ?? workday.updatedAt ?? workday.createdAt,
	}));
	const taskHealth = {
		activeTasks: activeModeRuns,
		staleTasks: [],
		recoveredTaskCount: modeRuns.filter((run) => record(run.metadata).recovered === true).length,
		failedStaleTaskCount: failedModeRuns.filter((run) => record(run.metadata).stale === true).length,
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
		verificationFailureCount: failedModeRuns.length,
		repairTaskCount: modeRuns.filter((run) => record(run.metadata).repair === true).length,
		staleTaskCount: 0,
		recoveredTaskCount: taskHealth.recoveredTaskCount,
		failedStaleTaskCount: taskHealth.failedStaleTaskCount,
		latestReport: runtimeReports[0] ?? null,
	};
	const agentEntries: Array<[string, Row]> = modeRuns
		.map((run): [string, Row] => [String(run.agentSlug ?? run.agentId ?? ''), {
			agentSlug: run.agentSlug ?? run.agentId,
			status: activeModeRuns.some((active) => (
				String(active.agentSlug ?? active.agentId ?? '') === String(run.agentSlug ?? run.agentId ?? '')
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
		warnings: modeRunPage.page.hasMore
			? ['More than 200 mode runs exist; use the paginated project agent-run API for complete history.']
			: [],
		workdaySummaries: runtimeReports,
	};
}
