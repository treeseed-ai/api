export type GovernanceTone = 'default' | 'muted' | 'info' | 'success' | 'warning' | 'danger' | 'accent';

export interface GovernanceMetric {
	label: string;
	value: string | number;
	description?: string;
	tone?: GovernanceTone;
}

export interface GovernanceEvent {
	id: string;
	title: string;
	description?: string;
	category: 'governance';
	phase: 'governance';
	state?: string;
	tone?: GovernanceTone;
	timestamp?: string | null;
	href?: string;
	meta?: string;
	governanceRefs?: string[];
}

export interface GovernanceReviewItem extends GovernanceEvent {
	approvalId: string;
	projectId?: string | null;
	projectName?: string;
	workDayId?: string | null;
	taskId?: string | null;
	kind: string;
	severity: string;
	requestedAt?: string | null;
	expiresAt?: string | null;
	decisionOptions: GovernanceDecisionOption[];
	policySnapshot?: Record<string, unknown>;
	recommendation?: Record<string, unknown>;
	metadata?: Record<string, unknown>;
}

export interface GovernanceDecisionOption {
	id: string;
	label: string;
	state: 'approved' | 'rejected';
	tone: GovernanceTone;
}

export interface GovernancePolicyItem extends GovernanceEvent {
	projectId?: string | null;
	projectName?: string;
	policyType: string;
	constraints?: Record<string, unknown>;
}

export interface GovernanceCapacityConstraint extends GovernanceEvent {
	projectId?: string | null;
	projectName?: string;
	constraintType: string;
}

export interface GovernanceProjection {
	metrics: GovernanceMetric[];
	pendingApprovals: GovernanceReviewItem[];
	escalations: GovernanceReviewItem[];
	reviewQueue: GovernanceReviewItem[];
	reviewTimeline: GovernanceEvent[];
	auditTrail: GovernanceEvent[];
	policies: GovernancePolicyItem[];
	policyViolations: GovernanceCapacityConstraint[];
	capacityConstraints: GovernanceCapacityConstraint[];
}

export interface GovernanceApprovalProjection {
	approval: GovernanceReviewItem;
	relatedWorkday: any | null;
	relatedProject: any | null;
	repositories: any[];
	relatedArtifacts: any[];
	policies: GovernancePolicyItem[];
	capacityConstraints: GovernanceCapacityConstraint[];
	auditTrail: GovernanceEvent[];
	decisionOptions: GovernanceDecisionOption[];
}

interface GovernanceContextInput {
	store: any;
	principal?: any;
	teams?: any[];
	projects?: any[];
}

interface GovernanceApprovalInput extends GovernanceContextInput {
	approvalId: string;
}

interface GovernanceBundle {
	project: any | null;
	summary: any | null;
	agents: any | null;
	approvals: any[];
	capacityOperations: any | null;
	workdays: any[];
	inboxItems: any[];
	auditEvents: any[];
}

export async function buildGovernanceProjection(input: GovernanceContextInput): Promise<GovernanceProjection> {
	const bundles = await loadGovernanceBundles(input);
	const approvals = uniqueApprovals(bundles.flatMap((bundle) => bundle.approvals.map((approval) => ({ ...approval, __bundle: bundle }))));
	const reviewQueue = approvals.map((approval) => approvalItem(approval.__bundle, approval));
	const pendingApprovals = reviewQueue.filter((item) => ['pending', 'waiting_for_approval', 'under_review'].includes(item.state ?? ''));
	const escalations = reviewQueue.filter((item) =>
		['high', 'critical'].includes(item.severity.toLowerCase())
		|| ['escalated', 'blocked'].includes(String(item.state ?? '').toLowerCase())
	);
	const policies = bundles.flatMap(policyItemsForBundle);
	const capacityConstraints = bundles.flatMap(capacityConstraintsForBundle);
	const policyViolations = capacityConstraints.filter((item) => ['blocked', 'approval_required', 'paused_by_policy', 'waiting_for_budget'].includes(String(item.state ?? '').toLowerCase()));
	const activityEvents = bundles.flatMap(activityEventsForBundle);
	const reviewTimeline = [...reviewQueue, ...activityEvents].sort(compareEventDesc);
	const auditTrail = [
		...reviewTimeline,
		...bundles.flatMap((bundle) => auditEventsForBundle(bundle)),
		...capacityConstraints,
	].sort(compareEventDesc).slice(0, 60);

	return {
		metrics: [
			{ label: 'Pending approvals', value: pendingApprovals.length, tone: pendingApprovals.length ? 'warning' : 'success' },
			{ label: 'Escalations', value: escalations.length, tone: escalations.length ? 'danger' : 'success' },
			{ label: 'Policies visible', value: policies.length },
			{ label: 'Audit events', value: auditTrail.length },
			{ label: 'Capacity constraints', value: capacityConstraints.length, tone: capacityConstraints.length ? 'warning' : 'success' },
		],
		pendingApprovals,
		escalations,
		reviewQueue,
		reviewTimeline,
		auditTrail,
		policies,
		policyViolations,
		capacityConstraints,
	};
}

