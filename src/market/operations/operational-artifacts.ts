export type OperationalTone = 'default' | 'muted' | 'info' | 'success' | 'warning' | 'danger' | 'accent';

export interface OperationalArtifact {
	id: string;
	type: string;
	category: string;
	slug: string;
	title: string;
	description: string;
	state: string;
	tone: OperationalTone;
	href: string;
	workDayId: string;
	taskId?: string | null;
	outputRef?: string | null;
	repositories: string[];
	relatedWorkday: string;
	producedBy: string;
	approvalState?: string | null;
	createdAt?: string | null;
	projectId?: string | null;
	projectName?: string | null;
	sourceKind?: string | null;
}

export interface NormalizeOperationalArtifactInput {
	artifact: any;
	workdayId?: unknown;
	projectId?: unknown;
	projectName?: unknown;
	producedBy?: unknown;
	defaultKind?: unknown;
	repositories?: unknown[];
	approvalState?: unknown;
	createdAt?: unknown;
	categoryOverride?: unknown;
	href?: unknown;
}

export function normalizeOperationalArtifact(input: NormalizeOperationalArtifactInput): OperationalArtifact {
	const artifact = input.artifact ?? {};
	const kind = compact(artifact?.artifactKind, compact(artifact?.kind, compact(artifact?.type, compact(input.defaultKind, 'artifact'))));
	const workDayId = compact(artifact?.workDayId, compact(artifact?.workdayId, compact(artifact?.work_day_id, compact(input.workdayId, ''))));
	const id = compact(
		artifact?.id,
		compact(artifact?.draftId, compact(artifact?.reportId, compact(artifact?.releaseTag, `${workDayId || 'artifact'}-${kind}`))),
	);
	const state = compact(artifact?.state, compact(artifact?.status, compact(artifact?.reviewState, compact(artifact?.verificationStatus, 'generated'))));
	const title = compact(artifact?.title, compact(artifact?.name, titleFromKind(kind)));
	const type = artifactType(kind, title);
	const category = compact(input.categoryOverride, artifactCategoryFromType(type));
	const slug = artifactSlug(id, title);
	const repositories = uniqueStrings([
		...safeArray(input.repositories).map(repositoryLabel),
		...safeArray(artifact?.repositories).map(repositoryLabel),
		...safeArray(artifact?.repositoryRefs).map(repositoryLabel),
		...safeArray(artifact?.sourceRefs),
		...safeArray(artifact?.changedPaths),
	]);

	return {
		id,
		type,
		category,
		slug,
		title,
		description: compact(artifact?.summary, compact(artifact?.description, titleFromKind(kind))),
		state,
		tone: toneForState(state),
		href: compact(input.href, `/app/knowledge/${categorySlug(category)}/${encodeURIComponent(slug)}`),
		workDayId,
		taskId: compact(artifact?.taskId, compact(artifact?.task_id, '')) || null,
		outputRef: compact(artifact?.outputRef, '') || null,
		repositories,
		relatedWorkday: workDayId,
		producedBy: compact(input.producedBy, compact(input.projectName, 'Operational workday')),
		approvalState: compact(input.approvalState, compact(artifact?.approvalState, compact(artifact?.reviewState, ''))) || null,
		createdAt: latestDate(input.createdAt, artifact?.createdAt, artifact?.generatedAt, artifact?.updatedAt, artifact?.date),
		projectId: compact(input.projectId, compact(artifact?.projectId, '')) || null,
		projectName: compact(input.projectName, '') || null,
		sourceKind: kind,
	};
}

export function artifactType(kind: unknown, title: string) {
	const value = `${String(kind ?? '')} ${title}`.toLowerCase();
	if (value.includes('patch') || value.includes('diff')) return 'Patch';
	if (value.includes('architecture')) return 'Architecture Update';
	if (value.includes('verify') || value.includes('test') || value.includes('checklist')) return 'Verification Checklist';
	if (value.includes('report')) return 'Report';
	if (value.includes('deploy')) return 'Deployment Guidance';
	if (value.includes('research') || value.includes('inventory') || value.includes('analysis') || value.includes('question')) return 'Research Summary';
	if (value.includes('decision') || value.includes('rationale')) return 'Operational Decision';
	if (value.includes('release')) return 'Release Note';
	if (value.includes('knowledge') || value.includes('draft') || value.includes('doc') || value.includes('book') || value.includes('note')) return 'Knowledge Entry';
	return 'Report';
}

export function artifactCategoryFromType(type: unknown): string {
	const value = String(type ?? '').toLowerCase();
	if (value.includes('architecture')) return 'Architecture';
	if (value.includes('research')) return 'Research';
	if (value.includes('patch') || value.includes('verification') || value.includes('implementation')) return 'Implementation';
	if (value.includes('decision')) return 'Decisions';
	if (value.includes('release')) return 'Releases';
	if (value.includes('report')) return 'Reports';
	return 'Operations';
}

export function artifactSlug(id: unknown, title?: unknown): string {
	return anchorPart(compact(id, compact(title, 'artifact'))).toLowerCase();
}

export function categorySlug(category: unknown): string {
	return anchorPart(compact(category, 'operations')).toLowerCase();
}

export function titleFromKind(value: unknown, fallback = 'Operational event') {
	const text = compact(value, fallback)
		.replace(/([a-z])([A-Z])/gu, '$1 $2')
		.replace(/[_-]+/gu, ' ')
		.trim();
	return text.replace(/\b\w/gu, (match) => match.toUpperCase());
}

export function safeArray<T = any>(value: unknown): T[] {
	return Array.isArray(value) ? value as T[] : [];
}

export function compact(value: unknown, fallback = ''): string {
	return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

export function anchorPart(value: unknown): string {
	return compact(value, 'item').replace(/[^a-zA-Z0-9_-]+/gu, '-');
}

export function latestDate(...values: unknown[]): string | null {
	return values.map((value) => compact(value, '')).find(Boolean) ?? null;
}

export function compareDatesAsc(left?: string | null, right?: string | null): number {
	const leftTime = Date.parse(left ?? '');
	const rightTime = Date.parse(right ?? '');
	if (!Number.isFinite(leftTime) && !Number.isFinite(rightTime)) return 0;
	if (!Number.isFinite(leftTime)) return 1;
	if (!Number.isFinite(rightTime)) return -1;
	return leftTime - rightTime;
}

export function compareDatesDesc(left?: string | null, right?: string | null): number {
	return compareDatesAsc(right, left);
}

export function uniqueStrings(values: unknown[]): string[] {
	return [...new Set(values.flatMap((value) => typeof value === 'string' && value.trim() ? [value.trim()] : []))];
}

export function toneForState(state: unknown): OperationalTone {
	const value = compact(state, '').toLowerCase();
	if (['completed', 'approved', 'published', 'succeeded', 'success', 'active', 'ready', 'live'].includes(value)) return 'success';
	if (['pending', 'queued', 'waiting', 'waiting_for_approval', 'under_review', 'approval_required', 'draft'].includes(value)) return 'warning';
	if (['failed', 'rejected', 'blocked', 'critical', 'expired'].includes(value)) return 'danger';
	if (['paused', 'escalated', 'running', 'executing', 'verifying', 'claimed'].includes(value)) return 'info';
	return 'default';
}

export function describeState(state: unknown, fallback = 'not recorded'): string {
	return compact(state, fallback).replaceAll('_', ' ');
}

function repositoryLabel(repository: any): string {
	if (typeof repository === 'string') return repository;
	return [repository?.owner, repository?.name ?? repository?.repo ?? repository?.role].filter(Boolean).join('/');
}
