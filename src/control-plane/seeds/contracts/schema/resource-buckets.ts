import { errorDiagnostic } from '../errors.js';
import {
SEED_CONTENT_PUBLISH_TARGETS,
SEED_CONTENT_RUNTIME_SOURCES,
SEED_ENVIRONMENTS,
SEED_LOCAL_CONTENT_MATERIALIZATIONS,
SEED_PROJECT_TOPOLOGIES,
type SeedContentPublishTargetKind,
type SeedContentRuntimeSource,
type SeedDiagnostic,
type SeedEnvironment,
type SeedLocalContentMaterialization,
type SeedProjectArchitecture,
type SeedProjectContentPublishTarget,
type SeedProjectRepository,
type SeedProjectTopology,
type SeedRepositoryPolicy,
type SeedResourceBase,
type SeedTeamResource
} from '../types.js';
import { validateRepository } from './parse-project.ts';

export const RESOURCE_BUCKETS = [
	'teams',
	'teamMemberships',
	'projects',
	'hubRepositories',
	'supportRepositories',
	'products',
	'catalogArtifacts',
] as const;

export const SUPPORTED_BUCKETS = new Set(RESOURCE_BUCKETS);

export const ALLOWED_ENVIRONMENTS = new Set<string>(SEED_ENVIRONMENTS);

export const ALLOWED_PROJECT_TOPOLOGIES = new Set<string>(SEED_PROJECT_TOPOLOGIES);

export const ALLOWED_CONTENT_RUNTIME_SOURCES = new Set<string>(SEED_CONTENT_RUNTIME_SOURCES);

export const ALLOWED_LOCAL_CONTENT_MATERIALIZATIONS = new Set<string>(SEED_LOCAL_CONTENT_MATERIALIZATIONS);

export const ALLOWED_CONTENT_PUBLISH_TARGETS = new Set<string>(SEED_CONTENT_PUBLISH_TARGETS);

export const ALLOWED_RECIPE_CHANNELS = new Set<string>(['cli', 'ui', 'api', 'provider-runtime', 'system-check']);

export const ALLOWED_RECIPE_OPERATIONS = new Set<string>([
	'navigate',
	'seed.apply',
	'seed.plan',
	'verify.treedx',
	'project.create',
	'work.start',
	'work.review-decision',
	'knowledge.inspect-artifacts',
	'knowledge.publish',
	'system.health',
]);

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asString(value: unknown) {
	return typeof value === 'string' ? value.trim() : '';
}

export function parseEnvironments(value: unknown, path: string, diagnostics: SeedDiagnostic[]): SeedEnvironment[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) {
		diagnostics.push(errorDiagnostic('seed.invalid_environments', 'Expected an array of environments.', path));
		return undefined;
	}
	const result: SeedEnvironment[] = [];
	for (let index = 0; index < value.length; index += 1) {
		const environment = asString(value[index]);
		if (!ALLOWED_ENVIRONMENTS.has(environment)) {
			diagnostics.push(errorDiagnostic('seed.unknown_environment', `Unknown environment: ${environment || String(value[index])}.`, `${path}[${index}]`));
			continue;
		}
		if (!result.includes(environment as SeedEnvironment)) {
			result.push(environment as SeedEnvironment);
		}
	}
	return result;
}

export function requireString(record: Record<string, unknown>, field: string, path: string, diagnostics: SeedDiagnostic[]) {
	const value = asString(record[field]);
	if (!value) {
		diagnostics.push(errorDiagnostic('seed.missing_field', `Missing required field: ${field}.`, `${path}.${field}`));
	}
	return value;
}

export function numberField(record: Record<string, unknown>, field: string, path: string, diagnostics: SeedDiagnostic[]) {
	const value = record[field];
	if (value === undefined) return undefined;
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		diagnostics.push(errorDiagnostic('seed.invalid_number', `Expected ${field} to be a finite number.`, `${path}.${field}`));
		return undefined;
	}
	return value;
}

export function nonNegativeNumberField(record: Record<string, unknown>, field: string, path: string, diagnostics: SeedDiagnostic[]) {
	const value = numberField(record, field, path, diagnostics);
	if (value !== undefined && value < 0) {
		diagnostics.push(errorDiagnostic('seed.invalid_number', `Expected ${field} to be non-negative.`, `${path}.${field}`));
		return undefined;
	}
	return value;
}

