import { errorDiagnostic } from '../errors.js';
import {
type SeedCatalogArtifactResource,
type SeedDiagnostic,
type SeedEnvironment,
type SeedHubRepositoryResource,
type SeedOperationRecipe,
type SeedOperationRecipeArtifact,
type SeedOperationRecipeAssertion,
type SeedOperationRecipeChannel,
type SeedOperationRecipeCommand,
type SeedOperationRecipeStep,
type SeedProductResource,
type SeedProjectRepository,
type SeedProjectResource,
type SeedSupportRepositoryResource,
} from '../types.js';
import { ALLOWED_RECIPE_CHANNELS,ALLOWED_RECIPE_OPERATIONS,asString,isRecord,keyBase,objectField,parseEnvironments,parseProjectArchitecture,parseRepository,parseRepositoryPolicy,recordArrayField,requireString,stringArrayField } from './resource-buckets.ts';

const CREDENTIAL_REF_PATTERN = /^(?:env|secret|provider-session):[A-Za-z0-9_./:-]+$/u;

export function parseProject(value: unknown, path: string, diagnostics: SeedDiagnostic[]): SeedProjectResource | null {
	if (!isRecord(value)) {
		diagnostics.push(errorDiagnostic('seed.invalid_resource', 'Expected project resource to be an object.', path));
		return null;
	}
	const metadata = objectField(value, 'metadata', path, diagnostics);
	if (metadata?.repositoryTopology !== undefined || metadata?.contentRoot !== undefined || metadata?.sitePath !== undefined || metadata?.contentPath !== undefined) {
		diagnostics.push(errorDiagnostic(
			'seed.legacy_project_topology_metadata',
			'Project topology must be declared in project.architecture, not metadata.',
			`${path}.metadata`,
		));
	}
	return {
		...keyBase(value, path, diagnostics),
		team: requireString(value, 'team', path, diagnostics),
		slug: requireString(value, 'slug', path, diagnostics),
		name: requireString(value, 'name', path, diagnostics),
		description: asString(value.description) || undefined,
		kind: asString(value.kind) || undefined,
		repository: parseRepository(value.repository, `${path}.repository`, diagnostics),
		architecture: parseProjectArchitecture(value.architecture, `${path}.architecture`, diagnostics) ?? {
			topology: 'single_repository_site',
			rootPath: '.',
			sitePath: '',
			contentRuntimeSource: 'r2_published_manifest',
			localContentMaterialization: 'none',
		},
		metadata,
	};
}

export function parseHubRepository(value: unknown, path: string, diagnostics: SeedDiagnostic[]): SeedHubRepositoryResource | null {
	if (!isRecord(value)) {
		diagnostics.push(errorDiagnostic('seed.invalid_resource', 'Expected hub repository resource to be an object.', path));
		return null;
	}
	const repository: SeedHubRepositoryResource = {
		...keyBase(value, path, diagnostics),
		project: requireString(value, 'project', path, diagnostics),
		role: requireString(value, 'role', path, diagnostics),
		provider: requireString(value, 'provider', path, diagnostics),
		owner: requireString(value, 'owner', path, diagnostics),
		name: requireString(value, 'name', path, diagnostics),
		gitUrl: requireString(value, 'gitUrl', path, diagnostics),
		defaultBranch: asString(value.defaultBranch) || undefined,
		currentBranch: asString(value.currentBranch) || undefined,
		submodulePath: asString(value.submodulePath) || undefined,
		status: asString(value.status) || undefined,
		accessPolicy: objectField(value, 'accessPolicy', path, diagnostics),
		releasePolicy: objectField(value, 'releasePolicy', path, diagnostics),
		publishPolicy: objectField(value, 'publishPolicy', path, diagnostics),
		metadata: objectField(value, 'metadata', path, diagnostics),
		repositoryPolicy: parseRepositoryPolicy(value.repositoryPolicy, `${path}.repositoryPolicy`, diagnostics),
	};
	validateRepository({
		role: repository.role,
		provider: repository.provider,
		owner: repository.owner,
		name: repository.name,
		gitUrl: repository.gitUrl,
		defaultBranch: repository.defaultBranch,
		submodulePath: repository.submodulePath,
		repositoryPolicy: repository.repositoryPolicy,
	}, path, diagnostics);
	return repository;
}

