import { CapacityGovernanceError } from '../database.ts';

type JsonRecord = Record<string, unknown>;

export interface WorkdayProject {
	id: string;
	slug?: string | null;
	metadata?: JsonRecord | null;
	architecture?: JsonRecord | null;
}

function record(value: unknown): JsonRecord {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function text(value: unknown, fallback = ''): string {
	return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

export const CANONICAL_WORKDAY_PROJECT_SLUGS = [
	'market', 'admin', 'agent', 'api', 'cli', 'core', 'sdk', 'ui', 'treedx',
] as const;

export function capacityWorkdayRequestedProjectSlugs(parameters: JsonRecord = {}): string[] {
	const requested = parameters.projects ?? parameters.projectSlugs ?? 'all';
	if (requested === 'all' || requested === undefined || requested === null) {
		return [...CANONICAL_WORKDAY_PROJECT_SLUGS];
	}
	const values = Array.isArray(requested) ? requested : String(requested).split(',');
	const slugs = values.map((value) => String(value).trim()).filter(Boolean).filter((slug) => slug !== 'karyon');
	return slugs.length > 0 ? [...new Set(slugs)] : [...CANONICAL_WORKDAY_PROJECT_SLUGS];
}

export function resolveCapacityWorkdayProjects(
	requestedSlugs: string[],
	projects: WorkdayProject[],
): WorkdayProject[] {
	const bySlug = new Map<string, WorkdayProject>();
	for (const project of projects) {
		const slug = String(project.slug ?? project.id);
		if (bySlug.has(slug)) {
			throw new CapacityGovernanceError(
				'capacity_workday_project_ambiguous',
				`Capacity workday project slug ${slug} is ambiguous.`,
				409,
				{ slug },
			);
		}
		bySlug.set(slug, project);
	}
	const missing = requestedSlugs.filter((slug) => !bySlug.has(slug));
	if (missing.length > 0) {
		throw new CapacityGovernanceError(
			'capacity_workday_project_missing',
			'Capacity workday requested projects that are no longer available.',
			409,
			{ missing },
		);
	}
	return requestedSlugs.map((slug) => bySlug.get(slug)!);
}

export function capacityWorkdayContentRoot(project: WorkdayProject): string {
	const architecture = record(project.metadata?.architecture ?? project.architecture);
	const contentPath = text(architecture.contentPath);
	if (contentPath) return contentPath;
	return String(project.slug ?? project.id) === 'market' ? 'src/content' : 'docs/src/content';
}

export function capacityWorkdayRepositoryId(project: WorkdayProject, parameters: JsonRecord): string {
	const bySlug = record(parameters.repositoryIdsBySlug ?? parameters.treeDxRepositoryIdsBySlug);
	const byProject = record(parameters.repositoryIdsByProjectId);
	const slug = String(project.slug ?? project.id);
	const desired = text(byProject[project.id] ?? bySlug[slug], `treeseed-${slug}`);
	return desired.toLowerCase().replace(/[^a-z0-9_.-]+/gu, '-').replace(/^-+|-+$/gu, '') || 'treeseed-project';
}
