import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = (path: string) => readFileSync(path, 'utf8');

describe('contextual knowledge API architecture', () => {
	it('serves contextual help from federated TreeDX knowledge rather than a help filesystem', () => {
		const routes = source('src/api/routes/support/contextual-knowledge.ts');
		const catalog = source('src/api/knowledge/federated-catalog.ts');
		expect(routes).toContain("'/v1/knowledge/context'");
		expect(routes).toContain("'/v1/knowledge/pages/:pageId'");
		expect(routes).toContain("'/v1/knowledge/search'");
		expect(routes).toContain("'/v1/knowledge/library'");
		expect(routes).toContain("'/v1/knowledge/reader'");
		expect(routes).toContain('loadFederatedKnowledgeCatalog');
		expect(catalog).toContain('listRepositoryPaths');
		expect(catalog).toContain('readRepositoryFiles');
		expect(catalog).toContain('parseFrontmatter: true');
		expect(catalog).toContain('TreeDX did not parse frontmatter');
		expect(routes).not.toMatch(/TREESEED_HELP|content\/help|loadHelpCatalog/u);
	});

	it('derives authorization scope and canonical routes from repository records', () => {
		const routes = source('src/api/routes/support/contextual-knowledge.ts');
		const catalog = source('src/api/knowledge/federated-catalog.ts');
		const gateway = source('src/api/knowledge/gateway-treedx-connection.ts');
		expect(routes).toContain('page.source.teamId');
		expect(routes).toContain('page.source.projectId');
		expect(routes).toContain('page.source.teamSlug');
		expect(routes).toContain('page.source.bookSlug');
		expect(routes).not.toContain('scopeFromQuery');
		expect(catalog).toContain('listPublicProjects');
		expect(gateway).toContain('TREESEED_TREEDX_PROXY_ACTOR_ID');
		expect(gateway).toContain("'treeseed-control-plane'");
		expect(gateway).not.toContain('actorUserId');
	});

	it('has removed the custom help model and API route implementation', () => {
		expect(existsSync('src/api/routes/support/contextual-help.ts')).toBe(false);
		expect(existsSync('../sdk/src/help/catalog.ts')).toBe(false);
	});

	it('keeps relationship search and backlink inspection on the authorized TreeDX gateway', () => {
		const authoring = source('src/api/routes/knowledge/authoring.ts');
		const relationSearch = source('src/api/routes/knowledge/relation-search.ts');
		expect(authoring).toContain("'/v1/projects/:projectId/knowledge/relations/search'");
		expect(authoring).toContain("'/v1/knowledge/workspaces/:workspaceId/relations/search'");
		expect(relationSearch).toContain('searchRepositoryFiles');
		expect(relationSearch).toContain('entry.frontmatter?.id');
		expect(authoring).toContain('relatedKnowledgeIds.includes');
		expect(`${authoring}\n${relationSearch}`).not.toMatch(/readFileSync|writeFileSync/gu);
	});
});
