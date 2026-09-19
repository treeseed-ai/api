import { CapacityGovernanceError } from '../../../../database.ts';

type JsonRecord = Record<string, unknown>;

export interface WorkdayProject extends JsonRecord {
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
	'admin', 'agent', 'api', 'cli', 'core', 'sdk', 'ui', 'treedx',
] as const;

export function capacityWorkdayRequestedProjectReferences(parameters: JsonRecord = {}): string[] {
	const requested = parameters.projects ?? parameters.projectSlugs ?? 'all';
	if (requested === 'all' || requested === undefined || requested === null) {
		return [...CANONICAL_WORKDAY_PROJECT_SLUGS];
	}
	const values = Array.isArray(requested) ? requested : String(requested).split(',');
	const references = values.map((value) => String(value).trim()).filter(Boolean).filter((reference) => reference !== 'karyon');
	return references.length > 0 ? [...new Set(references)] : [...CANONICAL_WORKDAY_PROJECT_SLUGS];
}

export function resolveCapacityWorkdayProjects(
	requestedReferences: string[],
	projects: WorkdayProject[],
): WorkdayProject[] {
	const byReference = new Map<string, WorkdayProject>();
	for (const project of projects) {
		for (const reference of new Set([project.id, project.slug].filter((value): value is string => typeof value === 'string' && value.length > 0))) {
			const existing = byReference.get(reference);
			if (existing && existing.id !== project.id) {
				throw new CapacityGovernanceError('capacity_workday_project_ambiguous',
					`Capacity workday project reference ${reference} is ambiguous.`, 409, { reference });
			}
			byReference.set(reference, project);
		}
	}
	const missing = requestedReferences.filter((reference) => !byReference.has(reference));
	if (missing.length > 0) {
		throw new CapacityGovernanceError(
			'capacity_workday_project_missing',
			'Capacity workday requested projects that are no longer available.',
			409,
			{ missing },
		);
	}
	const resolved = requestedReferences.map((reference) => byReference.get(reference)!);
	if (new Set(resolved.map((project) => project.id)).size !== resolved.length) {
		throw new CapacityGovernanceError('capacity_workday_project_duplicate',
			'Capacity workday selected the same project more than once.', 422);
	}
	return resolved;
}

export function capacityWorkdayContentRoot(project: WorkdayProject): string {
	const library = record(record(project.metadata).library);
	if (text(library.role) === 'library') return '.';
	throw new CapacityGovernanceError(
		'capacity_workday_content_path_missing',
		`Capacity workday project ${project.slug ?? project.id} has no TreeDX library binding.`,
		409,
		{ projectId: project.id },
	);
}

export function capacityWorkdayRepositoryId(project: WorkdayProject, parameters: JsonRecord): string {
	const bySlug = record(parameters.repositoryIdsBySlug ?? parameters.treeDxRepositoryIdsBySlug);
	const byProject = record(parameters.repositoryIdsByProjectId);
	const slug = String(project.slug ?? project.id);
	const desired = text(byProject[project.id] ?? bySlug[slug], `treeseed-${slug}`);
	return desired.toLowerCase().replace(/[^a-z0-9_.-]+/gu, '-').replace(/^-+|-+$/gu, '') || 'treeseed-project';
}
