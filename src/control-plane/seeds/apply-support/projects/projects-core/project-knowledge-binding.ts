import { FetchTransport, TreeDxClient } from '@treeseed/treedx/treedx/client';
import { createHash } from 'node:crypto';
import { treeDxDelegationAuthority } from '../../../../../api/control-plane/treedx/delegation-authority.ts';
import { parseFrontmatterDocument } from '../../../../../api/content/frontmatter.ts';
import { repositoryDefinitionSource, validateAgentDefinitionSource } from '../../../../../api/control-plane/repositories/agents/agent-definition-source.ts';
import { resolveTreeDxServiceUrl } from '../../../../../api/control-plane/treedx/connection-url.ts';

function text(...values: unknown[]): string {
	for (const value of values) if (typeof value === 'string' && value.trim()) return value.trim();
	return '';
}

function projectRepositoryName(projectSlug: string) {
	const normalized = `treeseed-${projectSlug}`.trim().toLowerCase().replace(/[^a-z0-9_.-]+/gu, '-').replace(/^-+|-+$/gu, '');
	return normalized || 'project';
}

interface TreeDxRepositorySummary {
	repoId: string;
	repositoryName?: string;
	name?: string;
	defaultRef?: string;
}

interface TreeDxRepositoryRef {
	name: string;
	target?: string | null;
	sha?: string | null;
}

