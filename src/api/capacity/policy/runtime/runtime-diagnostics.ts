import { type ProviderAssignment } from '@treeseed/sdk/agent-capacity';
import type { CapacityRuntimeBlockerVm,CapacityRuntimeDiagnosticsResponse,ProviderAssignmentExplanation } from '@treeseed/sdk/agent-capacity';
import type { CapacityLedgerEntry } from '@treeseed/sdk/agent-capacity';
import { record } from '../support-primitives.ts';

export function isProviderAssignmentLeaseExpired(assignment: Pick<ProviderAssignment, 'leaseExpiresAt'>, now = new Date()): boolean {
	if (!assignment.leaseExpiresAt) return false;
	const expiresAt = Date.parse(assignment.leaseExpiresAt);
	return Number.isFinite(expiresAt) && expiresAt <= now.getTime();
}

export function isProviderAssignmentLeasable(assignment: Pick<ProviderAssignment, 'status' | 'leaseState' | 'leaseExpiresAt'>, now = new Date()): boolean {
	if (assignment.status === 'pending' && assignment.leaseState === 'unleased') return true;
	if (assignment.status === 'returned' && assignment.leaseState === 'released') return true;
	if (assignment.leaseState === 'leased' && isProviderAssignmentLeaseExpired(assignment, now)) return true;
	return false;
}

