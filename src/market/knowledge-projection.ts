import {
	anchorPart,
	artifactCategoryFromType,
	categorySlug,
	compact,
	compareDatesDesc,
	describeState,
	normalizeOperationalArtifact,
	safeArray,
	titleFromKind,
	toneForState,
	type OperationalArtifact,
	type OperationalTone,
} from './operational-artifacts.js';

export interface KnowledgeMetric {
	label: string;
	value: string | number;
	description?: string;
	tone?: OperationalTone;
}

export interface KnowledgeRelationshipSummary {
	workdays: number;
	repositories: number;
	approvals: number;
	releases: number;
	decisions: number;
}

export interface KnowledgeTimelineEvent {
	id: string;
	title: string;
	description?: string;
	category: 'knowledge' | 'governance' | 'execution' | 'infrastructure' | 'research';
	phase: 'knowledge' | 'governance' | 'implementation' | 'research';
	state?: string;
	tone?: OperationalTone;
	timestamp?: string | null;
	href?: string;
	meta?: string;
}

export interface KnowledgeArtifactProjection extends OperationalArtifact {
	sourceCategory: string;
	sourceSlug: string;
	metadata: {
		producedDuring?: string | null;
		generatedBy?: string | null;
		approvedBy?: string | null;
		approvalStatus?: string | null;
		projectName?: string | null;
		createdAt?: string | null;
	};
	relationships: {
		workdays: any[];
		repositories: any[];
		approvals: any[];
		releases: any[];
		relatedDecisions: any[];
		relatedReports: any[];
	};
	timeline: KnowledgeTimelineEvent[];
}

export interface KnowledgeProjection {
	metrics: KnowledgeMetric[];
	categories: string[];
	artifacts: KnowledgeArtifactProjection[];
	imports: KnowledgeArtifactProjection[];
	reports: KnowledgeArtifactProjection[];
	releases: KnowledgeArtifactProjection[];
	relationshipSummary: KnowledgeRelationshipSummary;
}

interface KnowledgeProjectionInput {
	store: any;
	principal?: any;
	teams?: any[];
	projects?: any[];
	contentEntries?: any[];
}

interface KnowledgeArtifactInput extends KnowledgeProjectionInput {
	artifactId: string;
}

interface KnowledgeBundle {
	project: any;
	summary: any | null;
	agents: any | null;
	workdays: any[];
	approvals: any[];
	releases: any | null;
}

const canonicalCategories = ['Architecture', 'Operations', 'Research', 'Implementation', 'Decisions', 'Reports', 'Releases', 'Imports'];

export async function buildKnowledgeProjection(input: KnowledgeProjectionInput): Promise<KnowledgeProjection> {
	const bundles = await loadKnowledgeBundles(input);
	const packs = input.store && typeof input.store.listKnowledgePacks === 'function'
		? await input.store.listKnowledgePacks(input.principal).catch(() => [])
		: [];
	const contentArtifacts = safeArray(input.contentEntries).map((entry) => artifactFromContentEntry(entry));
	const operationalArtifacts = bundles.flatMap((bundle) => artifactsForBundle(bundle));
	const importArtifacts = [
		...safeArray(packs).map((pack) => artifactFromImport(pack)),
		...contentArtifacts.filter((artifact) => artifact.category === 'Imports'),
	];
	const allArtifacts = dedupeArtifacts([...operationalArtifacts, ...contentArtifacts.filter((artifact) => artifact.category !== 'Imports'), ...importArtifacts])
		.sort((left, right) => compareDatesDesc(left.createdAt, right.createdAt));
	const withRelationships = allArtifacts.map((artifact) => attachRelationships(artifact, bundles, allArtifacts));
	const imports = withRelationships.filter((artifact) => artifact.category === 'Imports');
	const reports = withRelationships.filter((artifact) => artifact.category === 'Reports' || artifact.type === 'Report');
	const releases = withRelationships.filter((artifact) => artifact.category === 'Releases' || artifact.type === 'Release Note');
	const repositoryCount = new Set(withRelationships.flatMap((artifact) => artifact.repositories)).size;
	const approvalCount = new Set(withRelationships.flatMap((artifact) => artifact.relationships.approvals.map((approval) => compact(approval.id)))).size;
	const releaseCount = new Set(withRelationships.flatMap((artifact) => artifact.relationships.releases.map((release) => compact(release.id, compact(release.releaseTag))))).size;
	const decisionCount = withRelationships.filter((artifact) => artifact.category === 'Decisions').length;

	return {
		metrics: [
			{ label: 'Knowledge artifacts', value: withRelationships.filter((artifact) => artifact.category !== 'Imports').length, tone: withRelationships.length ? 'accent' : 'muted' },
			{ label: 'Operational imports', value: imports.length },
			{ label: 'Referenced repositories', value: repositoryCount },
			{ label: 'Linked approvals', value: approvalCount, tone: approvalCount ? 'warning' : 'muted' },
			{ label: 'Releases', value: releases.length, tone: releases.length ? 'success' : 'muted' },
		],
		categories: canonicalCategories,
		artifacts: withRelationships,
		imports,
		reports,
		releases,
		relationshipSummary: {
			workdays: new Set(withRelationships.map((artifact) => artifact.workDayId).filter(Boolean)).size,
			repositories: repositoryCount,
			approvals: approvalCount,
			releases: releaseCount,
			decisions: decisionCount,
		},
	};
}