function object(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function repositoryRefs(response: unknown): TreeDxRepositoryRef[] {
	const refs = object(response).refs;
	if (!Array.isArray(refs)) throw new Error('TreeDX repository refs response is invalid.');
	return refs.map((value) => {
		const ref = object(value);
		if (typeof ref.name !== 'string') throw new Error('TreeDX repository refs response contains an invalid ref.');
		return ref as unknown as TreeDxRepositoryRef;
	});
}

function refHead(refs: TreeDxRepositoryRef[], name: string) {
	const ref = refs.find((candidate) => candidate.name === name);
	const head = text(ref?.sha, ref?.target);
	return /^[a-f0-9]{40}$/u.test(head) ? head : '';
}

function queryResult(response: unknown) {
	const responseObject = object(response);
	return Object.keys(object(responseObject.query)).length ? object(responseObject.query) : responseObject;
}

function resultItems(result: Record<string, unknown>): unknown[] {
	for (const key of ['results', 'paths', 'items', 'files']) {
		if (Array.isArray(result[key])) return result[key] as unknown[];
	}
	return [];
}

async function waitForGraphRefresh(client: TreeDxClient, repositoryId: string, response: unknown) {
	const graph = object(object(response).graph);
	const jobId = text(graph.jobId);
	if (!jobId || text(graph.status) === 'completed') return graph;
	for (let attempt = 0; attempt < 30; attempt += 1) {
		const polled = object(object(await client.graph.refreshJob(repositoryId, jobId)).job);
		if (text(polled.status) === 'completed') return polled;
		if (text(polled.status) === 'failed') throw new Error(`TreeDX graph refresh failed: ${text(polled.errorCode, 'unknown_error')}.`);
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error('TreeDX graph refresh did not complete before the seed reconciliation deadline.');
}

function strings(value: unknown): string[] {
	return Array.isArray(value) ? [...new Set(value.map(String).map((item) => item.trim()).filter(Boolean))] : [];
}

async function reconcileProjectAgentClasses(input: {
	store: any; client: TreeDxClient; repositoryId: string; projectId: string; teamId: string; projectSlug: string; ref: string;
}) {
	const listed = queryResult(await input.client.query.listPaths(input.repositoryId, {
		ref: input.ref, paths: ['agents/**'], extensions: ['.md', '.mdx', '.yaml', '.yml'], kinds: ['blob'], limit: 500, allowProtected: true,
	}));
	const paths = resultItems(listed).map((entry) => text(object(entry).path, entry)).filter(Boolean).sort();
	if (input.projectSlug === 'sdk' && paths.length !== 8) {
		throw new Error(`SDK library reconciliation requires exactly eight agent definitions; TreeDX returned ${paths.length}.`);
	}
	if (!paths.length) return { count: 0, immutableRef: text(listed.resolvedRef) };
	const read = queryResult(await input.client.query.repository(input.repositoryId, {
		ref: text(listed.resolvedRef, input.ref), type: 'files', paths, encoding: 'utf8', parseFrontmatter: true, allowProtected: true,
	}));
	const files = resultItems(read);
	if (files.length !== paths.length) throw new Error('TreeDX did not read back every discovered agent definition.');
	const immutableRef = text(read.resolvedRef, listed.resolvedRef);
	if (!/^[a-f0-9]{40}$/u.test(immutableRef)) throw new Error('TreeDX agent definitions did not resolve to an immutable commit.');
	const definitions = files.map((file) => {
		const row = object(file); const path = text(row.path); const source = repositoryDefinitionSource(row);
		const validation = validateAgentDefinitionSource(source);
		if (!validation.ok) throw new Error(`Agent definition ${path || '(unknown)'} is invalid: ${validation.diagnostics.map((item) => `${item.path}: ${item.message}`).join('; ')}`);
		return { path, source, definition: parseFrontmatterDocument(source).frontmatter };
	});
	const groups = new Map<string, typeof definitions>();
	for (const definition of definitions) {
		const key = text(definition.definition.projectAgentClassSlug, definition.definition.projectAgentClassId, definition.definition.agentClass);
		if (!key) throw new Error(`Agent definition ${definition.path} does not select a project agent class.`);
		groups.set(key, [...(groups.get(key) ?? []), definition]);
	}
	const now = new Date().toISOString();
	for (const [classSlug, members] of groups) {
		const existing = await input.store.first('SELECT id, created_at FROM project_agent_classes WHERE project_id = ? AND slug = ? LIMIT 1', [input.projectId, classSlug]);
		const classId = text(existing?.id, `${input.projectId}:${classSlug}`);
		const agents = members.map(({ path, definition }) => {
			const profiles = object(definition.activityProfiles);
			return { agentId: text(definition.id), slug: text(definition.slug), name: text(definition.name, definition.title),
				title: text(definition.title, definition.name), enabled: definition.enabled !== false,
				groupIds: strings(definition.groupIds), contentPath: path,
				contextQueryRefs: definition.contextQueryRefs ?? [], contextQuerySetRefs: definition.contextQuerySetRefs ?? [],
				instructionTemplateRefs: definition.instructionTemplateRefs ?? [], activities: profiles };
		});
		const profiles = members.flatMap(({ definition }) => Object.entries(object(definition.activityProfiles)));
		const allowedModes = [...new Set(profiles.flatMap(([activity, value]) => object(value).enabled === false ? [] : [activity === 'acting' ? 'acting' : 'planning']))];
		const requiredCapabilities = [...new Set(profiles.flatMap(([, value]) => strings(object(object(value).execution).requiredCapabilities)))];
		const metadata = { source: 'project-library', immutableRef, libraryRef: input.ref,
			definitionPaths: members.map(({ path }) => path), definitionDigest: createHash('sha256').update(members.map(({ source }) => source).join('\n')).digest('hex') };
		await input.store.run(`INSERT INTO project_agent_classes
			(id,team_id,project_id,slug,name,status,allowed_modes_json,required_capabilities_json,kernel_profile_json,kernel_policy_json,handler_refs_json,output_contracts_json,metadata_json,created_at,updated_at)
			VALUES (?,?,?,?,?,'active',?,?,?,?,?,?,?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET slug=excluded.slug,name=excluded.name,status='active',allowed_modes_json=excluded.allowed_modes_json,
			required_capabilities_json=excluded.required_capabilities_json,handler_refs_json=excluded.handler_refs_json,
			metadata_json=excluded.metadata_json,updated_at=excluded.updated_at`, [
			classId,input.teamId,input.projectId,classSlug,text(members[0]?.definition.projectAgentClassName, classSlug),
			JSON.stringify(allowedModes.length ? allowedModes : ['planning']),JSON.stringify(requiredCapabilities),JSON.stringify({}),JSON.stringify({}),
			JSON.stringify({ agents }),JSON.stringify({}),JSON.stringify(metadata),text(existing?.created_at, now),now,
		]);
	}
	return { count: definitions.length, classes: groups.size, immutableRef };
}

function repositoryCatalog(response: unknown): TreeDxRepositorySummary[] {
	if (!response || typeof response !== 'object' || !Array.isArray((response as { repos?: unknown }).repos)) {
		throw new Error('TreeDX repository catalog response is invalid.');
	}
	return (response as { repos: unknown[] }).repos.map((repository) => {
		if (!repository || typeof repository !== 'object' || typeof (repository as { repoId?: unknown }).repoId !== 'string') {
			throw new Error('TreeDX repository catalog contains an invalid repository.');
		}
		return repository as TreeDxRepositorySummary;
	});
}

function createdRepository(response: unknown): TreeDxRepositorySummary {
	const repository = response && typeof response === 'object'
		? (response as { repo?: unknown }).repo
		: undefined;
	if (!repository || typeof repository !== 'object' || typeof (repository as { repoId?: unknown }).repoId !== 'string') {
		throw new Error('TreeDX repository creation response is invalid.');
	}
	return repository as TreeDxRepositorySummary;
}

export async function ensureProjectKnowledgeBinding(input: {
	store: any;
	projectId: string;
	teamId: string;
	projectSlug: string;
	libraryRoot?: string;
	libraryRef?: string;
	libraryRepositoryUrl: string;
	libraryDefaultBranch?: string;
	libraryCredentialId?: string;
	expectedUpstreamHeads?: Record<string,string>;
	env?: NodeJS.ProcessEnv;
	dependencyState?: { repositoryCatalog?: Promise<unknown> };
}) {
	const env = input.env ?? process.env;
	const baseUrl = resolveTreeDxServiceUrl(text(env.TREESEED_TREEDX_URL, env.TREESEED_TREEDX_BASE_URL, 'http://127.0.0.1:4000'), env);
	const token = treeDxDelegationAuthority().mint({
		actorId: 'treeseed-api',
		tenantId: 'treeseed-control-plane',
		projectId: input.projectId,
		connectionId: 'treedx-local-seed',
		scope: { capabilities: ['repos:read', 'repos:write', 'git:read', 'git:fetch', 'files:read', 'files:search', 'graph:query', 'graph:refresh'], repositoryIds: ['*'], refs: ['*'], paths: ['**'] },
	}).token;
	const normalizedBaseUrl = baseUrl.replace(/\/+$/u, '');
	const transport = new FetchTransport({ baseUrl: normalizedBaseUrl, token, timeoutMs: 15_000, fetchImpl: input.store.config?.fetchImpl });
	const client = new TreeDxClient({
		baseUrl: normalizedBaseUrl,
		transport,
	});
	const repositoryName = projectRepositoryName(input.projectSlug);
	const catalogResponse = input.dependencyState
		? await (input.dependencyState.repositoryCatalog ??= client.repositories.list())
		: await client.repositories.list();
	const repositories = repositoryCatalog(catalogResponse);
	let repository = repositories.find((candidate) =>
		candidate.name === repositoryName || candidate.repositoryName === repositoryName);
	if (!repository) {
		repository = createdRepository(await client.repositories.create({ repositoryName, defaultRef: 'refs/heads/main' }));
		repositories.push(repository);
	}
	const branches = [...new Set([input.libraryDefaultBranch ?? 'main', 'staging'])];
	const remoteRefs = branches.map((branch) => `refs/remotes/origin/${branch}`);
	const refspecs = branches.map((branch) => `+refs/heads/${branch}:refs/remotes/origin/${branch}`);
	await client.repositories.sync(repository.repoId, {
		remoteName: 'origin', remoteUrl: input.libraryRepositoryUrl,
		...(input.libraryCredentialId ? { credentialId: input.libraryCredentialId } : {}), refspecs,
	});
	const refs = repositoryRefs(await client.repositories.refs(repository.repoId));
	const upstreamHeads = Object.fromEntries(remoteRefs.map((ref) => [ref, refHead(refs, ref)]));
	for (const ref of remoteRefs) {
		if (!upstreamHeads[ref]) throw new Error(`TreeDX did not fetch an immutable ${ref} library head.`);
	}
	for (const branch of branches) {
		const expected = input.expectedUpstreamHeads?.[branch]; const observed = upstreamHeads[`refs/remotes/origin/${branch}`];
		if (expected && observed !== expected) throw new Error(`TreeDX ${branch} library head moved or mismatched during reconciliation.`);
	}
	const requestedRef = input.libraryRef ?? `refs/remotes/origin/${input.libraryDefaultBranch ?? 'main'}`;
	if (!upstreamHeads[requestedRef] && !refHead(refs, requestedRef)) {
		throw new Error(`TreeDX library ref ${requestedRef} is unavailable after synchronization.`);
	}
	await waitForGraphRefresh(client, repository.repoId, await client.graph.refresh(repository.repoId, {
		ref: requestedRef, paths: ['**'], forceFull: true,
	}));
	await client.searchIndex.refresh(repository.repoId, { ref: requestedRef, paths: ['**'], incremental: false });
	const listing = queryResult(await client.query.listPaths(repository.repoId, {
		ref: requestedRef, paths: ['**'], kinds: ['blob'], limit: 1, allowProtected: true,
	}));
	if (!text(listing.resolvedRef) || resultItems(listing).length === 0) {
		throw new Error('TreeDX library reconciliation returned no representative content.');
	}
	const existing = await input.store.getProjectTreeDxLibrary(input.projectId);
	await input.store.upsertTeamTreeDx(input.teamId, {
		kind: 'managed_public_federation', provider: 'local', name: 'Local TreeDX knowledge plane',
		baseUrl, registryUrl: baseUrl, publicRead: true, status: 'active',
		metadata: { reconciledLocalRuntime: true },
	});
	await input.store.upsertProjectTreeDxLibrary(input.projectId, {
		repositoryId: repository.repoId,
		contentPath: input.libraryRoot ?? '.',
		contentRepositoryUrl: input.libraryRepositoryUrl,
		contentRepositoryDefaultBranch: input.libraryDefaultBranch
			?? existing?.contentRepositoryDefaultBranch ?? 'main',
		contentRepositoryRef: requestedRef,
		metadata: { repositoryName, libraryRoot: input.libraryRoot ?? '.', upstreamBacked: true,
			upstreamHeads, resolvedRef: text(listing.resolvedRef), reconciledLocalRuntime: true },
	});
	const agents = await reconcileProjectAgentClasses({ store: input.store, client, repositoryId: repository.repoId,
		projectId: input.projectId, teamId: input.teamId, projectSlug: input.projectSlug, ref: requestedRef });
	return { kind: 'projectKnowledgeBinding', projectId: input.projectId, repositoryId: repository.repoId, agents };
}
