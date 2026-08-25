import { type BookDefinition, type KnowledgePageDefinition } from '@treeseed/sdk/knowledge';
import { parseBook, parseKnowledgePage } from './runtime/catalog.ts';
import { projectLibraryPath, resolveKnowledgeGatewayConnection } from './gateway-treedx-connection.ts';
import { createKnowledgePublicationStorage } from './publication-storage.ts';
import { loadPublishedTeamCatalog } from './published-catalog.ts';
import { listKnowledgeContentPaths } from './read-model/repository-paths.ts';

type SourceContext = {
	teamId: string;
	teamSlug: string;
	projectId: string;
	repositoryId: string;
	commitSha: string;
	graphRef?: string;
	path?: string;
	bookSlug?: string;
};
export type FederatedBook = BookDefinition & { source: SourceContext };
export type FederatedKnowledgePage = KnowledgePageDefinition & { source: SourceContext };

const record = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};

export function assertFederatedKnowledgeIdentity(books: FederatedBook[], pages: FederatedKnowledgePage[]) {
	for (const [kind, entries] of [['book', books], ['knowledge page', pages]] as const) {
		const seen = new Map<string, string>();
		for (const entry of entries) {
			const owner = `${entry.source.projectId}:${entry.source.path ?? entry.slug}`;
			const previous = seen.get(entry.id);
			if (previous && previous !== owner) throw new Error(`Duplicate federated ${kind} id "${entry.id}" in ${previous} and ${owner}.`);
			seen.set(entry.id, owner);
		}
	}
}

async function repositoryDocuments(connection: any, resolvedRef: string, paths: string[]) {
	if (!paths.length) return [];
	const documents: Record<string, any>[] = [];
	for (let index = 0; index < paths.length; index += 100) {
		const response = await connection.client.readRepositoryFiles({
			repoId: connection.repositoryId, ref: resolvedRef, paths: paths.slice(index, index + 100), parseFrontmatter: true,
		});
		if (String(response.resolvedRef ?? '') !== resolvedRef) {
			throw new Error('The knowledge source changed while the catalog was loading.');
		}
		documents.push(...(Array.isArray(response.files) ? response.files.map(record) : []));
	}
	return documents;
}

export function mergeFederatedProjects(memberProjects: any[], publicProjects: any[]) {
	return [...new Map([...publicProjects, ...memberProjects].map((project) => [project.id, project])).values()];
}

async function contentPaths(connection: any, ref = connection.baseRef) {
	const response = await listKnowledgeContentPaths(connection, ref);
	return {
		paths: (response.entries ?? []).map((entry: any) => String(entry.path ?? '')).filter(Boolean),
		resolvedRef: response.resolvedRef,
	};
}

async function loadLiveProjectCatalog(context: any, project: any) {
	const observedConnection = await resolveKnowledgeGatewayConnection(context.store, { projectId: project.id, write: false });
	if (!observedConnection) return { books: [] as FederatedBook[], pages: [] as FederatedKnowledgePage[] };
	const [paths, team] = await Promise.all([contentPaths(observedConnection), context.store.getTeam(project.teamId)]);
	const connection = await resolveKnowledgeGatewayConnection(context.store, {
		projectId: project.id, write: false, readRefs: [paths.resolvedRef],
	});
	if (!connection || connection.repositoryId !== observedConnection.repositoryId
		|| connection.contentPath !== observedConnection.contentPath) {
		throw new Error('The knowledge repository binding changed while the catalog was loading.');
	}
	const bookRoot = `${projectLibraryPath(connection.contentPath, 'books')}/`;
	const pageRoot = `${projectLibraryPath(connection.contentPath, 'knowledge')}/`;
	const [bookDocuments, pageDocuments] = await Promise.all([
		repositoryDocuments(connection, paths.resolvedRef, paths.paths.filter((path) => path.startsWith(bookRoot))),
		repositoryDocuments(connection, paths.resolvedRef, paths.paths.filter((path) => path.startsWith(pageRoot))),
	]);
	const source = { teamId: project.teamId, teamSlug: team?.slug ?? team?.name ?? project.teamId,
		projectId: project.id, repositoryId: connection.repositoryId, commitSha: paths.resolvedRef };
	const books = bookDocuments.flatMap((document): FederatedBook[] => {
		const raw = String(document.content ?? '');
		if (raw && !document.frontmatter) throw new Error(`TreeDX did not parse frontmatter for ${String(document.path)}.`);
		return raw ? [{ ...parseBook({ path: String(document.path), raw }), source: { ...source, path: String(document.path) } }] : [];
	});
	const pages = pageDocuments.flatMap((document): FederatedKnowledgePage[] => {
		const raw = String(document.content ?? '');
		if (raw && !document.frontmatter) throw new Error(`TreeDX did not parse frontmatter for ${String(document.path)}.`);
		return raw ? [{ ...parseKnowledgePage({ path: String(document.path), raw, sourcePackage: project.id }),
			source: { ...source, path: String(document.path) } }] : [];
	});
	return { books, pages };
}