export async function buildKnowledgeArtifactProjection(input: KnowledgeArtifactInput): Promise<KnowledgeArtifactProjection | null> {
	const projection = await buildKnowledgeProjection(input);
	const target = compact(input.artifactId);
	return projection.artifacts.find((artifact) =>
		artifact.id === target
		|| artifact.slug === target
		|| `${categorySlug(artifact.category)}/${artifact.slug}` === target
		|| anchorPart(artifact.id).toLowerCase() === target.toLowerCase()
	) ?? null;
}

async function loadKnowledgeBundles(input: KnowledgeProjectionInput): Promise<KnowledgeBundle[]> {
	const store = input.store;
	if (!store) return [];
	return Promise.all(safeArray(input.projects).map(async (project: any) => {
		const [summary, agents, workdays, approvals, releases] = await Promise.all([
			typeof store.getProjectSummary === 'function' ? store.getProjectSummary(project.id, input.principal).catch(() => null) : null,
			typeof store.getProjectAgentsSummary === 'function' ? store.getProjectAgentsSummary(project.id, input.principal).catch(() => null) : null,
			typeof store.listProjectWorkdaySummaries === 'function' ? store.listProjectWorkdaySummaries(project.id, null).catch(() => []) : [],
			typeof store.listApprovalRequestsForProject === 'function' ? store.listApprovalRequestsForProject(project.id, 200).catch(() => []) : [],
			typeof store.getProjectReleasesSummary === 'function' ? store.getProjectReleasesSummary(project.id, input.principal).catch(() => null) : null,
		]);
		return {
			project,
			summary,
			agents,
			workdays: safeArray(workdays),
			approvals: safeArray(approvals),
			releases,
		};
	}));
}

function artifactsForBundle(bundle: KnowledgeBundle): KnowledgeArtifactProjection[] {
	const repositories = safeArray(bundle.summary?.repositories);
	const producedBy = compact(bundle.project?.name, compact(bundle.project?.slug, 'Operational work'));
	const generated = safeArray(bundle.agents?.generatedArtifacts).map((artifact) => artifactFromOperationalSource(bundle, artifact, producedBy, repositories, null));
	const drafts = safeArray(bundle.agents?.knowledgeDrafts).map((entry) => artifactFromOperationalSource(bundle, entry?.knowledgeDraft ?? entry, producedBy, repositories, 'Knowledge Entry'));
	const reports = safeArray(bundle.agents?.runtimeReports).map((artifact) => artifactFromOperationalSource(bundle, artifact, producedBy, repositories, 'Report'));
	const research = safeArray(bundle.agents?.researchNotes).map((artifact) => artifactFromOperationalSource(bundle, artifact, producedBy, repositories, 'Research Summary'));
	const optimization = safeArray(bundle.agents?.optimizationReports).map((artifact) => artifactFromOperationalSource(bundle, artifact, producedBy, repositories, 'Report'));
	const releases = releaseArtifacts(bundle, repositories);
	return [...generated, ...drafts, ...reports, ...research, ...optimization, ...releases];
}