export function parseSupportRepository(value: unknown, path: string, diagnostics: SeedDiagnostic[]): SeedSupportRepositoryResource | null {
	if (!isRecord(value)) {
		diagnostics.push(errorDiagnostic('seed.invalid_resource', 'Expected support repository resource to be an object.', path));
		return null;
	}
	const repository: SeedSupportRepositoryResource = {
		...keyBase(value, path, diagnostics),
		provider: requireString(value, 'provider', path, diagnostics),
		owner: requireString(value, 'owner', path, diagnostics),
		name: requireString(value, 'name', path, diagnostics),
		gitUrl: requireString(value, 'gitUrl', path, diagnostics),
		defaultBranch: asString(value.defaultBranch) || undefined,
		description: asString(value.description) || undefined,
		metadata: objectField(value, 'metadata', path, diagnostics),
		repositoryPolicy: parseRepositoryPolicy(value.repositoryPolicy, `${path}.repositoryPolicy`, diagnostics),
	};
	validateRepository({ role: 'support', ...repository }, path, diagnostics);
	return repository;
}

export function parseProduct(value: unknown, path: string, diagnostics: SeedDiagnostic[]): SeedProductResource | null {
	if (!isRecord(value)) {
		diagnostics.push(errorDiagnostic('seed.invalid_resource', 'Expected product resource to be an object.', path));
		return null;
	}
	return {
		...keyBase(value, path, diagnostics),
		team: requireString(value, 'team', path, diagnostics),
		kind: requireString(value, 'kind', path, diagnostics),
		slug: requireString(value, 'slug', path, diagnostics),
		title: requireString(value, 'title', path, diagnostics),
		summary: asString(value.summary) || undefined,
		visibility: asString(value.visibility) || undefined,
		listingEnabled: typeof value.listingEnabled === 'boolean' ? value.listingEnabled : undefined,
		offerMode: asString(value.offerMode) || undefined,
		manifestKey: asString(value.manifestKey) || undefined,
		artifactKey: asString(value.artifactKey) || undefined,
		searchText: asString(value.searchText) || undefined,
		metadata: objectField(value, 'metadata', path, diagnostics),
	};
}

export function parseCatalogArtifact(value: unknown, path: string, diagnostics: SeedDiagnostic[]): SeedCatalogArtifactResource | null {
	if (!isRecord(value)) {
		diagnostics.push(errorDiagnostic('seed.invalid_resource', 'Expected catalog artifact resource to be an object.', path));
		return null;
	}
	if (value.content !== undefined || value.bytes !== undefined || value.data !== undefined) {
		diagnostics.push(errorDiagnostic('seed.inline_artifact_content', 'Catalog artifact resources must reference content keys, not inline bytes/content.', path));
	}
	return {
		...keyBase(value, path, diagnostics),
		product: requireString(value, 'product', path, diagnostics),
		version: requireString(value, 'version', path, diagnostics),
		kind: requireString(value, 'kind', path, diagnostics),
		contentKey: requireString(value, 'contentKey', path, diagnostics),
		manifestKey: asString(value.manifestKey) || undefined,
		publishedAt: asString(value.publishedAt) || undefined,
		metadata: objectField(value, 'metadata', path, diagnostics),
	};
}

export function parseRecipeCommand(value: unknown, path: string, diagnostics: SeedDiagnostic[]): SeedOperationRecipeCommand | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) {
		diagnostics.push(errorDiagnostic('seed.invalid_object', 'Expected command to be an object.', path));
		return undefined;
	}
	const argv = stringArrayField(value, 'argv', path, diagnostics);
	if (argv.length === 0) {
		diagnostics.push(errorDiagnostic('seed.recipe_command_missing_argv', 'Recipe command must include argv.', `${path}.argv`));
	}
	return { argv };
}

export function parseRecipeStep(value: unknown, path: string, diagnostics: SeedDiagnostic[]): SeedOperationRecipeStep | null {
	if (!isRecord(value)) {
		diagnostics.push(errorDiagnostic('seed.invalid_recipe_step', 'Expected operation recipe step to be an object.', path));
		return null;
	}
	const channel = requireString(value, 'channel', path, diagnostics);
	if (channel && !ALLOWED_RECIPE_CHANNELS.has(channel)) {
		diagnostics.push(errorDiagnostic('seed.recipe_unknown_channel', `Unsupported operation recipe channel: ${channel}.`, `${path}.channel`));
	}
	const operation = requireString(value, 'operation', path, diagnostics);
	if (operation && !ALLOWED_RECIPE_OPERATIONS.has(operation)) {
		diagnostics.push(errorDiagnostic('seed.recipe_unknown_operation', `Unsupported operation recipe operation: ${operation}.`, `${path}.operation`));
	}
	return {
		id: requireString(value, 'id', path, diagnostics),
		title: requireString(value, 'title', path, diagnostics),
		actor: asString(value.actor) || undefined,
		channel: ALLOWED_RECIPE_CHANNELS.has(channel) ? channel as SeedOperationRecipeChannel : 'system-check',
		operation,
		dependsOn: stringArrayField(value, 'dependsOn', path, diagnostics) ?? [],
		uses: stringArrayField(value, 'uses', path, diagnostics) ?? [],
		target: asString(value.target) || undefined,
		command: parseRecipeCommand(value.command, `${path}.command`, diagnostics),
		assertions: recordArrayField<SeedOperationRecipeAssertion>(value, 'assertions', path, diagnostics),
		artifacts: recordArrayField<SeedOperationRecipeArtifact>(value, 'artifacts', path, diagnostics),
	};
}

