import { validateAgentActivityProfilesConfiguration,validateAgentDefinitionModel,validateAgentSignalContract,validateProposalTypeContract,validateGroupDefinition,validateGroupEdgeDefinition } from '@treeseed/sdk/agent-capacity';
import { createHash } from 'node:crypto';
import { parseFrontmatterDocument,serializeFrontmatterDocument } from '../../../../content/frontmatter.ts';
import { parse as parseYaml } from 'yaml';
import { resolveKnowledgeGatewayConnection } from '../../../../knowledge/gateway-treedx-connection.ts';
import type { WorkdayRouteDependencies } from '../operator-workdays.ts';

type Row = Record<string, unknown>;
export const REPOSITORY_DEFINITION_EXTENSIONS = ['.md', '.mdx', '.yaml', '.yml'] as const;
type CacheEntry = { loadedAt: number; value: Promise<Row[]> };
const inventoryCaches = new WeakMap<object, Map<string, CacheEntry>>();
const INVENTORY_CACHE_TTL_MS = 30_000;
const INVENTORY_CACHE_MAX_ENTRIES = 32;

function object(value: unknown): Row {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
}

function text(...values: unknown[]) {
	return String(values.find((value) => typeof value === 'string' && value) ?? '');
}

function basename(path: string) {
	return path.split('/').at(-1)?.replace(/\.(?:mdx|md|ya?ml)$/u, '').replace(/[-_]/gu, ' ') ?? path;
}

function inventoryCache(store: object) {
	const existing = inventoryCaches.get(store);
	if (existing) return existing;
	const created = new Map<string, CacheEntry>();
	inventoryCaches.set(store, created);
	return created;
}