function artifactFromOperationalSource(bundle: KnowledgeBundle, artifact: any, producedBy: string, repositories: any[], defaultKind: string | null): KnowledgeArtifactProjection {
	const normalized = normalizeOperationalArtifact({
		artifact,
		workdayId: artifact?.workDayId ?? artifact?.workdayId,
		projectId: bundle.project?.id,
		projectName: producedBy,
		producedBy,
		defaultKind: defaultKind ?? artifact?.artifactKind ?? artifact?.kind,
		repositories,
	});
	return baseKnowledgeArtifact(normalized, bundle, []);
}

function releaseArtifacts(bundle: KnowledgeBundle, repositories: any[]): KnowledgeArtifactProjection[] {
	const history = [
		...safeArray(bundle.releases?.history),
		...(bundle.releases?.latest ? [bundle.releases.latest] : []),
	].filter(Boolean);
	return dedupeBy(history, (release) => compact(release?.id, compact(release?.releaseTag, compact(release?.deploymentId, 'release'))))
		.map((release: any) => {
			const tag = compact(release?.releaseTag, compact(release?.tag, compact(release?.id, 'release')));
			const artifact = normalizeOperationalArtifact({
				artifact: {
					id: `release-${tag}`,
					title: `Release ${tag}`,
					description: compact(release?.summary, `Release state: ${describeState(release?.status, 'recorded')}.`),
					state: compact(release?.status, 'recorded'),
					artifactKind: 'release_note',
					createdAt: release?.createdAt ?? release?.completedAt ?? release?.updatedAt,
				},
				projectId: bundle.project?.id,
				projectName: compact(bundle.project?.name, compact(bundle.project?.slug, 'Project')),
				producedBy: 'Release operations',
				repositories,
				categoryOverride: 'Releases',
			});
			return baseKnowledgeArtifact(artifact, bundle, [release]);
		});
}

function artifactFromContentEntry(entry: any): KnowledgeArtifactProjection {
	const collection = compact(entry?.collection, compact(entry?.sourceCollection, 'docs'));
	const data = entry?.data ?? {};
	const id = compact(data?.id, `${collection}:${entry?.slug ?? entry?.id ?? data?.slug ?? data?.title ?? 'entry'}`);
	const category = categoryForContent(collection, data, entry);
	const normalized = normalizeOperationalArtifact({
		artifact: {
			id,
			title: data?.title ?? entry?.slug ?? entry?.id,
			description: data?.summary ?? data?.description ?? `${titleFromKind(collection)} operational entry.`,
			state: data?.status ?? data?.decisionType ?? 'published',
			artifactKind: collection,
			createdAt: data?.date ?? data?.updatedAt,
		},
		producedBy: compact(data?.authority, compact(data?.primaryContributor, 'Content operations')),
		categoryOverride: category,
	});
	return {
		...baseKnowledgeArtifact(normalized, null, []),
		sourceCategory: category,
		sourceSlug: compact(entry?.slug, anchorPart(id).toLowerCase()),
		metadata: {
			...baseKnowledgeArtifact(normalized, null, []).metadata,
			generatedBy: compact(data?.primaryContributor, compact(data?.authority, 'Content operations')),
		},
		relationships: {
			workdays: [],
			repositories: [],
			approvals: [],
			releases: [],
			relatedDecisions: safeArray(data?.relatedDecisions).map((slug: any) => relationshipRecord(slug, 'Decision', `/app/knowledge/decisions/${encodeURIComponent(anchorPart(slug).toLowerCase())}`)),
			relatedReports: [],
		},
		timeline: [artifactEvent(normalized, 'Knowledge entry recorded', category)],
	};
}

function artifactFromImport(pack: any): KnowledgeArtifactProjection {
	const id = compact(pack?.id, compact(pack?.slug, compact(pack?.name, 'import')));
	const normalized = normalizeOperationalArtifact({
		artifact: {
			id,
			title: pack?.name ?? pack?.title ?? pack?.slug,
			description: pack?.summary ?? 'Operational import available for future workdays.',
			state: pack?.visibility ?? 'available',
			artifactKind: 'knowledge_import',
			createdAt: pack?.updatedAt ?? pack?.createdAt,
		},
		producedBy: 'Operational resources',
		categoryOverride: 'Imports',
	});
	return {
		...baseKnowledgeArtifact(normalized, null, []),
		sourceCategory: 'Imports',
		sourceSlug: normalized.slug,
	};
}

