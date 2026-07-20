import {
	compact,
	compareDatesAsc,
	describeState,
	latestDate,
	normalizeOperationalArtifact,
	safeArray,
	titleFromKind,
	toneForState,
	uniqueStrings,
	type OperationalArtifact,
	type OperationalTone,
} from './operational-artifacts.js';
import { MAX_CAPACITY_PAGE_LIMIT } from '@treeseed/sdk/capacity-pagination';

export type { OperationalArtifact, OperationalTone } from './operational-artifacts.js';

export type OperationalPhaseKey = 'research' | 'implementation' | 'verification' | 'governance' | 'knowledge';

export interface OperationalTimelineEvent {
	id: string;
	title: string;
	description?: string;
	category: 'objective' | 'research' | 'execution' | 'governance' | 'knowledge' | 'infrastructure';
	phase: OperationalPhaseKey;
	state?: string;
	tone?: OperationalTone;
	timestamp?: string | null;
	href?: string;
	meta?: string;
	artifactRefs?: string[];
	repositoryRefs?: string[];
	governanceRefs?: string[];
}

export interface OperationalPhase {
	key: OperationalPhaseKey;
	label: string;
	description: string;
	state: string;
	tone: OperationalTone;
	eventCount: number;
	artifactCount: number;
}

export interface WorkdayProjection {
	workday: any;
	phases: OperationalPhase[];
	timeline: OperationalTimelineEvent[];
	artifacts: OperationalArtifact[];
	repositoryContext: any[];
	governance: OperationalTimelineEvent[];
	capacity: any;
	knowledgeOutputs: OperationalArtifact[];
	agentActivity: any[];
}

interface BuildWorkdayProjectionInput {
	store: any;
	principal?: any;
	projects?: any[];
	workdayId: string;
}

const phaseDefinitions: Array<Pick<OperationalPhase, 'key' | 'label' | 'description'>> = [
	{ key: 'research', label: 'Research', description: 'Repository inspection, discovery, and operational context gathering.' },
	{ key: 'implementation', label: 'Implementation', description: 'Planned work, patches, configuration, and coordinated execution.' },
	{ key: 'verification', label: 'Verification', description: 'Checks, tests, audits, and confidence-building work.' },
	{ key: 'governance', label: 'Governance', description: 'Approvals, escalations, decisions, and audit checkpoints.' },
	{ key: 'knowledge', label: 'Knowledge', description: 'Reports, release guidance, decisions, and institutional memory.' },
];

async function boundedProjectionPage(load: () => Promise<any>, collection: string) {
	const result = await load().catch(() => null);
	if (!result || !Array.isArray(result.items) || !result.page) return [];
	if (result.page.hasMore) {
		throw Object.assign(new Error(`Workday projection exceeded the ${MAX_CAPACITY_PAGE_LIMIT}-record ${collection} bound; inspect the paginated operator collection directly.`), {
			code: 'workday_projection_collection_bound_exceeded',
			status: 409,
			details: { collection, limit: MAX_CAPACITY_PAGE_LIMIT, nextCursor: result.page.nextCursor ?? null },
		});
	}
	return result.items;
}

export async function buildWorkdayProjection(input: BuildWorkdayProjectionInput): Promise<WorkdayProjection | null> {
	const store = input.store;
	const workdayId = compact(input.workdayId);
	if (!store || !workdayId) return null;
	const envelope = await store.getWorkdayCapacityEnvelope(workdayId);
	if (!envelope) return null;
	const project = safeArray(input.projects).find((candidate) => compact(candidate?.id) === compact(envelope.projectId));
	if (!project) return null;
	return projectWorkdayProjection(await loadProjectWorkdayBundle(store, input.principal, project, envelope));
}

function boundedEvidencePage(result: any, collection: string) {
	if (!result || !Array.isArray(result.items) || !result.page) return [];
	if (result.page.hasMore) {
		throw Object.assign(new Error(`Workday projection exceeded the ${MAX_CAPACITY_PAGE_LIMIT}-record ${collection} bound; inspect the paginated operator collection directly.`), {
			code: 'workday_projection_collection_bound_exceeded',
			status: 409,
			details: { collection, limit: MAX_CAPACITY_PAGE_LIMIT, nextCursor: result.page.nextCursor ?? null },
		});
	}
	return result.items;
}