export function objectField(record: Record<string, unknown>, field: string, path: string, diagnostics: SeedDiagnostic[]) {
	const value = record[field];
	if (value === undefined) return undefined;
	if (!isRecord(value)) {
		diagnostics.push(errorDiagnostic('seed.invalid_object', `Expected ${field} to be an object.`, `${path}.${field}`));
		return undefined;
	}
	return value;
}

export function booleanField(record: Record<string, unknown>, field: string, path: string, diagnostics: SeedDiagnostic[]) {
	const value = record[field];
	if (value === undefined) return undefined;
	if (typeof value !== 'boolean') {
		diagnostics.push(errorDiagnostic('seed.invalid_boolean', `Expected ${field} to be a boolean.`, `${path}.${field}`));
		return undefined;
	}
	return value;
}

export function stringArrayField(record: Record<string, unknown>, field: string, path: string, diagnostics: SeedDiagnostic[]) {
	const value = record[field];
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) {
		diagnostics.push(errorDiagnostic('seed.invalid_array', `Expected ${field} to be an array.`, `${path}.${field}`));
		return undefined;
	}
	return value.map((entry) => asString(entry)).filter(Boolean);
}

export function recordArrayField<T extends Record<string, unknown>>(record: Record<string, unknown>, field: string, path: string, diagnostics: SeedDiagnostic[]): T[] {
	const value = record[field];
	if (value === undefined) return [];
	if (!Array.isArray(value)) {
		diagnostics.push(errorDiagnostic('seed.invalid_array', `Expected ${field} to be an array.`, `${path}.${field}`));
		return [];
	}
	const result: T[] = [];
	value.forEach((entry, index) => {
		if (!isRecord(entry)) {
			diagnostics.push(errorDiagnostic('seed.invalid_object', `Expected ${field} entry to be an object.`, `${path}.${field}[${index}]`));
			return;
		}
		result.push(entry as T);
	});
	return result;
}

export function keyBase(record: Record<string, unknown>, path: string, diagnostics: SeedDiagnostic[]): SeedResourceBase {
	const key = requireString(record, 'key', path, diagnostics);
	const environments = parseEnvironments(record.environments, `${path}.environments`, diagnostics);
	return { key, ...(environments ? { environments } : {}) };
}

export function parseTeam(value: unknown, path: string, diagnostics: SeedDiagnostic[]): SeedTeamResource | null {
	if (!isRecord(value)) {
		diagnostics.push(errorDiagnostic('seed.invalid_resource', 'Expected team resource to be an object.', path));
		return null;
	}
	return {
		...keyBase(value, path, diagnostics),
		slug: requireString(value, 'slug', path, diagnostics),
		name: asString(value.name) || undefined,
		displayName: asString(value.displayName) || undefined,
		logoUrl: asString(value.logoUrl) || undefined,
		profileSummary: asString(value.profileSummary) || undefined,
		metadata: objectField(value, 'metadata', path, diagnostics),
	};
}

export function parseTeamMembership(value: unknown, path: string, diagnostics: SeedDiagnostic[]) {
	if (!isRecord(value)) {
		diagnostics.push(errorDiagnostic('seed.invalid_resource', 'Expected team membership resource to be an object.', path));
		return null;
	}
	const email = asString(value.email).toLowerCase();
	const roles = stringArrayField(value, 'roles', path, diagnostics) ?? [];
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) diagnostics.push(errorDiagnostic('seed.invalid_email', 'Team membership email must be valid.', `${path}.email`));
	if (!roles.length) diagnostics.push(errorDiagnostic('seed.missing_roles', 'Team membership requires at least one role.', `${path}.roles`));
	if (roles.some((role) => !/^[a-z][a-z0-9_]*$/u.test(role))) diagnostics.push(errorDiagnostic('seed.invalid_role', 'Team membership roles must be role keys.', `${path}.roles`));
	if (value.missingUser !== undefined && value.missingUser !== 'defer') diagnostics.push(errorDiagnostic('seed.invalid_missing_user_policy', 'missingUser must be defer.', `${path}.missingUser`));
	return { ...keyBase(value, path, diagnostics), team: requireString(value, 'team', path, diagnostics), email, roles: [...new Set(roles)].sort(), missingUser: 'defer' as const };
}