function baseKnowledgeArtifact(normalized: OperationalArtifact, bundle: KnowledgeBundle | null, releaseRecords: any[]): KnowledgeArtifactProjection {
	return {
		...normalized,
		sourceCategory: normalized.category,
		sourceSlug: normalized.slug,
		metadata: {
			producedDuring: normalized.workDayId || null,
			generatedBy: normalized.producedBy,
			approvedBy: null,
			approvalStatus: normalized.approvalState ?? null,
			projectName: normalized.projectName ?? (compact(bundle?.project?.name, compact(bundle?.project?.slug, '')) || null),
			createdAt: normalized.createdAt,
		},
		relationships: {
			workdays: [],
			repositories: safeArray(bundle?.summary?.repositories),
			approvals: [],
			releases: releaseRecords,
			relatedDecisions: [],
			relatedReports: [],
		},
		timeline: [artifactEvent(normalized, 'Knowledge artifact produced', normalized.category)],
	};
}

function attachRelationships(artifact: KnowledgeArtifactProjection, bundles: KnowledgeBundle[], allArtifacts: KnowledgeArtifactProjection[]): KnowledgeArtifactProjection {
	const bundle = bundles.find((entry) => entry.project?.id === artifact.projectId)
		?? bundles.find((entry) => entry.workdays.some((workday) => workdayRef(workday) === artifact.workDayId || compact(workday?.id) === artifact.workDayId))
		?? null;
	const workdays = bundle
		? safeArray(bundle.workdays).filter((workday) => artifact.workDayId && (workdayRef(workday) === artifact.workDayId || compact(workday?.id) === artifact.workDayId))
		: [];
	const approvals = bundle
		? safeArray(bundle.approvals).filter((approval) => {
			const approvalWorkday = workdayRef(approval);
			const approvalTask = compact(approval?.taskId, compact(approval?.task_id, ''));
			return (artifact.workDayId && approvalWorkday === artifact.workDayId) || (artifact.taskId && approvalTask === artifact.taskId);
		})
		: [];
	const repositoryObjects = repositoriesForArtifact(artifact, bundle);
	const releases = artifact.category === 'Releases'
		? artifact.relationships.releases
		: safeArray(bundle?.releases?.history).filter((release) => releaseMatchesArtifact(release, artifact));
	const relatedDecisions = allArtifacts.filter((entry) => entry.category === 'Decisions' && entry.id !== artifact.id && relatedByWorkdayOrRepository(entry, artifact));
	const relatedReports = allArtifacts.filter((entry) => entry.category === 'Reports' && entry.id !== artifact.id && relatedByWorkdayOrRepository(entry, artifact));
	const approvedBy = approvals.find((approval) => ['approved', 'published'].includes(compact(approval?.state).toLowerCase()))?.decidedBy ?? null;
	const timeline = [
		artifactEvent(artifact, 'Knowledge artifact produced', artifact.category),
		...approvals.map(approvalEvent),
		...releases.map(releaseEvent),
	].sort((left, right) => compareDatesDesc(left.timestamp, right.timestamp));

	return {
		...artifact,
		metadata: {
			...artifact.metadata,
			producedDuring: artifact.workDayId || workdays[0]?.workDayId || null,
			approvedBy: compact(approvedBy, '') || null,
			approvalStatus: approvals[0]?.state ?? artifact.metadata.approvalStatus ?? null,
			projectName: artifact.metadata.projectName ?? (compact(bundle?.project?.name, compact(bundle?.project?.slug, '')) || null),
		},
		relationships: {
			workdays,
			repositories: repositoryObjects,
			approvals,
			releases,
			relatedDecisions,
			relatedReports,
		},
		timeline,
	};
}

function repositoriesForArtifact(artifact: KnowledgeArtifactProjection, bundle: KnowledgeBundle | null): any[] {
	const repositoryLabels = new Set(artifact.repositories);
	const repositories = safeArray(bundle?.summary?.repositories);
	if (repositoryLabels.size === 0) return repositories;
	const matched = repositories.filter((repository) => repositoryLabels.has(repositoryLabel(repository)));
	return matched.length ? matched : artifact.repositories.map((label) => ({ id: label, title: label, name: label, status: 'referenced' }));
}

