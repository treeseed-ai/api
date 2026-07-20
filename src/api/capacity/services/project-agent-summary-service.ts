import { collectProjectAgentArtifacts } from './project-agent-artifact-service.ts';

type Row = Record<string, unknown>;

interface SummaryStore {
	getProjectDetails(projectId: string): Promise<Row | null>;
	requestProjectRuntime(projectId: string, principal: unknown, path: string): Promise<Row | null>;
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
	const [statusPayload, messagePayload, codexReadiness, approvals, workdays, modeRunPage] = await Promise.all([
		store.requestProjectRuntime(projectId, principal, '/v1/agents/status'),
		store.requestProjectRuntime(projectId, principal, '/v1/agents/messages'),
		store.requestProjectRuntime(projectId, principal, '/v1/providers/codex/readiness'),
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
		recoveredTaskCount: modeRuns.filter((run) => run.metadata?.recovered === true).length,
		failedStaleTaskCount: failedModeRuns.filter((run) => run.metadata?.stale === true).length,
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
		repairTaskCount: modeRuns.filter((run) => run.metadata?.repair === true).length,
		staleTaskCount: 0,
		recoveredTaskCount: taskHealth.recoveredTaskCount,
		failedStaleTaskCount: taskHealth.failedStaleTaskCount,
		latestReport: runtimeReports[0] ?? null,
	};
	const runtimeUnavailableWarning = 'Project runtime is not connected or unavailable.';
	const runtimeWarnings = [
		...(statusPayload ? [] : [runtimeUnavailableWarning]),
		...(modeRunPage.page.hasMore ? ['More than 200 mode runs exist; use the paginated project agent-run API for complete history.'] : []),
		...values(codexReadiness?.warnings),
		...values(codexReadiness?.blockingIssues),
	].filter(Boolean);
	return {
		projectId,
		agents: values(statusPayload?.agents),
		messages: values(messagePayload),
		generatedArtifacts,
		researchNotes,
		knowledgeDrafts,
		optimizationReports,
		approvals,
		operationGrants: [],
		operationEvents: [],
		operationLifecycle: { worktreeSnapshots: [], stagingMerges: [], mergeFailures: [], repairTasks: [], releaseApprovals: [], releaseResults: [], codexUsage: [] },
		taskHealth,
		docsAutomation,
		codexReadiness: codexReadiness ?? { ok: false, providerSelected: false, sdkInstalled: false, nodeVersionOk: true, authDetected: false, subscriptionPlan: 'unknown', warnings: [runtimeUnavailableWarning], blockingIssues: [] },
		currentWorkday,
		runtimeReports,
		runtimeWarnings,
		workdaySummaries: runtimeReports,
	};
}