const CAPACITY_RUNTIME_REASON_DETAILS: Record<string, {
	title: string;
	message: string;
	owner: CapacityRuntimeBlockerOwner;
	nextAction: string;
	severity: CapacityRuntimeBlockerSeverity;
}> = {
	provider_inactive: {
		title: 'Provider is inactive',
		message: 'The capacity provider is not currently eligible to receive work.',
		owner: 'provider_operator',
		nextAction: 'Start or reactivate the provider runtime and confirm it is checking in.',
		severity: 'danger',
	},
	provider_session_not_open: {
		title: 'Provider session is not open',
		message: 'The provider has no open availability session for this assignment.',
		owner: 'provider_operator',
		nextAction: 'Open a provider session by running the provider manager availability-session loop.',
		severity: 'danger',
	},
	outside_availability_window: {
		title: 'Outside availability window',
		message: 'The provider checked in, but its availability window does not cover the current time.',
		owner: 'provider_operator',
		nextAction: 'Adjust the provider availability window or wait until the window opens.',
		severity: 'warning',
	},
	missing_required_capability: {
		title: 'Missing required capability',
		message: 'No checked-in execution provider advertised all capabilities required by the assignment.',
		owner: 'team_admin',
		nextAction: 'Update provider grants/capabilities or assign the work to a provider that supports the required capability set.',
		severity: 'danger',
	},
	missing_checked_in_grant: {
		title: 'Grant was not checked in',
		message: 'The provider did not present the grant needed for this project, class, or mode.',
		owner: 'provider_operator',
		nextAction: 'Refresh provider configuration and check in with the expected grants.',
		severity: 'danger',
	},
	missing_active_grant: {
		title: 'Grant is not active',
		message: 'A matching grant exists but is not active for assignment leasing.',
		owner: 'team_admin',
		nextAction: 'Activate or replace the capacity grant before retrying the assignment.',
		severity: 'danger',
	},
	workday_not_active: {
		title: 'Workday is not active',
		message: 'The assignment cannot lease because its workday envelope is not active.',
		owner: 'team_admin',
		nextAction: 'Start or resume the workday, or move the work to an active envelope.',
		severity: 'warning',
	},
	decision_readiness_not_ready: {
		title: 'Decision is not ready',
		message: 'The underlying decision input has not reached execution readiness.',
		owner: 'project',
		nextAction: 'Resolve open questions, accept the proposal, or mark the decision readiness gate ready.',
		severity: 'warning',
	},
	capacity_plan_not_ready: {
		title: 'Capacity plan is not ready',
		message: 'Acting work requires an accepted, scheduled, or active capacity plan.',
		owner: 'project',
		nextAction: 'Accept or schedule the capacity plan generated during planning.',
		severity: 'warning',
	},
	runner_pressure_exhausted: {
		title: 'Runner pressure exhausted',
		message: 'The provider runner reported that local concurrency, quota, or pressure limits are exhausted.',
		owner: 'provider_operator',
		nextAction: 'Wait for active work to finish or increase provider-local runner capacity.',
		severity: 'warning',
	},
	allocation_exhausted: {
		title: 'Allocation exhausted',
		message: 'The matching allocation set does not have enough remaining agent time for this assignment.',
		owner: 'team_admin',
		nextAction: 'Increase allocation, change routing, or defer lower-priority work.',
		severity: 'danger',
	},
	allocation_overrun_hold: {
		title: 'Allocation overrun hold',
		message: 'The assignment would exceed allocation policy and requires overrun approval.',
		owner: 'team_admin',
		nextAction: 'Approve the overrun or adjust the capacity plan before leasing.',
		severity: 'warning',
	},
	treedx_proxy_handle_missing: {
		title: 'TreeDX proxy handle missing',
		message: 'Content-scoped work requires an assignment-scoped TreeDX proxy handle.',
		owner: 'system',
		nextAction: 'Regenerate the assignment after TreeDX workspace access is available.',
		severity: 'danger',
	},
	treedx_proxy_scope_mismatch: {
		title: 'TreeDX proxy scope mismatch',
		message: 'The TreeDX proxy handle does not match the assignment project, workspace, or operation scope.',
		owner: 'system',
		nextAction: 'Issue a fresh scoped proxy handle for this assignment.',
		severity: 'danger',
	},
	treedx_proxy_operation_denied: {
		title: 'TreeDX operation denied',
		message: 'The requested TreeDX operation is outside the handle scope.',
		owner: 'project',
		nextAction: 'Update the agent capability requirements or issue a handle with the required operation.',
		severity: 'danger',
	},
	treedx_proxy_path_denied: {
		title: 'TreeDX path denied',
		message: 'The requested content path is outside the TreeDX handle path scope.',
		owner: 'project',
		nextAction: 'Constrain the work to allowed paths or update the approved path scope.',
		severity: 'danger',
	},
	local_content_write_blocked: {
		title: 'Local content write blocked',
		message: 'Content writes must go through TreeDX when assignment workspace handles are expected.',
		owner: 'project',
		nextAction: 'Use TreeDX workspace write/commit tools for content, and reserve local files for code and artifacts.',
		severity: 'danger',
	},
	treedx_workspace_required: {
		title: 'TreeDX workspace required',
		message: 'The assignment needs a TreeDX workspace before content mutation can begin.',
		owner: 'system',
		nextAction: 'Create or attach a TreeDX workspace and retry assignment synthesis.',
		severity: 'danger',
	},
	execution_provider_prepare_rejected: {
		title: 'Execution provider rejected preparation',
		message: 'The selected execution provider could not prepare the work package.',
		owner: 'provider_operator',
		nextAction: 'Inspect provider readiness, auth, sandbox, and adapter diagnostics.',
		severity: 'danger',
	},
	assignment_output_invalid: {
		title: 'Assignment output invalid',
		message: 'The agent completed with output that did not satisfy the assignment output contract.',
		owner: 'project',
		nextAction: 'Tighten the agent output contract or fix the handler/provider output mapping.',
		severity: 'danger',
	},
};

function runtimeReasonDetails(code: string) {
	return CAPACITY_RUNTIME_REASON_DETAILS[code] ?? {
		title: code.split(/[_-]+/u).filter(Boolean).map((part) => part[0]?.toUpperCase() + part.slice(1)).join(' ') || 'Runtime blocker',
		message: 'The assignment reported a runtime blocker that does not yet have a specialized explanation.',
		owner: 'system' as const,
		nextAction: 'Inspect the assignment explanation gates and provider runner logs.',
		severity: 'warning' as const,
	};
}

function assignmentById(assignments: ProviderAssignment[]) {
	return new Map(assignments.map((assignment) => [assignment.id, assignment]));
}