export function parseRepository(value: unknown, path: string, diagnostics: SeedDiagnostic[]): SeedProjectRepository {
	if (!isRecord(value)) {
		diagnostics.push(errorDiagnostic('seed.invalid_repository', 'Expected repository to be an object.', path));
		return { role: '', provider: '', owner: '', name: '', gitUrl: '' };
	}
	const repository: SeedProjectRepository = {
		role: requireString(value, 'role', path, diagnostics),
		provider: requireString(value, 'provider', path, diagnostics),
		owner: requireString(value, 'owner', path, diagnostics),
		name: requireString(value, 'name', path, diagnostics),
		gitUrl: requireString(value, 'gitUrl', path, diagnostics),
		defaultBranch: asString(value.defaultBranch) || undefined,
		checkoutPath: asString(value.checkoutPath) || undefined,
		submodulePath: asString(value.submodulePath) || undefined,
		webUrl: asString(value.webUrl) || undefined,
		repositoryPolicy: parseRepositoryPolicy(value.repositoryPolicy, `${path}.repositoryPolicy`, diagnostics),
	};
	validateRepository(repository, path, diagnostics);
	return repository;
}

export function parseRepositoryPolicy(value: unknown, path: string, diagnostics: SeedDiagnostic[]): SeedRepositoryPolicy | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) {
		diagnostics.push(errorDiagnostic('seed.invalid_repository_policy', 'Expected repositoryPolicy to be an object.', path));
		return undefined;
	}
	const visibility = asString(value.visibility);
	const lifecycle = asString(value.lifecycle);
	const deletionPolicy = asString(value.deletionPolicy);
	const defaultBranch = asString(value.defaultBranch);
	const stagingBranch = asString(value.stagingBranch);
	if (!['public', 'private'].includes(visibility)) diagnostics.push(errorDiagnostic('seed.invalid_repository_policy', 'visibility must be public or private.', `${path}.visibility`));
	if (!['create-or-adopt', 'adopt-only'].includes(lifecycle)) diagnostics.push(errorDiagnostic('seed.invalid_repository_policy', 'lifecycle must be create-or-adopt or adopt-only.', `${path}.lifecycle`));
	if (!['retain', 'archive'].includes(deletionPolicy)) diagnostics.push(errorDiagnostic('seed.invalid_repository_policy', 'deletionPolicy must be retain or archive.', `${path}.deletionPolicy`));
	if (defaultBranch !== 'main') diagnostics.push(errorDiagnostic('seed.invalid_repository_policy', 'defaultBranch must be main.', `${path}.defaultBranch`));
	if (stagingBranch !== 'staging') diagnostics.push(errorDiagnostic('seed.invalid_repository_policy', 'stagingBranch must be staging.', `${path}.stagingBranch`));
	const issues = booleanField(value, 'issues', path, diagnostics);
	const actions = booleanField(value, 'actions', path, diagnostics);
	const workflows = stringArrayField(value, 'workflows', path, diagnostics) ?? [];
	if (issues === undefined) diagnostics.push(errorDiagnostic('seed.missing_field', 'Missing required field: issues.', `${path}.issues`));
	if (actions === undefined) diagnostics.push(errorDiagnostic('seed.missing_field', 'Missing required field: actions.', `${path}.actions`));
	return {
		visibility: visibility === 'public' ? 'public' : 'private',
		lifecycle: lifecycle === 'adopt-only' ? 'adopt-only' : 'create-or-adopt',
		deletionPolicy: deletionPolicy === 'archive' ? 'archive' : 'retain',
		defaultBranch: 'main',
		stagingBranch: 'staging',
		issues: issues ?? false,
		actions: actions ?? false,
		workflows,
	};
}

export function parseProjectContentPublishTarget(value: unknown, path: string, diagnostics: SeedDiagnostic[]): SeedProjectContentPublishTarget | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) {
		diagnostics.push(errorDiagnostic('seed.invalid_project_architecture', 'Expected contentPublishTarget to be an object.', path));
		return undefined;
	}
	const kind = requireString(value, 'kind', path, diagnostics);
	if (kind && !ALLOWED_CONTENT_PUBLISH_TARGETS.has(kind)) {
		diagnostics.push(errorDiagnostic('seed.invalid_project_architecture', `Unsupported content publish target: ${kind}.`, `${path}.kind`));
	}
	return {
		kind: ALLOWED_CONTENT_PUBLISH_TARGETS.has(kind) ? kind as SeedContentPublishTargetKind : 'none',
		bucket: asString(value.bucket) || undefined,
		prefix: asString(value.prefix) || undefined,
		manifestPath: asString(value.manifestPath) || undefined,
		metadata: objectField(value, 'metadata', path, diagnostics),
	};
}