function artifactEvent(artifact: OperationalArtifact, title: string, category: string): KnowledgeTimelineEvent {
	return {
		id: `knowledge-${anchorPart(artifact.id)}`,
		title,
		description: artifact.title,
		category: category === 'Research' ? 'research' : 'knowledge',
		phase: category === 'Research' ? 'research' : 'knowledge',
		state: artifact.state,
		tone: artifact.tone,
		timestamp: artifact.createdAt,
		href: artifact.href,
		meta: artifact.type,
	};
}

function approvalEvent(approval: any): KnowledgeTimelineEvent {
	const id = compact(approval?.id, 'approval');
	return {
		id: `approval-${id}`,
		title: compact(approval?.title, 'Approval requested'),
		description: compact(approval?.summary, 'Governance review attached to this knowledge artifact.'),
		category: 'governance',
		phase: 'governance',
		state: compact(approval?.state, 'pending'),
		tone: toneForState(approval?.state ?? approval?.severity),
		timestamp: approval?.decidedAt ?? approval?.updatedAt ?? approval?.createdAt,
		href: `/app/work/decisions/${encodeURIComponent(id)}`,
		meta: describeState(approval?.severity, 'review'),
	};
}

function releaseEvent(release: any): KnowledgeTimelineEvent {
	const tag = compact(release?.releaseTag, compact(release?.tag, compact(release?.id, 'release')));
	return {
		id: `release-${anchorPart(tag)}`,
		title: `Release ${tag}`,
		description: describeState(release?.status, 'Release recorded'),
		category: 'infrastructure',
		phase: 'implementation',
		state: compact(release?.status, 'recorded'),
		tone: toneForState(release?.status),
		timestamp: release?.completedAt ?? release?.updatedAt ?? release?.createdAt,
		href: `/app/knowledge/releases/release-${encodeURIComponent(anchorPart(tag).toLowerCase())}`,
		meta: compact(release?.environment, 'release'),
	};
}

function categoryForContent(collection: string, data: any, entry: any): string {
	const haystack = `${collection} ${data?.title ?? ''} ${data?.domain ?? ''} ${safeArray(data?.tags).join(' ')} ${entry?.id ?? ''}`.toLowerCase();
	if (collection === 'decisions') return 'Decisions';
	if (collection === 'questions') return 'Research';
	if (collection === 'proposals') return 'Implementation';
	if (collection === 'books' || haystack.includes('architecture')) return 'Architecture';
	if (collection === 'knowledge_packs') return 'Imports';
	return artifactCategoryFromType(titleFromKind(collection));
}

function releaseMatchesArtifact(release: any, artifact: KnowledgeArtifactProjection): boolean {
	const tag = compact(release?.releaseTag, compact(release?.tag, compact(release?.id, '')));
	return Boolean(tag && (artifact.id.includes(tag) || artifact.title.includes(tag)));
}

function relatedByWorkdayOrRepository(left: KnowledgeArtifactProjection, right: KnowledgeArtifactProjection): boolean {
	if (left.workDayId && right.workDayId && left.workDayId === right.workDayId) return true;
	return left.repositories.some((repository) => right.repositories.includes(repository));
}

function relationshipRecord(value: unknown, title: string, href?: string) {
	const id = compact(value, title);
	return { id, title: titleFromKind(id, title), href };
}

function workdayRef(value: any) {
	return compact(value?.workDayId, compact(value?.work_day_id, compact(value?.id, '')));
}

function repositoryLabel(repository: any): string {
	if (typeof repository === 'string') return repository;
	return [repository?.owner, repository?.name ?? repository?.repo ?? repository?.role].filter(Boolean).join('/');
}

function dedupeArtifacts(artifacts: KnowledgeArtifactProjection[]): KnowledgeArtifactProjection[] {
	return dedupeBy(artifacts, (artifact) => artifact.id);
}

function dedupeBy<T>(items: T[], key: (item: T) => string): T[] {
	const seen = new Set<string>();
	const result: T[] = [];
	for (const item of items) {
		const id = key(item);
		if (!id || seen.has(id)) continue;
		seen.add(id);
		result.push(item);
	}
	return result;
}