export async function loadFederatedKnowledgeCatalog(context: any, c: any, projectId?: string) {
	const principal = c.get('principal') ?? null;
	const publicProjects = await context.store.listPublicProjects();
	const projects = mergeFederatedProjects(
		principal ? await context.store.listProjectsForPrincipal(principal) : [],
		publicProjects,
	)
		.filter((project: any) => !projectId || project.id === projectId);
	const books: FederatedBook[] = [];
	const pages: FederatedKnowledgePage[] = [];
	const byTeam = new Map<string, any[]>();
	for (const project of projects) byTeam.set(project.teamId, [...(byTeam.get(project.teamId) ?? []), project]);
	const localLiveSource = ['local', 'test'].includes(String(context.options?.environment
		?? process.env.TREESEED_ENVIRONMENT ?? 'local'));
	const storage = createKnowledgePublicationStorage({ adapter: context.options?.knowledgePublicationStorage,
		environment: context.options?.environment });
	const liveProjects: any[] = [];
	for (const [teamId, teamProjects] of byTeam) {
		const team = await context.store.getTeam(teamId);
		const manifest = await storage.readCurrent(teamId);
		if (!manifest) {
			if (!localLiveSource) throw new Error(`Published knowledge is unavailable for team ${teamId}.`);
			liveProjects.push(...teamProjects);
			continue;
		}
		const published = await loadPublishedTeamCatalog({ storage, manifest,
			teamSlug: team?.slug ?? team?.name ?? teamId,
			projectIds: new Set(teamProjects.map((project) => project.id)) });
		books.push(...published.books);
		pages.push(...published.pages);
		if (localLiveSource) {
			const publishedProjectIds = new Set(manifest.projects.map((project) => project.projectId));
			liveProjects.push(...teamProjects.filter((project) => !publishedProjectIds.has(project.id)));
		}
	}
	const liveCatalogs = await Promise.all(liveProjects.map((project) => loadLiveProjectCatalog(context, project)));
	for (const catalog of liveCatalogs) { books.push(...catalog.books); pages.push(...catalog.pages); }
	assertFederatedKnowledgeIdentity(books, pages);
	const bookById = new Map(books.map((book) => [book.id, book]));
	for (const page of pages) page.source = { ...page.source, bookSlug: bookById.get(page.bookId)?.slug ?? page.bookId };
	return { principal, books, pages };
}

export async function searchFederatedKnowledgeCatalog(context: any, catalog: any, query: string) {
	const ranked = new Map<string, { page: FederatedKnowledgePage; score: number }>();
	const byProject = new Map<string, FederatedKnowledgePage[]>();
	for (const page of catalog.pages as FederatedKnowledgePage[]) {
		const projectPages = byProject.get(page.source.projectId) ?? [];
		projectPages.push(page);
		byProject.set(page.source.projectId, projectPages);
	}
	for (const [projectId, pages] of byProject) {
		const sourceCommit = pages[0]?.source.commitSha;
		const graphRef = pages[0]?.source.graphRef ?? sourceCommit;
		if (!sourceCommit) continue;
		const connection = await resolveKnowledgeGatewayConnection(context.store, {
			projectId, write: false, readRefs: [graphRef],
		});
		if (!connection) throw new Error(`TreeDX repository is unavailable for project ${projectId}.`);
		const results = await connection.client.searchGraphSections({
			repoId: connection.repositoryId, ref: graphRef, query, limit: 40,
		});
		const confirmed = await contentPaths(connection, graphRef);
		if (confirmed.resolvedRef !== sourceCommit) throw new Error('The knowledge source changed while search was running.');
		for (const result of results) {
			const node = result.node;
			const page = pages.find((candidate) => candidate.id === node.id || candidate.id === node.entityId
				|| candidate.source.path === node.path || candidate.source.path === node.data?.path);
			if (!page) continue;
			const existing = ranked.get(page.id);
			if (!existing || result.score > existing.score) ranked.set(page.id, { page, score: result.score });
		}
	}
	return [...ranked.values()].sort((left, right) => right.score - left.score || left.page.title.localeCompare(right.page.title));
}

export async function relatedFederatedKnowledge(context: any, catalog: any, page: FederatedKnowledgePage) {
	const graphRef = page.source.graphRef ?? page.source.commitSha;
	const connection = await resolveKnowledgeGatewayConnection(context.store, {
		projectId: page.source.projectId, write: false, readRefs: [graphRef],
	});
	if (!connection) throw new Error(`TreeDX repository is unavailable for project ${page.source.projectId}.`);
	const result = await connection.client.getRelated({ repoId: connection.repositoryId, ref: graphRef, nodeId: page.id,
		options: { direction: 'both', depth: 1, maxNodes: 40 } });
	if (String(result.resolvedRef ?? '') !== page.source.commitSha) {
		throw new Error('The knowledge source changed while relationships were loading.');
	}
	const graph = record(result.graph ?? result);
	const identifiers = new Set((Array.isArray(graph.nodes) ? graph.nodes : []).flatMap((node: any) =>
		[String(node.id ?? ''), String(node.entityId ?? ''), String(node.path ?? ''), String(node.data?.path ?? '')]).filter(Boolean));
	return (catalog.pages as FederatedKnowledgePage[]).filter((candidate) => candidate.id !== page.id
		&& (identifiers.has(candidate.id) || Boolean(candidate.source.path && identifiers.has(candidate.source.path))));
}