export function parseProjectArchitecture(value: unknown, path: string, diagnostics: SeedDiagnostic[]): SeedProjectArchitecture | null {
	if (!isRecord(value)) {
		diagnostics.push(errorDiagnostic('seed.missing_project_architecture', 'Project resources must declare canonical architecture.', path));
		return null;
	}
	const topology = requireString(value, 'topology', path, diagnostics);
	const contentRuntimeSource = requireString(value, 'contentRuntimeSource', path, diagnostics);
	const localContentMaterialization = requireString(value, 'localContentMaterialization', path, diagnostics);
	if (topology && !ALLOWED_PROJECT_TOPOLOGIES.has(topology)) {
		diagnostics.push(errorDiagnostic('seed.invalid_project_architecture', `Unsupported project topology: ${topology}.`, `${path}.topology`));
	}
	if (contentRuntimeSource && !ALLOWED_CONTENT_RUNTIME_SOURCES.has(contentRuntimeSource)) {
		diagnostics.push(errorDiagnostic('seed.invalid_project_architecture', `Unsupported content runtime source: ${contentRuntimeSource}.`, `${path}.contentRuntimeSource`));
	}
	if (localContentMaterialization && !ALLOWED_LOCAL_CONTENT_MATERIALIZATIONS.has(localContentMaterialization)) {
		diagnostics.push(errorDiagnostic('seed.invalid_project_architecture', `Unsupported local content materialization: ${localContentMaterialization}.`, `${path}.localContentMaterialization`));
	}
	const architecture: SeedProjectArchitecture = {
		topology: ALLOWED_PROJECT_TOPOLOGIES.has(topology) ? topology as SeedProjectTopology : 'single_repository_site',
		rootPath: asString(value.rootPath) || '.',
		sitePath: requireString(value, 'sitePath', path, diagnostics),
		contentPath: asString(value.contentPath) || undefined,
		contentRuntimeSource: ALLOWED_CONTENT_RUNTIME_SOURCES.has(contentRuntimeSource) ? contentRuntimeSource as SeedContentRuntimeSource : 'r2_published_manifest',
		localContentMaterialization: ALLOWED_LOCAL_CONTENT_MATERIALIZATIONS.has(localContentMaterialization) ? localContentMaterialization as SeedLocalContentMaterialization : 'none',
		contentPublishTarget: parseProjectContentPublishTarget(value.contentPublishTarget, `${path}.contentPublishTarget`, diagnostics),
		requiresLocalContentForCi: booleanField(value, 'requiresLocalContentForCi', path, diagnostics),
		requiresLocalContentForDeploy: booleanField(value, 'requiresLocalContentForDeploy', path, diagnostics),
	};
	validateProjectArchitecture(architecture, path, diagnostics);
	return architecture;
}

export function validateProjectArchitecture(architecture: SeedProjectArchitecture, path: string, diagnostics: SeedDiagnostic[]) {
	if (!architecture.sitePath) return;
	if (architecture.topology === 'single_repository_site' && architecture.rootPath === '' && architecture.sitePath === '') {
		diagnostics.push(errorDiagnostic('seed.invalid_project_architecture', 'single_repository_site projects must have repository-relative rootPath and sitePath values.', path));
	}
	if (architecture.topology === 'split_site_content' && !architecture.contentPath && architecture.contentRuntimeSource === 'local_directory') {
		diagnostics.push(errorDiagnostic('seed.invalid_project_architecture', 'split_site_content projects using local_directory content must declare contentPath.', `${path}.contentPath`));
	}
	if (
		!architecture.requiresLocalContentForCi
		&& !architecture.requiresLocalContentForDeploy
		&& architecture.contentRuntimeSource !== 'local_directory'
		&& ['managed_clone', 'submodule'].includes(architecture.localContentMaterialization)
	) {
		diagnostics.push(errorDiagnostic(
			'seed.local_content_required_by_default',
			'CI/deploy defaults must not require managed_clone or submodule content unless requiresLocalContentForCi or requiresLocalContentForDeploy is explicit.',
			`${path}.localContentMaterialization`,
		));
	}
	if (architecture.contentPublishTarget?.kind === 'cloudflare_r2' && architecture.contentRuntimeSource === 'local_directory' && !architecture.contentPath) {
		diagnostics.push(errorDiagnostic('seed.invalid_project_architecture', 'Cloudflare R2 content publish targets need a contentPath when runtime source is local_directory.', `${path}.contentPath`));
	}
}
