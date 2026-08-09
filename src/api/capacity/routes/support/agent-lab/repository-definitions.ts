import { validateAgentActivityProfilesConfiguration,validateAgentSignalContract,validateProposalTypeContract,validateGroupDefinition,validateGroupEdgeDefinition } from '@treeseed/sdk/agent-capacity';
import { parseFrontmatterDocument } from '@treeseed/sdk/frontmatter';
import { parse as parseYaml } from 'yaml';
import { resolveKnowledgeGatewayConnection } from '../../../../knowledge/gateway-treedx-connection.ts';
import type { WorkdayRouteDependencies } from '../operator-workdays.ts';

type Row = Record<string, unknown>;

function object(value: unknown): Row {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
}

function text(...values: unknown[]) {
	return String(values.find((value) => typeof value === 'string' && value) ?? '');
}

function basename(path: string) {
	return path.split('/').at(-1)?.replace(/\.(?:mdx|md|ya?ml)$/u, '').replace(/[-_]/gu, ' ') ?? path;
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

export async function agentLabRepositoryDefinitions(dependencies: WorkdayRouteDependencies, projects: Row[]) {
	const groups = await Promise.all(projects.map(async (project) => {
		const projectId = text(project.id);
		if (!projectId) return [];
		const connection = await resolveKnowledgeGatewayConnection(dependencies.store, {
			projectId, write: false, authoringPaths: true,
		}).catch(() => null);
		if (!connection) return [];
		const listed = await connection.client.listRepositoryPaths({
			repoId: connection.repositoryId,
			ref: connection.baseRef,
			paths: [`${connection.contentPath}/agents/**`, `${connection.contentPath}/groups/**`, `${connection.contentPath}/group-edges/**`, 'scenes/**', 'seeds/**', '.treeseed/agents/signals/**', '.treeseed/governance/proposal-types/**'],
			kinds: ['blob'], extensions: ['md', 'mdx', 'yaml', 'yml'], limit: 400, allowProtected: true,
		}).catch(() => ({ entries: [] }));
		const paths = (listed.entries ?? []).map((candidate: unknown) => text(object(candidate).path)).filter(Boolean);
		const read = paths.length ? await connection.client.readRepositoryFiles({
			repoId: connection.repositoryId, ref: text(listed.resolvedRef, connection.baseRef), paths,
			encoding: 'utf8', parseFrontmatter: false, allowProtected: true,
		}).catch(() => ({ files: [] })) : { files: [] };
		const sources = new Map((read.files ?? []).map((file: unknown) => [text(object(file).path), text(object(file).content)]));
		return paths.map((path) => {
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
					projectId, path, ref: text(read.resolvedRef, listed.resolvedRef, connection.baseRef),
					source: 'treedx', contractId: parsed.contractId, contractKind: parsed.contractKind,
					activities: parsed.activities, diagnostics: parsed.diagnostics, definition: parsed.definition,
				},
			};
		});
	}));
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

export function validateAgentDefinitionSource(source: string) {
	let frontmatter: Row;
	try { frontmatter = parseFrontmatterDocument(source).frontmatter; }
	catch (error) { return { ok: false, diagnostics: [{ code: 'agent_frontmatter_invalid', path: 'frontmatter', message: error instanceof Error ? error.message : 'The MDX frontmatter is invalid.' }], references: [] as Array<{ id: string; kind: 'signal' }> }; }
	const diagnostics = validateAgentActivityProfilesConfiguration(frontmatter.activityProfiles).diagnostics;
	for (const field of ['id','slug','title','agentClass']) if (!text(frontmatter[field])) diagnostics.push({ code: 'agent_identity_required', path: field, message: `${field} is required.` });
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
