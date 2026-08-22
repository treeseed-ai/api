interface ProjectContentRepositoryTopology {
	accessMode: 'treedx';
	githubUrl: string | null;
	defaultBranch: string | null;
	ref: string | null;
	contentPath: string;
	treeDx: { instanceId: string; libraryId: string; repositoryId: string | null; baseUrl: string | null };
	remote: {
		bindingId: string; serviceConnectionId: string; capabilityBindingId: string; providerId: string;
		providerRepositoryId: string; owner: string; name: string; cloneUrl: string; defaultRef: string;
		publicationRef: string; authorityId: string; expectedHead: string | null; observedHead: string | null;
		grantStatus: 'ready' | 'missing' | 'suspended' | 'reauthorization-required';
		drift: 'none' | 'remote-ahead' | 'remote-behind' | 'diverged' | 'unavailable' | 'unknown'; version: number;
	} | null;
	r2: Record<string, unknown>;
}

interface ProjectFilesystemRepositoryTopology {
	accessMode: 'filesystem'; provider: string; owner: string | null; name: string; url: string | null;
	defaultBranch: string; ref: string | null; checkoutPath: string | null; volumePath: string | null;
	submoduleMountPath: string | null; siteSubmodulePath: string | null;
}

interface ProjectRepositoryTopology {
	contentRepository: ProjectContentRepositoryTopology;
	siteRepository: ProjectFilesystemRepositoryTopology;
	projectRepository: ProjectFilesystemRepositoryTopology | null;
}

const TREEDX_CONTENT_PATH = 'src/content';
function cleanString(value: unknown) { return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null; }
function objectValue(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }

function normalizeRemoteRepository(record: Record<string, unknown>): NonNullable<ProjectContentRepositoryTopology['remote']> {
	const required = ['bindingId', 'serviceConnectionId', 'capabilityBindingId', 'providerId', 'providerRepositoryId', 'owner', 'name', 'cloneUrl', 'defaultRef', 'publicationRef', 'authorityId'] as const;
	const values = Object.fromEntries(required.map((key) => [key, cleanString(record[key])])) as Record<(typeof required)[number], string | null>;
	const missing = required.filter((key) => !values[key]); if (missing.length) throw new Error(`Project remote repository binding is missing: ${missing.join(', ')}.`);
	const version = Number(record.version ?? 1); if (!Number.isInteger(version) || version < 1) throw new Error('Project remote repository binding version must be a positive integer.');
	return { ...(values as Record<(typeof required)[number], string>), expectedHead: cleanString(record.expectedHead), observedHead: cleanString(record.observedHead), grantStatus: ['ready', 'missing', 'suspended', 'reauthorization-required'].includes(String(record.grantStatus)) ? record.grantStatus as NonNullable<ProjectContentRepositoryTopology['remote']>['grantStatus'] : 'missing', drift: ['none', 'remote-ahead', 'remote-behind', 'diverged', 'unavailable', 'unknown'].includes(String(record.drift)) ? record.drift as NonNullable<ProjectContentRepositoryTopology['remote']>['drift'] : 'unknown', version };
}

function normalizeFilesystemRepository(value: unknown, fallbackName: string): ProjectFilesystemRepositoryTopology {
	const record = objectValue(value);
	return { accessMode: 'filesystem', provider: cleanString(record.provider) ?? 'github', owner: cleanString(record.owner), name: cleanString(record.name) ?? fallbackName, url: cleanString(record.url), defaultBranch: cleanString(record.defaultBranch) ?? cleanString(record.ref) ?? 'staging', ref: cleanString(record.ref), checkoutPath: cleanString(record.checkoutPath), volumePath: cleanString(record.volumePath), submoduleMountPath: cleanString(record.submoduleMountPath), siteSubmodulePath: cleanString(record.siteSubmodulePath) };
}

export function normalizeProjectRepositoryTopology(value: unknown): ProjectRepositoryTopology {
	const record = objectValue(value); const content = objectValue(record.contentRepository); const treeDx = objectValue(content.treeDx); const remote = content.remote ? objectValue(content.remote) : null;
	const site = normalizeFilesystemRepository(record.siteRepository, 'site'); const project = record.projectRepository ? normalizeFilesystemRepository(record.projectRepository, 'project') : null;
	const instanceId = cleanString(treeDx.instanceId); const libraryId = cleanString(treeDx.libraryId); if (!instanceId || !libraryId) throw new Error('Project repository topology contentRepository.treeDx.instanceId and libraryId are required.');
	return { contentRepository: { accessMode: 'treedx', githubUrl: cleanString(content.githubUrl), defaultBranch: cleanString(content.defaultBranch), ref: cleanString(content.ref), contentPath: cleanString(content.contentPath) ?? TREEDX_CONTENT_PATH, treeDx: { instanceId, libraryId, repositoryId: cleanString(treeDx.repositoryId), baseUrl: cleanString(treeDx.baseUrl) }, remote: remote ? normalizeRemoteRepository(remote) : null, r2: objectValue(content.r2) } as ProjectContentRepositoryTopology, siteRepository: site, projectRepository: project };
}