export function parseOperationRecipe(value: unknown, path: string, diagnostics: SeedDiagnostic[], manifestEnvironments: SeedEnvironment[]): SeedOperationRecipe | null {
	if (!isRecord(value)) {
		diagnostics.push(errorDiagnostic('seed.invalid_recipe', 'Expected operation recipe to be an object.', path));
		return null;
	}
	const environments = parseEnvironments(value.environments, `${path}.environments`, diagnostics) ?? manifestEnvironments;
	const recipe: SeedOperationRecipe = {
		id: requireString(value, 'id', path, diagnostics),
		title: requireString(value, 'title', path, diagnostics),
		environments,
		entrypoints: stringArrayField(value, 'entrypoints', path, diagnostics) ?? [],
		steps: Array.isArray(value.steps)
			? value.steps.map((step, index) => parseRecipeStep(step, `${path}.steps[${index}]`, diagnostics)).filter((step): step is SeedOperationRecipeStep => Boolean(step))
			: [],
	};
	if (!Array.isArray(value.steps)) {
		diagnostics.push(errorDiagnostic('seed.invalid_recipe_steps', 'Operation recipe steps must be an array.', `${path}.steps`));
	}
	return recipe;
}

export function validateRepository(repository: SeedProjectRepository, path: string, diagnostics: SeedDiagnostic[]) {
	if (!repository.gitUrl) return;
	if (/^(?:\.{1,2}\/?|packages\/|\/)/u.test(repository.gitUrl) || !/(?:^[a-z][a-z0-9+.-]*:\/\/|^git@)/iu.test(repository.gitUrl)) {
		diagnostics.push(errorDiagnostic('seed.invalid_git_url', 'Project repository gitUrl must be a remote Git URL, not a local path.', `${path}.gitUrl`));
		return;
	}
	if (repository.provider !== 'github') return;
	const parsed = parseGitHubRepository(repository.gitUrl);
	if (!parsed) {
		diagnostics.push(errorDiagnostic('seed.invalid_git_url', 'GitHub repository gitUrl must identify an owner and repository.', `${path}.gitUrl`));
		return;
	}
	if (parsed.owner !== repository.owner || parsed.name !== repository.name) {
		diagnostics.push(errorDiagnostic(
			'seed.repository_metadata_mismatch',
			`gitUrl points to ${parsed.owner}/${parsed.name}, but owner/name are ${repository.owner}/${repository.name}.`,
			path,
		));
	}
}

export function parseGitHubRepository(gitUrl: string): { owner: string; name: string } | null {
	const ssh = /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/u.exec(gitUrl);
	if (ssh) return { owner: ssh[1]!, name: ssh[2]! };
	try {
		const url = new URL(gitUrl);
		if (url.hostname !== 'github.com') return null;
		const [owner, rawName] = url.pathname.replace(/^\/+/u, '').split('/');
		if (!owner || !rawName) return null;
		return { owner, name: rawName.replace(/\.git$/u, '') };
	} catch {
		return null;
	}
}

export function walkForSecrets(value: unknown, path: string, diagnostics: SeedDiagnostic[]) {
	if (typeof value === 'string') {
		if (/(?:ghp_|github_pat_|sk-[A-Za-z0-9]|xox[baprs]-|-----BEGIN [A-Z ]*PRIVATE KEY-----)/u.test(value)) {
			diagnostics.push(errorDiagnostic('seed.secret_value', 'Manifest appears to contain a raw secret value.', path));
		}
		return;
	}
	if (Array.isArray(value)) {
		value.forEach((entry, index) => walkForSecrets(entry, `${path}[${index}]`, diagnostics));
		return;
	}
	if (!isRecord(value)) return;
	for (const [key, entry] of Object.entries(value)) {
		const nextPath = path ? `${path}.${key}` : key;
		if (typeof entry === 'string' && /(?:api[_-]?key|token|private[_-]?key|password|secret|credential)/iu.test(key)) {
			if (!CREDENTIAL_REF_PATTERN.test(entry)) {
				diagnostics.push(errorDiagnostic('seed.secret_field', `Field ${key} must use a credential reference, not an inline value.`, nextPath));
			}
		}
		walkForSecrets(entry, nextPath, diagnostics);
	}
}