export function summarizeCapacityRuntimeDiagnostics(input: {
	projectId: string;
	teamId: string;
	generatedAt?: string;
	assignments: ProviderAssignment[];
	explanations?: ProviderAssignmentExplanation[];
	modeRuns?: AgentModeRun[];
	treeDxProxyAudit?: Array<Record<string, unknown>>;
	ledgerEntries?: CapacityLedgerEntry[];
	fallbackOutputs?: Array<Record<string, unknown>>;
	settledAssignmentIds?: string[];
	auditedAssignmentIds?: string[];
	windows: CapacityRuntimeDiagnosticsResponse['windows'];
}): CapacityRuntimeDiagnosticsResponse {
	const assignments = input.assignments ?? [];
	const explanations = input.explanations ?? [];
	const byAssignment = assignmentById(assignments);
	const diagnostics: CapacityRuntimeBlockerVm[] = [];
	const addBlocker = (code: string, assignment?: ProviderAssignment | null, evidence: CapacityRuntimeBlockerVm['evidence'] = []) => {
		const details = runtimeReasonDetails(code);
		diagnostics.push({
			code,
			severity: details.severity,
			title: details.title,
			message: details.message,
			owner: details.owner,
			assignmentId: assignment?.id ?? null,
			projectId: assignment?.projectId ?? input.projectId,
			providerId: assignment?.capacityProviderId ?? null,
			nextAction: details.nextAction,
			evidence,
		});
	};

	for (const explanation of explanations) {
		const assignment = byAssignment.get(explanation.assignmentId) ?? null;
		for (const reason of explanation.reasons ?? []) {
			addBlocker(reason, assignment, [
				{ label: 'eligible', value: String(explanation.eligible) },
				{ label: 'source', value: String(explanation.source ?? 'unknown') },
			]);
		}
	}

	for (const assignment of assignments) {
		if (assignment.lifecycleCode) {
			addBlocker(String(assignment.lifecycleCode), assignment, [
				{ label: 'status', value: String(assignment.status) },
				{ label: 'lease', value: String(assignment.leaseState) },
			]);
		}
		if (assignment.status === 'failed') {
			addBlocker('assignment_failed', assignment, [
				{ label: 'reason', value: String(assignment.lifecycleReason ?? 'not recorded') },
			]);
		}
	}

	const auditAssignmentIds = new Set([
		...(input.auditedAssignmentIds ?? []),
		...(input.treeDxProxyAudit ?? []).map((audit) => String(audit.assignmentId ?? '')).filter(Boolean),
	]);
	for (const assignment of assignments) {
		const handle = record(assignment.treedxProxyHandle);
		if (handle.id && !auditAssignmentIds.has(assignment.id) && assignment.status !== 'pending') {
			addBlocker('treedx_proxy_audit_missing', assignment, [
				{ label: 'handle', value: String(handle.id) },
				{ label: 'status', value: String(assignment.status) },
			]);
		}
	}

	const terminalPhases = new Set(['task_completed_actual_settlement', 'reservation_released', 'task_failed_refund']);
	const settledAssignmentIds = new Set(input.settledAssignmentIds ?? []);
	const assignmentLedger = new Map<string, CapacityLedgerEntry[]>();
	for (const entry of input.ledgerEntries ?? []) {
		const assignmentId = entry.assignmentId ?? null;
		if (!assignmentId) continue;
		assignmentLedger.set(assignmentId, [...(assignmentLedger.get(assignmentId) ?? []), entry]);
	}
	for (const assignment of assignments) {
		if (['completed', 'failed', 'returned'].includes(String(assignment.status))) {
			const hasTerminal = settledAssignmentIds.has(assignment.id)
				|| (assignmentLedger.get(assignment.id) ?? []).some((entry) => terminalPhases.has(String(entry.phase)));
			if (!hasTerminal && assignment.reservationId) {
				addBlocker('settlement_missing', assignment, [
					{ label: 'reservation', value: String(assignment.reservationId) },
					{ label: 'status', value: String(assignment.status) },
				]);
			}
		}
	}

	const uniqueDiagnostics = Array.from(new Map(diagnostics.map((diagnostic) => [
		`${diagnostic.assignmentId ?? 'global'}:${diagnostic.code}`,
		diagnostic,
	])).values());
	return {
		projectId: input.projectId,
		teamId: input.teamId,
		generatedAt: input.generatedAt ?? new Date().toISOString(),
		assignments,
		explanations,
		modeRuns: input.modeRuns ?? [],
		treeDxProxyAudit: input.treeDxProxyAudit ?? [],
		ledgerEntries: input.ledgerEntries ?? [],
		fallbackOutputs: input.fallbackOutputs ?? [],
		diagnostics: uniqueDiagnostics,
		windows: input.windows,
	};
}