export async function buildGovernanceApprovalProjection(input: GovernanceApprovalInput): Promise<GovernanceApprovalProjection | null> {
	const bundles = await loadGovernanceBundles(input);
	const approvals = uniqueApprovals(bundles.flatMap((bundle) => bundle.approvals.map((approval) => ({ ...approval, __bundle: bundle }))));
	const inputApprovalIds = approvalLookupKeys(input.approvalId);
	const match = approvals.find((approval) => {
		const keys = approvalLookupKeys(approval.id);
		return [...inputApprovalIds].some((key) => keys.has(key));
	});
	if (!match) return null;

	const bundle = match.__bundle as GovernanceBundle;
	const approval = approvalItem(bundle, match);
	const relatedWorkday = safeArray(bundle.workdays).find((workday: any) => workdayRef(workday) === approval.workDayId || compact(workday?.id) === approval.workDayId) ?? null;
	const relatedArtifacts = [
		...safeArray(bundle.agents?.generatedArtifacts),
		...safeArray(bundle.agents?.knowledgeDrafts).map((entry: any) => entry?.knowledgeDraft ?? entry),
		...safeArray(bundle.agents?.runtimeReports),
	].filter((artifact: any) => !approval.workDayId || workdayRef(artifact) === approval.workDayId);
	const policies = policyItemsForBundle(bundle).filter((policy) => !approval.projectId || policy.projectId === approval.projectId);
	const capacityConstraints = capacityConstraintsForBundle(bundle).filter((constraint) => !approval.workDayId || !constraint.governanceRefs?.length || constraint.governanceRefs.includes(approval.approvalId));
	const auditTrail = [
		approval,
		...activityEventsForBundle(bundle),
		...auditEventsForBundle(bundle),
		...capacityConstraints,
	].sort(compareEventDesc);

	return {
		approval,
		relatedWorkday,
		relatedProject: bundle.project,
		repositories: safeArray(bundle.summary?.repositories),
		relatedArtifacts: relatedArtifacts.map((artifact: any) => ({
			id: compact(artifact?.id, compact(artifact?.draftId, compact(artifact?.reportId, 'artifact'))),
			title: compact(artifact?.title, compact(artifact?.name, 'Operational artifact')),
			state: compact(artifact?.state, compact(artifact?.reviewState, 'generated')),
			href: `/app/knowledge/operations/${anchorPart(artifact?.id ?? artifact?.draftId ?? artifact?.reportId).toLowerCase()}`,
		})),
		policies,
		capacityConstraints,
		auditTrail,
		decisionOptions: approval.decisionOptions,
	};
}

function approvalLookupKeys(value: unknown): Set<string> {
	const raw = compact(value, '');
	const decoded = decodeValue(raw);
	const values = new Set<string>();
	for (const candidate of [raw, decoded]) {
		if (!candidate) continue;
		values.add(candidate);
		values.add(candidate.replace(/^approval-/u, ''));
		values.add(candidate.replace(/^approval:/u, ''));
		values.add(candidate.replace(/^approval[-:]/u, 'approval:'));
		values.add(candidate.replace(/^approval[-:]/u, 'approval-'));
	}
	return values;
}

function decodeValue(value: string): string {
	let decoded = value;
	for (let index = 0; index < 2; index += 1) {
		try {
			const next = decodeURIComponent(decoded);
			if (next === decoded) break;
			decoded = next;
		} catch {
			break;
		}
	}
	return decoded;
}