function pruneInventoryCache(cache: Map<string, CacheEntry>) {
	while (cache.size > INVENTORY_CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
}

export function invalidateAgentLabRepositoryDefinitions(dependencies: WorkdayRouteDependencies, projectId: string) {
	const cache = inventoryCaches.get(dependencies.store as object);
	if (!cache) return;
	for (const key of cache.keys()) if (key.startsWith(`${projectId}\0`)) cache.delete(key);
}

export function repositoryDefinitionSource(file: unknown) {
	const value = object(file); const content = text(value.content);
	if (content.startsWith('---\n')) return content;
	const frontmatter = object(value.frontmatter);
	return Object.keys(frontmatter).length ? serializeFrontmatterDocument(frontmatter, content) : content;
}

function definition(path: string, source: string) {
	if (path.includes('/content/agents/')) {
		const parsed = parseFrontmatterDocument(source);
		const profiles = object(parsed.frontmatter.activityProfiles);
		const validation = validateAgentActivityProfilesConfiguration(profiles);
		return {
			kind: 'agent' as const,
			definition: parsed.frontmatter,
			contractId: text(parsed.frontmatter.id, parsed.frontmatter.slug),
			contractKind: 'agent',
			status: validation.ok ? 'validated agent' : 'agent needs attention',
			diagnostics: validation.diagnostics,
			activities: profiles,
		};
	}
	const portableCollections:Record<string,string>={
		'/content/agent-context-queries/':'context-query','/content/agent-context-query-sets/':'context-query-set','/content/agent-instruction-templates/':'instruction-template',
		'/content/discussion-topics/':'discussion-topic','/content/agent-tests/':'agent-test',
	};
	const portable=Object.entries(portableCollections).find(([marker])=>path.includes(marker));
	if(portable){const parsed=parseFrontmatterDocument(source).frontmatter;return {kind:portable[1],definition:parsed,contractId:text(parsed.id,parsed.slug),contractKind:text(parsed.model,portable[1]),status:'portable definition',diagnostics:[],activities:{}};}
	if (path.includes('/content/groups/') || path.includes('/content/group-edges/')) {
		const parsed = parseFrontmatterDocument(source).frontmatter;
		const edge = path.includes('/content/group-edges/'); const validation = edge ? validateGroupEdgeDefinition(parsed) : validateGroupDefinition(parsed);
		return { kind: edge ? 'group-edge' as const : 'group' as const, definition: parsed, contractId: text(parsed.id, parsed.slug), contractKind: edge ? 'group-edge' : 'group', status: validation.ok ? 'validated group' : 'group needs attention', diagnostics: validation.diagnostics, activities: {} };
	}
	let parsed: Row = {};
	try { parsed = object(parseYaml(source)); } catch { parsed = {}; }
	const contract = path.includes('/agents/signals/');
	const kind = path.startsWith('scenes/') ? 'simulation' as const
		: path.startsWith('seeds/') ? 'seed' as const
			: path.includes('/governance/proposal-types/') ? 'proposal-type' as const : 'signal' as const;
	const validation = contract ? validateAgentSignalContract(parsed) : kind === 'proposal-type' ? validateProposalTypeContract(parsed) : null;
	return {
		kind,
		definition: parsed,
		contractId: text(parsed.id),
		contractKind: text(parsed.kind),
		status: validation?.ok ? 'validated contract' : validation ? 'contract needs attention' : 'repository definition',
		diagnostics: validation?.diagnostics ?? [],
		activities: {},
	};
}

async function projectRepositoryDefinitions(dependencies: WorkdayRouteDependencies, project: Row, immutableRef?: string) {
	const projectId = text(project.id);
	if (!projectId) return [];
	const connection = await resolveKnowledgeGatewayConnection(dependencies.store, {
		projectId, write: false, authoringPaths: true,
		...(immutableRef ? { readRefs: [immutableRef] } : {}),
	}).catch(() => null);
	if (!connection) return [];
	const requestedRef = immutableRef || connection.baseRef;
	const key = [projectId, connection.repositoryId, requestedRef, connection.contentPath, text(project.name, project.slug)].join('\0');
	const cache = inventoryCache(dependencies.store as object); const cached = cache.get(key);
	if (cached && Date.now() - cached.loadedAt <= INVENTORY_CACHE_TTL_MS) {
		cache.delete(key); cache.set(key, cached); return cached.value;
	}
	if (cached) cache.delete(key);
	const value = (async () => {
		const listRequest = connection.client.listRepositoryPaths({
			repoId: connection.repositoryId,
			ref: requestedRef,
			paths: [`${connection.contentPath}/agents/**`, `${connection.contentPath}/groups/**`, `${connection.contentPath}/group-edges/**`,
				`${connection.contentPath}/agent-context-queries/**`,`${connection.contentPath}/agent-context-query-sets/**`,`${connection.contentPath}/agent-instruction-templates/**`,
				`${connection.contentPath}/discussion-topics/**`,`${connection.contentPath}/agent-tests/**`,'scenes/**', 'seeds/**', '.treeseed/agents/signals/**', '.treeseed/governance/proposal-types/**'],
			kinds: ['blob'], extensions: [...REPOSITORY_DEFINITION_EXTENSIONS], limit: 400, allowProtected: true,
		});
		const listed = immutableRef ? await listRequest : await listRequest.catch(() => ({ entries: [] }));
		const paths = (listed.entries ?? []).map((candidate: unknown) => text(object(candidate).path)).filter(Boolean);
		const readRequest = paths.length ? connection.client.readRepositoryFiles({
			repoId: connection.repositoryId, ref: text(listed.resolvedRef, requestedRef), paths,
			encoding: 'utf8', parseFrontmatter: false, allowProtected: true,
		}) : null;
		const read = readRequest ? (immutableRef ? await readRequest : await readRequest.catch(() => ({ files: [] }))) : { files: [] };
		const sources = new Map((read.files ?? []).map((file: unknown) => [text(object(file).path), repositoryDefinitionSource(file)]));
		return paths.map((path): Row => {
			const parsed = definition(path, sources.get(path) ?? '');
			return {
				id: `definition:${projectId}:${path}`,
				kind: parsed.kind,
				title: text(parsed.definition.title, parsed.definition.name, parsed.definition.label, basename(path)),
				description: text(parsed.definition.description, parsed.definition.summary, path),
				status: parsed.status,
				projectId,
				projectName: text(project.name, project.slug),
				tags: ['TreeDX', parsed.kind, parsed.status],
				data: {
					projectId, path, ref: text(read.resolvedRef, listed.resolvedRef, requestedRef),
					source: 'treedx', contractId: parsed.contractId, contractKind: parsed.contractKind,
					activities: parsed.activities, diagnostics: parsed.diagnostics, valid: parsed.diagnostics.length === 0, definition: parsed.definition,
					rawSource:sources.get(path)??'',digest:createHash('sha256').update(sources.get(path)??'').digest('hex'),
				},
			};
		});
	})();
	cache.set(key, { loadedAt: Date.now(), value }); pruneInventoryCache(cache);
	value.catch(() => { if (cache.get(key)?.value === value) cache.delete(key); });
	return value;
}

export async function agentLabRepositoryDefinitions(dependencies: WorkdayRouteDependencies, projects: Row[], immutableRef?: string) {
	const groups = await Promise.all(projects.map((project) => projectRepositoryDefinitions(dependencies, project, immutableRef)));
	return groups.flat();
}

export function matchesAgentDefinition(agent: Row, candidate: Row) {
	if (candidate.kind !== 'agent' || text(candidate.projectId) !== text(agent.projectId)) return false;
	const data = object(candidate.data);
	const identity = new Set([
		text(agent.id), text(agent.slug), text(agent.agentSlug), text(agent.agentId),
	].filter(Boolean));
	return identity.has(text(data.contractId)) || identity.has(text(data.path).split('/').at(-1)?.replace(/\.(?:mdx|md)$/u, ''));
}

export function unmatchedAgentDefinitions(agents: Row[], definitions: Row[]) {
	return definitions.filter((candidate) => candidate.kind === 'agent' && !agents.some((agent) => matchesAgentDefinition(agent, candidate)));
}

export function validateAgentDefinitionSource(source: string) {
	let frontmatter: Row;
	try { frontmatter = parseFrontmatterDocument(source).frontmatter; }
	catch (error) { return { ok: false, diagnostics: [{ code: 'agent_frontmatter_invalid', path: 'frontmatter', message: error instanceof Error ? error.message : 'The MDX frontmatter is invalid.' }], references: [] as Array<{ id: string; kind: 'signal' }> }; }
	const diagnostics = validateAgentDefinitionModel(frontmatter).diagnostics;
	const references: Array<{ id: string; kind: 'signal' }> = [];
	for (const profile of Object.values(object(frontmatter.activityProfiles)).map(object)) {
		const signals = object(profile.signals);
		for (const entry of Array.isArray(signals.subscribesTo) ? signals.subscribesTo : []) {
			const id = text(object(entry).contract); if (id) references.push({ id, kind: 'signal' });
		}
		for (const id of Array.isArray(signals.publishes) ? signals.publishes : []) if (text(id)) references.push({ id: text(id), kind: 'signal' });
	}
	const unique = new Map(references.map((reference) => [`${reference.kind}:${reference.id}`, reference]));
	return { ok: diagnostics.length === 0, diagnostics, references: [...unique.values()] };
}
