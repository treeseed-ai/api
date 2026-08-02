import { parseBook, parseKnowledgePage, serializeBookDraft, serializeKnowledgePageDraft } from '@treeseed/sdk/knowledge';
import { simulationEvidence } from '../../store/governance/policy/support/simulation-evidence.ts';

export const list = (value: unknown) => (Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [])
	.map((item) => String(item).trim()).filter(Boolean);
export const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
export const requestId = (value: unknown) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(text(value))
	? text(value) : '';
export const object = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

export async function assertSimulatedProductionPolicy(store: any, workspace: any, body: any) {
	const simulation = simulationEvidence(body);
	if (simulation.productionAuthorityRequested !== true) return { simulation, production: false };
	const project = await store.getProject(workspace.projectId);
	const metadata = object(project?.metadata);
	if (metadata.allowSimulatedHumanProductionApproval !== true) {
		throw Object.assign(new Error('This project does not allow simulated-human production approval.'), { status: 403, code: 'simulated_human_production_policy_required' });
	}
	return { simulation, production: true };
}

export function pageDocument(body: any, status: 'published' | 'archived'): string {
	return serializeKnowledgePageDraft({
		id: text(body.id), bookId: text(body.bookId), slug: text(body.slug), title: text(body.title),
		summary: text(body.summary), status, visibility: body.visibility ?? 'team',
		order: Number(body.order ?? 0), parentId: text(body.parentId) || undefined, tags: list(body.tags),
		contributors: list(body.contributors), relatedBookIds: list(body.relatedBookIds),
		relatedKnowledgeIds: list(body.relatedKnowledgeIds), relatedNoteIds: list(body.relatedNoteIds),
		relatedQuestionIds: list(body.relatedQuestionIds), relatedObjectiveIds: list(body.relatedObjectiveIds),
		relatedProposalIds: list(body.relatedProposalIds), relatedDecisionIds: list(body.relatedDecisionIds),
		guaranteeIds: list(body.guaranteeIds), audiences: body.audiences ?? { primary: [], secondary: [], excluded: [] },
		context: { capabilityIds: list(body.capabilityIds), routePatterns: list(body.routePatterns),
			resourceTypes: list(body.resourceTypes), actionIds: list(body.actionIds), keywords: list(body.keywords),
			documentationUrls: list(body.documentationUrls) }, bodyMarkdown: String(body.bodyMarkdown ?? ''),
	});
}

export function bookDocument(body: any, status: 'published' | 'archived'): string {
	return serializeBookDraft({
		id: text(body.id), slug: text(body.slug), title: text(body.title), summary: text(body.summary),
		description: text(body.description) || text(body.summary), status, visibility: body.visibility ?? 'team',
		order: Number(body.order ?? 0), topics: list(body.topics), audience: list(body.audience),
		relatedBookIds: list(body.relatedBookIds), editorialCoreNoteId: text(body.editorialCoreNoteId) || undefined,
		packPolicy: body.packPolicy ?? 'allowed', cover: body.cover && typeof body.cover === 'object' ? body.cover : undefined,
	});
}

export async function workspaceAccess(context: any, c: any, permission: string) {
	const workspace = await context.store.getKnowledgeWorkspace(c.req.param('workspaceId'));
	if (!workspace) return { response: context.jsonError(c, 404, 'Knowledge workspace not found.') };
	const access = await context.requireProjectAccess(c, context.store, workspace.projectId, permission);
	if (access.response) return access;
	if (permission === 'knowledge:read' && workspace.actorUserId !== access.principal.id) {
		const reviewAccess = await context.requireProjectAccess(c, context.store, workspace.projectId, 'knowledge:review');
		if (reviewAccess.response) return { response: context.jsonError(c, 404, 'Knowledge workspace not found.') };
	}
	return { ...access, workspace };
}

export function allowedWorkspacePath(workspace: any, path: string) {
	if (!path || path.startsWith('/') || path.split('/').some((part) => !part || part === '.' || part === '..')) return false;
	return workspace.allowedPaths.some((pattern: string) => path.startsWith(pattern.replace(/\*\*$/u, '')));
}

async function canReadCatalogEntry(context: any, c: any, entry: any) {
	if (entry.visibility === 'admin') {
		const auth = await context.ensurePrincipal(c);
		if (auth.response || !context.principalHasGlobalPlatformRole(auth.principal)) return false;
	}
	if (entry.visibility === 'project' && (await context.requireProjectAccess(c, context.store, entry.source.projectId, 'knowledge:read')).response) return false;
	if (entry.status === 'published') return true;
	for (const permission of ['knowledge:author', 'knowledge:review', 'knowledge:manage-books']) {
		if (!(await context.requireProjectAccess(c, context.store, entry.source.projectId, permission)).response) return true;
	}
	return false;
}

export async function authorizedCatalog(context: any, c: any, catalog: any) {
	const bookDecisions = await Promise.all(catalog.books.map((book: any) => canReadCatalogEntry(context, c, book)));
	const books = catalog.books.filter((_book: any, index: number) => bookDecisions[index]);
	const bookIds = new Set(books.map((book: any) => book.id));
	const pageDecisions = await Promise.all(catalog.pages.map((page: any) => canReadCatalogEntry(context, c, page)));
	const pages = catalog.pages.filter((page: any, index: number) => bookIds.has(page.bookId) && pageDecisions[index]);
	return { books, pages };
}

export { parseBook, parseKnowledgePage };
