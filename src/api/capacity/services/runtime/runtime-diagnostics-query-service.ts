import { summarizeCapacityRuntimeDiagnostics } from '@treeseed/sdk/agent-capacity';
import { DEFAULT_CAPACITY_PAGE_LIMIT } from '@treeseed/sdk/capacity-pagination';

interface RuntimeDiagnosticsDatabase {
	first(query: string, values?: unknown[]): Promise<Record<string, unknown> | null>;
	all(query: string, values?: unknown[]): Promise<Array<Record<string, unknown>>>;
}

export interface RuntimeDiagnosticPage {
	items: Array<Record<string, unknown>>;
	page: { limit: number; hasMore: boolean; nextCursor: string | null };
}

interface RuntimeDiagnosticsRepository extends RuntimeDiagnosticsDatabase {
	getProject(projectId: string): Promise<Record<string, unknown> | null>;
	listProviderAssignmentsPage(teamId: string, filters: Record<string, unknown>): Promise<RuntimeDiagnosticPage>;
	listAgentModeRunsPage(projectId: string, filters: Record<string, unknown>): Promise<RuntimeDiagnosticPage>;
	listTreeDxProxyAuditPage(projectId: string, filters: Record<string, unknown>): Promise<RuntimeDiagnosticPage>;
	listAgentFallbackOutputsPage(projectId: string, filters: Record<string, unknown>): Promise<RuntimeDiagnosticPage>;
	listCapacityLedgerEntriesPage(projectId: string, filters: Record<string, unknown>): Promise<RuntimeDiagnosticPage>;
}

export interface RuntimeDiagnosticIndex {
	totals: {
		assignments: number;
		modeRuns: number;
		treeDxProxyAudit: number;
		ledgerEntries: number;
		fallbackOutputs: number;
	};
	settledAssignmentIds: string[];
	auditedAssignmentIds: string[];
}

function ids(rows: Array<Record<string, unknown>>): string[] {
	return rows.map((row) => String(row.assignment_id ?? '')).filter(Boolean);
}

export async function loadRuntimeDiagnosticIndex(
	database: RuntimeDiagnosticsDatabase,
	input: { teamId: string; projectId: string; assignmentIds: string[] },
): Promise<RuntimeDiagnosticIndex> {
	const totals = await database.first(
		`SELECT
			(SELECT COUNT(*) FROM capacity_provider_assignments WHERE team_id = ? AND project_id = ?) AS assignment_count,
			(SELECT COUNT(*) FROM agent_mode_runs WHERE team_id = ? AND project_id = ?) AS mode_run_count,
			(SELECT COUNT(*) FROM treedx_project_proxy_audit WHERE team_id = ? AND project_id = ?) AS treedx_audit_count,
			(SELECT COUNT(*) FROM capacity_ledger_entries WHERE team_id = ? AND project_id = ?
				AND phase IN ('task_completed_actual_settlement', 'reservation_released', 'task_failed_refund')) AS ledger_entry_count,
			(SELECT COUNT(*) FROM agent_fallback_outputs WHERE team_id = ? AND project_id = ?) AS fallback_output_count`,
		[
			input.teamId, input.projectId,
			input.teamId, input.projectId,
			input.teamId, input.projectId,
			input.teamId, input.projectId,
			input.teamId, input.projectId,
		],
	);
	if (input.assignmentIds.length === 0) {
		return {
			totals: {
				assignments: Number(totals?.assignment_count ?? 0),
				modeRuns: Number(totals?.mode_run_count ?? 0),
				treeDxProxyAudit: Number(totals?.treedx_audit_count ?? 0),
				ledgerEntries: Number(totals?.ledger_entry_count ?? 0),
				fallbackOutputs: Number(totals?.fallback_output_count ?? 0),
			},
			settledAssignmentIds: [],
			auditedAssignmentIds: [],
		};
	}
	const placeholders = input.assignmentIds.map(() => '?').join(', ');
	const [settledRows, auditedRows] = await Promise.all([
		database.all(
			`SELECT DISTINCT assignment_id FROM capacity_ledger_entries
			 WHERE team_id = ? AND project_id = ?
			   AND assignment_id IN (${placeholders})
			   AND phase IN ('task_completed_actual_settlement', 'reservation_released', 'task_failed_refund')`,
			[input.teamId, input.projectId, ...input.assignmentIds],
		),
		database.all(
			`SELECT DISTINCT assignment_id FROM treedx_project_proxy_audit
			 WHERE team_id = ? AND project_id = ? AND assignment_id IN (${placeholders})`,
			[input.teamId, input.projectId, ...input.assignmentIds],
		),
	]);
	return {
		totals: {
			assignments: Number(totals?.assignment_count ?? 0),
			modeRuns: Number(totals?.mode_run_count ?? 0),
			treeDxProxyAudit: Number(totals?.treedx_audit_count ?? 0),
			ledgerEntries: Number(totals?.ledger_entry_count ?? 0),
			fallbackOutputs: Number(totals?.fallback_output_count ?? 0),
		},
		settledAssignmentIds: ids(settledRows),
		auditedAssignmentIds: ids(auditedRows),
	};
}

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string {
	return typeof value === 'string' ? value : '';
}