async function loadGovernanceBundles(input: GovernanceContextInput): Promise<GovernanceBundle[]> {
	const store = input.store;
	if (!store) return [];
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
			typeof store.listProjectWorkdaySummaries === 'function' ? store.listProjectWorkdaySummaries(project.id, null).catch(() => []) : [],
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

function approvalItem(bundle: GovernanceBundle, approval: any): GovernanceReviewItem {
	const id = compact(approval?.id, 'approval');
	const severity = compact(approval?.severity, 'moderate');
	const state = compact(approval?.state, 'pending');
	return {
		id: `approval-${id}`,
		approvalId: id,
		projectId: compact(approval?.projectId, compact(bundle.project?.id, '')) || null,
		projectName: compact(bundle.project?.name, compact(bundle.project?.slug, 'Organization')),
		workDayId: compact(approval?.workDayId, compact(approval?.work_day_id, '')) || null,
		taskId: compact(approval?.taskId, compact(approval?.task_id, '')) || null,
		kind: compact(approval?.kind, 'approval'),
		severity,
		title: compact(approval?.title, 'Approval requested'),
		description: compact(approval?.summary, titleFromKind(approval?.kind, 'Operational review')),
		category: 'governance',
		phase: 'governance',
		state,
		tone: toneForSeverity(severity, state),
		timestamp: latestDate(approval?.createdAt, approval?.updatedAt, approval?.decidedAt),
		requestedAt: latestDate(approval?.createdAt),
		expiresAt: latestDate(approval?.expiresAt),
		href: `/app/work/decisions/${encodeURIComponent(id)}`,
		meta: `${describeState(severity, 'moderate')} severity`,
		governanceRefs: [id],
		decisionOptions: decisionOptionsFor(approval),
		policySnapshot: objectValue(approval?.policySnapshot) ?? {},
		recommendation: objectValue(approval?.recommendation) ?? {},
		metadata: objectValue(approval?.metadata) ?? {},
	};
}

function policyItemsForBundle(bundle: GovernanceBundle): GovernancePolicyItem[] {
	const capabilityPolicies = safeArray(bundle.summary?.capabilityGrants)
		.filter((grant: any) => grant?.approvalPolicy?.requiresApproval)
		.map((grant: any) => ({
			id: `policy-${grant.id ?? grant.namespace ?? 'capability'}-${grant.operation ?? 'approval'}`,
			title: compact(grant?.label, `${compact(grant?.namespace, 'operation')}.${compact(grant?.operation, 'approval')}`),
			description: compact(grant?.approvalPolicy?.reason, 'Human approval required before execution.'),
			category: 'governance' as const,
			phase: 'governance' as const,
			state: grant.enabled === false ? 'paused' : 'active',
			tone: grant.enabled === false ? 'warning' as const : 'success' as const,
			href: bundle.project?.id ? `/app/projects/${encodeURIComponent(bundle.project.id)}/settings` : '/app/work/decisions',
			meta: compact(bundle.project?.name, 'policy'),
			projectId: compact(bundle.project?.id, '') || null,
			projectName: compact(bundle.project?.name, ''),
			policyType: 'approval',
			constraints: objectValue(grant?.approvalPolicy) ?? {},
		}));
	const workPolicy = bundle.capacityOperations?.summary?.workPolicy;
	const workPolicyItem = workPolicy ? [{
		id: `policy-workday-${bundle.project?.id ?? 'team'}`,
		title: `${compact(bundle.project?.name, 'Project')} workday policy`,
		description: workPolicy.enabled === false ? 'Workday execution is paused by policy.' : 'Execution windows and budget thresholds are enforced.',
		category: 'governance' as const,
		phase: 'governance' as const,
		state: workPolicy.enabled === false ? 'paused' : 'active',
		tone: workPolicy.enabled === false ? 'warning' as const : 'success' as const,
		href: bundle.project?.id ? `/app/projects/${encodeURIComponent(bundle.project.id)}/guidance` : '/app/work/decisions',
		meta: compact(workPolicy.environment, 'staging'),
		projectId: compact(bundle.project?.id, '') || null,
		projectName: compact(bundle.project?.name, ''),
		policyType: 'workday',
		constraints: {
			dailyTaskCreditBudget: workPolicy.dailyTaskCreditBudget,
			maxQueuedTasks: workPolicy.maxQueuedTasks,
			maxQueuedCredits: workPolicy.maxQueuedCredits,
			startCron: workPolicy.startCron,
			durationMinutes: workPolicy.durationMinutes,
		},
	}] : [];
	return [...capabilityPolicies, ...workPolicyItem];
}

function capacityConstraintsForBundle(bundle: GovernanceBundle): GovernanceCapacityConstraint[] {
	const operations = bundle.capacityOperations;
	if (!operations) return [];
	const readiness = operations.summary?.readiness;
	const readinessEvents = readiness && readiness !== 'ready' ? [{
		id: `capacity-readiness-${bundle.project?.id}`,
		title: `${compact(bundle.project?.name, 'Project')} capacity readiness`,
		description: safeArray(operations.summary?.reasons).join(', ') || describeState(readiness, 'capacity constraint'),
		category: 'governance' as const,
		phase: 'governance' as const,
		state: readiness,
		tone: toneForState(readiness),
		timestamp: null,
		href: bundle.project?.id ? `/app/projects/${encodeURIComponent(bundle.project.id)}/guidance` : '/app/work/decisions',
		meta: compact(bundle.project?.name, 'capacity'),
		projectId: compact(bundle.project?.id, '') || null,
		projectName: compact(bundle.project?.name, ''),
		constraintType: 'readiness',
	}] : [];
	const blocked = safeArray(operations.blockedRoutingDecisions).map((decision: any) => ({
		id: `capacity-route-${decision.id}`,
		title: decision.decision === 'approval_required' ? 'Capacity approval required' : 'Capacity routing blocked',
		description: compact(decision.reason, 'Routing decision requires governance review.'),
		category: 'governance' as const,
		phase: 'governance' as const,
		state: compact(decision.decision, 'blocked'),
		tone: toneForState(decision.decision),
		timestamp: latestDate(decision.createdAt),
		href: bundle.project?.id ? `/app/projects/${encodeURIComponent(bundle.project.id)}/guidance` : '/app/work/decisions',
		meta: compact(bundle.project?.name, 'capacity'),
		governanceRefs: [],
		projectId: compact(bundle.project?.id, '') || null,
		projectName: compact(bundle.project?.name, ''),
		constraintType: 'routing',
	}));
	const reservations = safeArray(operations.interruptionReservations).map((reservation: any) => ({
		id: `capacity-reservation-${reservation.id}`,
		title: 'Execution interrupted by capacity policy',
		description: describeState(reservation.state, 'Capacity reservation needs review.'),
		category: 'governance' as const,
		phase: 'governance' as const,
		state: compact(reservation.state, 'pending'),
		tone: toneForState(reservation.state),
		timestamp: latestDate(reservation.createdAt, reservation.updatedAt),
		href: bundle.project?.id ? `/app/projects/${encodeURIComponent(bundle.project.id)}/guidance` : '/app/work/decisions',
		meta: compact(bundle.project?.name, 'capacity'),
		governanceRefs: [],
		projectId: compact(bundle.project?.id, '') || null,
		projectName: compact(bundle.project?.name, ''),
		constraintType: 'reservation',
	}));
	return [...readinessEvents, ...blocked, ...reservations];
}

function activityEventsForBundle(bundle: GovernanceBundle): GovernanceEvent[] {
	const activity = safeArray(bundle.summary?.recentActivity).map((entry: any) => ({
		id: `activity-${entry.id ?? entry.timestamp ?? entry.title}`,
		title: compact(entry?.title, `${compact(bundle.project?.name, 'Project')} activity`),
		description: compact(entry?.summary, describeState(entry?.status, 'recorded')),
		category: 'governance' as const,
		phase: 'governance' as const,
		state: compact(entry?.status, 'recorded'),
		tone: toneForState(entry?.status),
		timestamp: latestDate(entry?.timestamp, entry?.createdAt),
		href: compact(entry?.href, bundle.project?.id ? `/app/projects/${encodeURIComponent(bundle.project.id)}/settings` : '/app/work/decisions')
			.replace(`/app/${'governance'}`, '/app/work/decisions')
			.replace(`/app/${'decisions'}`, '/app/work/decisions')
			.replace(`/app/${'workdays'}`, '/app/projects'),
		meta: compact(bundle.project?.name, 'activity'),
	}));
	const inbox = safeArray(bundle.inboxItems).map((item: any) => ({
		id: `inbox-${item.id}`,
		title: compact(item?.title, 'Governance inbox item'),
		description: compact(item?.summary, describeState(item?.kind, 'review item')),
		category: 'governance' as const,
		phase: 'governance' as const,
		state: compact(item?.state, 'recorded'),
		tone: toneForState(item?.state),
		timestamp: latestDate(item?.createdAt, item?.updatedAt),
		href: item?.itemKey ? `/app/work/decisions/${encodeURIComponent(item.itemKey)}` : compact(item?.href, '/app/work/decisions').replace(`/app/${'governance'}`, '/app/work/decisions').replace(`/app/${'decisions'}`, '/app/work/decisions'),
		meta: compact(item?.kind, 'inbox'),
	}));
	return [...activity, ...inbox];
}

function auditEventsForBundle(bundle: GovernanceBundle): GovernanceEvent[] {
	return safeArray(bundle.auditEvents).map((event: any) => ({
		id: `audit-${event.id}`,
		title: titleFromKind(event.eventType ?? event.event_type, 'Audit event'),
		description: compact(event.data?.summary, describeState(event.targetType ?? event.target_type, 'audit record')),
		category: 'governance' as const,
		phase: 'governance' as const,
		state: 'recorded',
		tone: 'muted' as const,
		timestamp: latestDate(event.createdAt ?? event.created_at),
		href: '/app/work/decisions',
		meta: compact(event.actorType ?? event.actor_type, 'audit'),
	}));
}

function decisionOptionsFor(approval: any): GovernanceDecisionOption[] {
	const rawOptions = safeArray(approval?.options)
		.filter((option: any) => option && typeof option === 'object')
		.map((option: any) => {
			const id = compact(option.id, compact(option.value, compact(option.decision, '')));
			if (!id) return null;
			return {
				id,
				label: compact(option.label, titleFromKind(id)),
				state: decisionState(id),
				tone: decisionState(id) === 'rejected' ? 'danger' as const : 'success' as const,
			};
		})
		.filter(Boolean) as GovernanceDecisionOption[];
	if (rawOptions.length > 0) return rawOptions;
	return [
		{ id: 'approve', label: 'Approve', state: 'approved', tone: 'success' },
		{ id: 'reject', label: 'Reject', state: 'rejected', tone: 'danger' },
	];
}

function decisionState(id: string): 'approved' | 'rejected' {
	const value = id.toLowerCase();
	return value.includes('reject') || value.includes('revision') || value.includes('changes') || value.includes('pause') ? 'rejected' : 'approved';
}

function uniqueApprovals(approvals: any[]) {
	const byId = new Map<string, any>();
	for (const approval of approvals) {
		const id = compact(approval?.id);
		if (id && !byId.has(id)) byId.set(id, approval);
	}
	return [...byId.values()];
}

function compareEventDesc(left: GovernanceEvent, right: GovernanceEvent) {
	return Date.parse(right.timestamp ?? '') - Date.parse(left.timestamp ?? '');
}

function workdayRef(value: any) {
	return compact(value?.workDayId, compact(value?.work_day_id, ''));
}

function objectValue(value: any) {
	return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function safeArray<T = any>(value: unknown): T[] {
	return Array.isArray(value) ? value as T[] : [];
}

function compact(value: unknown, fallback = ''): string {
	return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function latestDate(...values: unknown[]): string | null {
	return values.map((value) => compact(value, '')).find(Boolean) ?? null;
}

function anchorPart(value: unknown): string {
	return compact(value, 'item').replace(/[^a-zA-Z0-9_-]+/gu, '-');
}

function titleFromKind(value: unknown, fallback = 'Operational event') {
	const text = compact(value, fallback)
		.replace(/([a-z])([A-Z])/gu, '$1 $2')
		.replace(/[_:-]+/gu, ' ')
		.trim();
	return text.replace(/\b\w/gu, (match) => match.toUpperCase());
}

function describeState(state: unknown, fallback = 'not recorded'): string {
	return compact(state, fallback).replaceAll('_', ' ');
}

function toneForSeverity(severity: unknown, state: unknown): GovernanceTone {
	const stateValue = compact(state).toLowerCase();
	if (['approved', 'completed', 'published'].includes(stateValue)) return 'success';
	if (['rejected', 'failed', 'expired'].includes(stateValue)) return 'danger';
	const severityValue = compact(severity).toLowerCase();
	if (['critical', 'high'].includes(severityValue)) return 'danger';
	if (['moderate', 'medium', 'pending'].includes(severityValue)) return 'warning';
	return 'default';
}

function toneForState(state: unknown): GovernanceTone {
	const value = compact(state).toLowerCase();
	if (['completed', 'approved', 'published', 'succeeded', 'success', 'active', 'ready', 'selected'].includes(value)) return 'success';
	if (['pending', 'queued', 'waiting', 'waiting_for_approval', 'under_review', 'approval_required', 'waiting_for_budget'].includes(value)) return 'warning';
	if (['failed', 'rejected', 'blocked', 'critical', 'expired', 'paused_by_policy'].includes(value)) return 'danger';
	if (['paused', 'escalated', 'running', 'executing', 'verifying'].includes(value)) return 'info';
	return 'default';
}