async function loadProjectWorkdayBundle(store: any, principal: any, project: any, envelope: any) {
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


function projectWorkdayProjection(bundle: any): WorkdayProjection {
	const assignmentIds: Set<string> = new Set(bundle.assignmentDetails.map((entry: any) => compact(entry.assignment?.id)).filter(Boolean));
	const approvals = safeArray(bundle.approvals);
	const artifacts = collectArtifacts(bundle, assignmentIds);
	const governance = approvals.map((approval: any) => governanceEvent(approval));
	const timeline = [
		objectiveEvent(bundle.workday),
		...bundle.assignmentDetails.flatMap((entry: any) => assignmentTimelineEvents(entry)),
		...governance,
		...artifacts.map((artifact: OperationalArtifact) => artifactTimelineEvent(artifact)),
	].sort(compareTimelineAsc);
	const repositoryContext = repositoryContextFor(bundle, artifacts);
	const phases = buildPhases(timeline, artifacts, governance, bundle.workday);

	return {
		workday: {
			...bundle.workday,
			budget: bundle.workday.budget,
			riskClassification: riskClassification(approvals),
			currentPhase: currentPhase(phases, bundle.workday),
		},
		phases,
		timeline,
		artifacts,
		repositoryContext,
		governance,
		capacity: capacityProjection(bundle),
		knowledgeOutputs: artifacts.filter((artifact) => artifact.type === 'Knowledge Entry' || artifact.type === 'Report' || artifact.type === 'Release Note' || artifact.type === 'Operational Decision' || artifact.type === 'Architecture Update'),
		agentActivity: agentActivityProjection(bundle),
	};
}

function agentActivityProjection(bundle: any): any[] {
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
		if (String(assignment.status ?? '').toLowerCase() === 'completed') record.completedCount += 1;
		if (['failed', 'blocked', 'rejected', 'cancelled'].includes(String(assignment.status ?? '').toLowerCase())) record.failedCount += 1;
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

function collectArtifacts(bundle: any, assignmentIds: Set<string>): OperationalArtifact[] {
	const workday = bundle.workday;
	const fromAgents = [
		...safeArray(bundle.agents?.generatedArtifacts),
		...safeArray(bundle.agents?.knowledgeDrafts).map((entry: any) => entry?.knowledgeDraft ?? entry),
		...safeArray(bundle.agents?.runtimeReports),
	]
		.filter((artifact: any) => artifactBelongsToWorkday(artifact, workday.id, assignmentIds))
		.map((artifact: any) => normalizeArtifact(bundle, artifact, 'Operational artifact'));

	const fromModeRuns = bundle.assignmentDetails.flatMap((entry: any) => safeArray(entry.modeRuns).flatMap((run: any) => {
		const body = objectValue(run?.outputs) ?? parseJson(run?.outputsJson, {});
		const generated = safeArray(body?.generatedArtifacts ?? body?.artifacts);
		const outputArtifacts = generated.length > 0 ? generated : body?.artifactKind ? [body] : [];
		return outputArtifacts.map((artifact: any) => normalizeArtifact(bundle, {
			...artifact,
			assignmentId: artifact?.assignmentId ?? entry.assignment?.id,
			modeRunId: artifact?.modeRunId ?? run?.id,
			workDayId: artifact?.workDayId ?? entry.assignment?.workDayId ?? workday.id,
			outputRef: artifact?.outputRef ?? body?.outputRef ?? null,
			createdAt: run?.completedAt ?? run?.createdAt ?? artifact?.createdAt ?? null,
		}, 'Mode run output'));
	}));

	const byId = new Map<string, OperationalArtifact>();
	for (const artifact of [...fromAgents, ...fromModeRuns]) {
		byId.set(artifact.id, {
			...(byId.get(artifact.id) ?? {}),
			...artifact,
			repositories: uniqueStrings([...(byId.get(artifact.id)?.repositories ?? []), ...artifact.repositories]),
		});
	}
	return [...byId.values()].sort((left, right) => compareDatesAsc(left.createdAt, right.createdAt));
}

function normalizeArtifact(bundle: any, artifact: any, producedBy: string): OperationalArtifact {
	const repositories = safeArray(bundle.projectSummary?.repositories);
	return normalizeOperationalArtifact({
		artifact,
		workdayId: bundle.workday.id,
		projectId: bundle.project?.id,
		projectName: compact(bundle.project?.name, compact(bundle.project?.slug, 'Project')),
		producedBy,
		defaultKind: 'Operational artifact',
		repositories,
	});
}

function assignmentTimelineEvents(entry: any): OperationalTimelineEvent[] {
	const assignment = entry.assignment;
	const phase = phaseForAssignment(assignment);
	const runs = safeArray(entry.modeRuns);
	if (runs.length === 0) {
		return [{
			id: `assignment-${assignment.id}`,
			title: titleFromKind(assignment?.mode, 'Assignment'),
			description: `Assignment state: ${describeState(assignment?.status, 'recorded')}.`,
			category: categoryForPhase(phase),
			phase,
			state: compact(assignment?.status, 'recorded'),
			tone: toneForState(assignment?.status),
			timestamp: latestDate(assignment?.leaseClaimedAt, assignment?.createdAt, assignment?.updatedAt),
			meta: titleFromKind(assignment?.mode, 'Assignment'),
		}];
	}
	return runs.map((run: any) => ({
		id: `mode-run-${compact(run?.id, `${assignment.id}-run`)}`,
		title: titleFromKind(run?.handlerId ?? run?.handler_id, titleFromKind(run?.mode ?? assignment?.mode, 'Mode run')),
		description: `${titleFromKind(run?.mode ?? assignment?.mode)} execution ${describeState(run?.status, 'recorded')}.`,
		category: categoryForPhase(phaseForEvent(run?.handlerId ?? run?.mode, assignment?.mode)),
		phase: phaseForEvent(run?.handlerId ?? run?.mode, assignment?.mode),
		state: compact(run?.status ?? assignment?.status, 'recorded'),
		tone: toneForState(run?.status ?? assignment?.status),
		timestamp: latestDate(run?.startedAt, run?.completedAt, run?.failedAt, run?.createdAt, assignment?.updatedAt),
		meta: titleFromKind(run?.executionProviderId ?? assignment?.executionProviderId ?? assignment?.mode, 'Execution'),
		artifactRefs: modeRunArtifactRefs(run),
	}));
}

function governanceEvent(approval: any): OperationalTimelineEvent {
	const id = compact(approval?.id, 'approval');
	return {
		id: `approval-${id}`,
		title: compact(approval?.title, 'Approval requested'),
		description: compact(approval?.summary, titleFromKind(approval?.kind, 'Operational review')),
		category: 'governance',
		phase: 'governance',
		state: compact(approval?.state, 'pending'),
		tone: toneForState(approval?.state ?? approval?.severity),
		timestamp: latestDate(approval?.createdAt, approval?.decidedAt, approval?.updatedAt),
		href: `/app/work/decisions/${encodeURIComponent(id)}`,
		meta: `${describeState(approval?.severity, 'review')} severity`,
		governanceRefs: [id],
	};
}

function objectiveEvent(workday: any): OperationalTimelineEvent {
	return {
		id: `workday-${workday.id}-objective`,
		title: 'Objective received',
		description: workday.objective,
		category: 'objective',
		phase: 'research',
		state: 'received',
		tone: 'info',
		timestamp: latestDate(workday.startedAt, workday.createdAt, workday.updatedAt),
		meta: workday.environment,
	};
}

function artifactTimelineEvent(artifact: OperationalArtifact): OperationalTimelineEvent {
	return {
		id: `artifact-${artifact.id}`,
		title: artifact.title,
		description: artifact.description,
		category: 'knowledge',
		phase: 'knowledge',
		state: artifact.state,
		tone: artifact.tone,
		timestamp: artifact.createdAt,
		href: artifact.href,
		meta: artifact.type,
		artifactRefs: [artifact.id],
		repositoryRefs: artifact.repositories,
	};
}

function buildPhases(timeline: OperationalTimelineEvent[], artifacts: OperationalArtifact[], governance: OperationalTimelineEvent[], workday: any): OperationalPhase[] {
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

function phaseState(phase: OperationalPhaseKey, events: OperationalTimelineEvent[], artifacts: OperationalArtifact[], governance: OperationalTimelineEvent[], workday: any): string {
	const workdayState = compact(workday?.state, '').toLowerCase();
	if (workdayState === 'failed' || workdayState === 'rejected') return workdayState;
	if (events.some((event) => ['failed', 'blocked', 'rejected'].includes(compact(event.state).toLowerCase()))) return 'blocked';
	if (phase === 'governance' && governance.some((event) => ['pending', 'under_review', 'escalated'].includes(compact(event.state).toLowerCase()))) return 'pending';
	if (phase === 'knowledge' && artifacts.some((artifact) => ['published', 'approved'].includes(compact(artifact.state).toLowerCase()))) return 'completed';
	if (events.some((event) => ['running', 'active', 'claimed', 'executing', 'verifying'].includes(compact(event.state).toLowerCase()))) return 'active';
	if (events.length > 0 || artifacts.length > 0 || governance.length > 0) return 'completed';
	return 'waiting';
}

function currentPhase(phases: OperationalPhase[], workday: any) {
	const state = compact(workday?.state, '').toLowerCase();
	if (['completed', 'failed', 'rejected'].includes(state)) return describeState(state, 'Completed');
	const active = phases.find((phase) => ['active', 'pending', 'blocked'].includes(phase.state));
	const waiting = phases.find((phase) => phase.state === 'waiting');
	return active?.label ?? waiting?.label ?? 'Knowledge';
}

function capacityProjection(bundle: any) {
	const ledgerEntries = safeArray(bundle.ledgerEntries);
	const reservations = safeArray(bundle.reservations).filter((reservation: any) => !workdayRef(reservation) || workdayRef(reservation) === bundle.workday.id);
	const usageActuals = safeArray(bundle.usageActuals);
	const derivedEntries = safeArray(bundle.capacitySummary?.derivedCapacity?.entries ?? bundle.capacityOperations?.diagnostics?.derivedCapacity?.entries);
	const nativeUsage = usageActuals.map((actual: any) => ({
		id: compact(actual?.id, compact(actual?.taskId, 'usage')),
		taskId: compact(actual?.taskId ?? actual?.task_id, ''),
		nativeUnit: compact(actual?.nativeUsage?.nativeUnit ?? actual?.native_usage?.nativeUnit ?? actual?.nativeUnit, ''),
		amount: numberOrNull(actual?.nativeUsage?.amount ?? actual?.nativeUsage?.nativeAmount ?? actual?.nativeUsage?.usd ?? actual?.nativeUsage?.wallMinutes ?? actual?.nativeUsage?.quotaMinutes),
		actualCredits: numberOrNull(actual?.actualCredits ?? actual?.actual_credits),
		source: compact(actual?.actualCreditsSource ?? actual?.actual_credits_source ?? actual?.source, ''),
	}));
	return {
		summary: bundle.capacitySummary ?? null,
		ledgerEntries,
		reservations,
		usageActuals,
		nativeUsage,
		derivedEntries,
		totalCredits: ledgerEntries.reduce((sum: number, entry: any) => sum + numberValue(entry?.credits, 0), 0),
		totalUsd: ledgerEntries.reduce((sum: number, entry: any) => sum + numberValue(entry?.usd, 0), 0),
		totalReservedNative: reservations.reduce((sum: number, reservation: any) => sum + numberValue(reservation?.reservedNativeAmount, 0), 0),
		totalConsumedNative: reservations.reduce((sum: number, reservation: any) => sum + numberValue(reservation?.consumedNativeAmount, 0), 0),
	};
}

function repositoryContextFor(bundle: any, artifacts: OperationalArtifact[]) {
	const repositories = safeArray(bundle.projectSummary?.repositories).map((repository: any) => ({
		...repository,
		href: bundle.project?.id ? `/app/projects/${encodeURIComponent(bundle.project.id)}` : '/app/projects',
		projectName: compact(bundle.project?.name, compact(bundle.project?.slug, 'Project')),
	}));
	const artifactRefs = uniqueStrings(artifacts.flatMap((artifact) => artifact.repositories));
	if (artifactRefs.length === 0) return repositories;
	return [
		...repositories,
		{
			id: `refs-${bundle.workday.id}`,
			title: 'Referenced operational files',
			description: `${artifactRefs.slice(0, 4).join(', ')}${artifactRefs.length > 4 ? ` and ${artifactRefs.length - 4} more` : ''}`,
			meta: `${artifactRefs.length} reference${artifactRefs.length === 1 ? '' : 's'}`,
			status: 'referenced',
			tone: 'info',
			href: bundle.project?.id ? `/app/projects/${encodeURIComponent(bundle.project.id)}#development` : '/app/projects',
		},
	];
}

function normalizeWorkday(project: any, source: any, summaryEntry: any) {
	const metadata = objectValue(source?.metadata) ?? {};
	const envelope = objectValue(source?.envelope) ?? {};
	const summary = objectValue(metadata?.summary) ?? objectValue(envelope?.summary) ?? objectValue(summaryEntry) ?? {};
	const contentSnapshot = objectValue(summary?.contentSnapshot) ?? {};
	const docsAutomation = objectValue(summary?.docsAutomation) ?? {};
	const id = compact(source?.id, 'workday');
	return {
		id,
		recordId: compact(source?.id, id),
		projectId: compact(source?.projectId, compact(project?.id, '')),
		projectName: compact(project?.name, compact(project?.slug, 'Project')),
		projectSlug: compact(project?.slug, ''),
		environment: compact(metadata?.environment, 'staging'),
		kind: compact(source?.kind, 'workday'),
		state: compact(source?.status, 'draft'),
		objective: compact(summary?.objective, compact(summary?.title, compact(contentSnapshot?.title, `Operational workday ${id}`))),
		startedAt: latestDate(source?.startedAt, summary?.startedAt),
		endedAt: latestDate(source?.completedAt, summary?.endedAt),
		updatedAt: latestDate(source?.updatedAt, source?.createdAt),
		summary,
		budget: {
			envelope,
			settlement: objectValue(summaryEntry?.settlement) ?? {},
		},
		docsAutomation,
		contentSnapshot,
		href: project?.id ? `/app/projects/${encodeURIComponent(project.id)}#development` : '/app/projects',
		tone: toneForState(source?.status),
	};
}

function artifactBelongsToWorkday(artifact: any, workdayId: string, assignmentIds: Set<string>) {
	const relatedWorkday = workdayRef(artifact);
	if (relatedWorkday) return relatedWorkday === workdayId;
	const assignmentId = compact(artifact?.assignmentId, compact(artifact?.assignment_id, ''));
	if (assignmentId) return assignmentIds.has(assignmentId);
	return false;
}

function modeRunArtifactRefs(run: any) {
	const outputs = objectValue(run?.outputs) ?? parseJson(run?.outputsJson, {});
	return uniqueStrings([
		...safeArray(outputs?.artifactRefs),
		...safeArray(outputs?.artifacts).map((artifact: any) => compact(artifact?.id, '')),
		...safeArray(outputs?.generatedArtifacts).map((artifact: any) => compact(artifact?.id, '')),
	]);
}

function riskClassification(approvals: any[]) {
	const severities = safeArray(approvals).map((approval: any) => compact(approval?.severity, '').toLowerCase());
	if (severities.includes('critical')) return 'Critical';
	if (severities.includes('high')) return 'High';
	if (severities.includes('moderate') || severities.includes('medium')) return 'Moderate';
	if (severities.includes('low')) return 'Low';
	return 'Unclassified';
}

function phaseForEvent(kind: unknown, taskType: unknown): OperationalPhaseKey {
	const value = `${String(kind ?? '')} ${String(taskType ?? '')}`.toLowerCase();
	if (value.includes('approval') || value.includes('governance') || value.includes('policy') || value.includes('escalat')) return 'governance';
	if (value.includes('knowledge') || value.includes('report') || value.includes('publish') || value.includes('release') || value.includes('docs')) return 'knowledge';
	if (value.includes('verify') || value.includes('test') || value.includes('check') || value.includes('audit')) return 'verification';
	if (value.includes('research') || value.includes('analysis') || value.includes('inspect') || value.includes('inventory') || value.includes('discover') || value.includes('graph')) return 'research';
	return 'implementation';
}

function phaseForAssignment(assignment: any): OperationalPhaseKey {
	return phaseForEvent(assignment?.handlerId ?? assignment?.mode, assignment?.mode);
}

function categoryForPhase(phase: OperationalPhaseKey): OperationalTimelineEvent['category'] {
	if (phase === 'research') return 'research';
	if (phase === 'governance') return 'governance';
	if (phase === 'knowledge') return 'knowledge';
	return 'execution';
}

function matchesWorkdayId(value: any, id: string) {
	return Boolean(value && (workdayRef(value) === id || compact(value?.id) === id || compact(value?.recordId) === id));
}

function workdayRef(value: any) {
	return compact(value?.workDayId, compact(value?.work_day_id, ''));
}

function objectValue(value: any) {
	return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function parseJson(value: unknown, fallback: any) {
	if (!value || typeof value !== 'string') return fallback;
	try {
		return JSON.parse(value);
	} catch {
		return fallback;
	}
}

function numberValue(value: unknown, fallback = 0): number {
	const next = Number(value);
	return Number.isFinite(next) ? next : fallback;
}

function numberOrNull(value: unknown): number | null {
	const next = Number(value);
	return Number.isFinite(next) ? next : null;
}

function compareTimelineAsc(left: OperationalTimelineEvent, right: OperationalTimelineEvent): number {
	return compareDatesAsc(left.timestamp, right.timestamp);
}