export async function buildProjectCapacityRuntimeDiagnostics(
	repository: RuntimeDiagnosticsRepository,
	projectId: string,
	teamId?: string | null,
) {
	const project = await repository.getProject(projectId);
	if (!project) return null;
	const projectTeamId = stringValue(project.teamId ?? project.team_id);
	const resolvedTeamId = teamId ?? projectTeamId;
	if (!resolvedTeamId || projectTeamId !== resolvedTeamId) return null;
	const assignmentPage = await repository.listProviderAssignmentsPage(resolvedTeamId, {
		projectId,
		limit: DEFAULT_CAPACITY_PAGE_LIMIT,
	});
	const assignments = assignmentPage.items;
	const [modeRunPage, treeDxProxyAuditPage, fallbackOutputPage] = await Promise.all([
		repository.listAgentModeRunsPage(projectId, { limit: DEFAULT_CAPACITY_PAGE_LIMIT }),
		repository.listTreeDxProxyAuditPage(projectId, { limit: DEFAULT_CAPACITY_PAGE_LIMIT }),
		repository.listAgentFallbackOutputsPage(projectId, { limit: DEFAULT_CAPACITY_PAGE_LIMIT }),
	]);
	const assignmentIds = assignments.map((assignment) => stringValue(assignment.id)).filter(Boolean);
	const ledgerPage = await repository.listCapacityLedgerEntriesPage(projectId, {
		assignmentIds,
		phases: ['task_completed_actual_settlement', 'reservation_released', 'task_failed_refund'],
		limit: DEFAULT_CAPACITY_PAGE_LIMIT,
	});
	const index = await loadRuntimeDiagnosticIndex(repository, { projectId, teamId: resolvedTeamId, assignmentIds });
	const diagnosticInput: Parameters<typeof summarizeCapacityRuntimeDiagnostics>[0] = {
		projectId,
		teamId: resolvedTeamId,
		assignments: assignments as unknown as Parameters<typeof summarizeCapacityRuntimeDiagnostics>[0]['assignments'],
		explanations: assignments.flatMap((assignment) => {
			const explanation = record(assignment.explanation);
			return Object.keys(explanation).length ? [{
				...explanation,
				teamId: assignment.teamId,
				assignmentId: assignment.id,
			}] : [];
		}) as unknown as NonNullable<Parameters<typeof summarizeCapacityRuntimeDiagnostics>[0]['explanations']>,
		modeRuns: modeRunPage.items as unknown as Parameters<typeof summarizeCapacityRuntimeDiagnostics>[0]['modeRuns'],
		treeDxProxyAudit: treeDxProxyAuditPage.items,
		ledgerEntries: ledgerPage.items as unknown as Parameters<typeof summarizeCapacityRuntimeDiagnostics>[0]['ledgerEntries'],
		fallbackOutputs: fallbackOutputPage.items,
		settledAssignmentIds: index.settledAssignmentIds,
		auditedAssignmentIds: index.auditedAssignmentIds,
		windows: {
			assignments: { ...assignmentPage.page, total: index.totals.assignments },
			modeRuns: { ...modeRunPage.page, total: index.totals.modeRuns },
			treeDxProxyAudit: { ...treeDxProxyAuditPage.page, total: index.totals.treeDxProxyAudit },
			ledgerEntries: { ...ledgerPage.page, total: index.totals.ledgerEntries },
			fallbackOutputs: { ...fallbackOutputPage.page, total: index.totals.fallbackOutputs },
		},
	};
	return summarizeCapacityRuntimeDiagnostics(diagnosticInput);
}
