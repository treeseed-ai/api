import { createHash } from 'node:crypto';
import { exactDependencyLinkSchema, validatePortableContentData } from '@treeseed/sdk/content-validation';
import { resolveKnowledgeGatewayConnection } from '../../../../knowledge/gateway-treedx-connection.ts';
import type { ExecutableProposalSource, VerifiedDependencyLink } from '../../../policy/execution/execution-graph-projector.ts';

type Row = Record<string, unknown>;
const record = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const exactCommit = /^[a-f0-9]{40}$/u;

/** Read relation notes from each granted project library at a pinned TreeDX commit. */
export async function loadTeamExactDependencyLinks(store: any, sources: ExecutableProposalSource[]): Promise<VerifiedDependencyLink[]> {
	const projects = [...new Map(sources.map((source) => [source.projectId, source])).values()];
	const selected = new Set(sources.map((source) => `${source.repository}:${source.commit}:${source.path}:${source.frontmatter.id}`));
	const sourceByRef = new Map(sources.map((source) => [`${source.repository}:${source.commit}:${source.path}:${source.frontmatter.id}`, source]));
	const grantedEndpoints = new Set<string>();
	const requireEndpointGrant = async (key: string) => {
		if (grantedEndpoints.has(key)) return;
		const source = sourceByRef.get(key);
		if (!source) throw new Error('TreeDX dependency endpoint is absent from the selected team graph.');
		const grant = await resolveKnowledgeGatewayConnection(store, {
			projectId: source.projectId, write: false, relationPaths: true, readRefs: [source.commit],
		});
		const allowed = grant?.allowedPaths.some((pattern) => pattern === '**' || pattern === source.path
			|| (pattern.endsWith('/**') && source.path.startsWith(pattern.slice(0, -3) + '/')));
		if (!grant || grant.repositoryId !== source.repository || !allowed) {
			throw new Error(`TreeDX exact dependency endpoint read grant is missing for project ${source.projectId}.`);
		}
		grantedEndpoints.add(key);
	};
	const links: VerifiedDependencyLink[] = [];
	for (const project of projects) {
		const connection = await resolveKnowledgeGatewayConnection(store, {
			projectId: project.projectId, write: false, relationPaths: true, authoringPaths: true,
		});
		if (!connection || connection.repositoryId !== project.repository) throw new Error(`TreeDX read grant is missing for project ${project.projectId}.`);
		const response = record(await connection.client.queryGraph({ repoId: connection.repositoryId,
			ref: connection.publicationRef, seeds: [{ kind: 'type', value: 'ExactEntityReference' }],
			relations: ['depends_on'], options: { direction: 'both', depth: 1, maxNodes: 50 } }));
		const commit = text(response.resolvedRef);
		if (!exactCommit.test(commit)) throw new Error('TreeDX did not pin the dependency graph to an exact commit.');
		const pinned = await resolveKnowledgeGatewayConnection(store, {
			projectId: project.projectId, write: false, relationPaths: true, readRefs: [commit],
		});
		if (!pinned || pinned.repositoryId !== project.repository) throw new Error(`TreeDX exact dependency read grant is missing for project ${project.projectId}.`);
		const nodes = response.nodes;
		if (!Array.isArray(nodes) || nodes.length >= 50 || !Array.isArray(response.edges)) {
			throw new Error('TreeDX dependency graph was invalid or truncated.');
		}
		const files = new Map<string, { sourceRef: VerifiedDependencyLink['sourceRef']; links: unknown[] }>();
		for (const rawEdge of response.edges) {
			const edge = record(rawEdge);
			if (edge.type !== 'DEPENDS_ON') continue;
			const data = record(edge.data);
			const parsed = exactDependencyLinkSchema.safeParse(data.link);
			const path = text(data.ownerPath);
			if (!parsed.success || !path) throw new Error('TreeDX returned an invalid exact dependency edge.');
			const link = parsed.data;
			const from = `${link.from.repository}:${link.from.commit}:${link.from.path}:${link.from.id}`;
			const to = `${link.to.repository}:${link.to.commit}:${link.to.path}:${link.to.id}`;
			if (!selected.has(from) || !selected.has(to)) continue;
			await requireEndpointGrant(from);
			await requireEndpointGrant(to);
			let file = files.get(path);
			if (!file) {
				const reply = record(await pinned.client.readRepositoryFile({ repoId: pinned.repositoryId,
					ref: commit, path, encoding: 'utf8', parseFrontmatter: true, allowProtected: true }));
				if (text(reply.resolvedRef) !== commit) throw new Error('TreeDX dependency note moved during read.');
				const value = record(reply.file ?? (Array.isArray(reply.files) ? reply.files[0] : null));
				const content = text(value.content);
				const validated = validatePortableContentData('note', record(value.frontmatter));
				if (!validated.ok || !validated.data || validated.data.projectId !== project.projectId) {
					throw new Error('TreeDX dependency note failed content and project validation.');
				}
				file = { sourceRef: { store: 'treedx', model: 'note', id: validated.data.id,
					repository: project.repository, commit, path,
					digest: `sha256:${createHash('sha256').update(content).digest('hex')}` },
					links: validated.data.links ?? [] };
				files.set(path, file);
			}
			if (!file.links.some((candidate) => JSON.stringify(candidate) === JSON.stringify(link))) {
				throw new Error('TreeDX dependency edge is not present in its exact note.');
			}
			links.push({ from: link.from, to: link.to, sourceRef: file.sourceRef });
		}
	}
	return [...new Map(links.map((link) => [`${link.from.repository}:${link.from.id}:${link.from.anchor}:${link.to.repository}:${link.to.id}:${link.to.anchor}`, link])).values()];
}
