import type { APIContext } from 'astro';
import { listSiteTemplates, resolveSiteTemplate } from '@treeseed/core/templates';
import { createApiFacade } from './api-client.js';
import { createMarketTemplateCatalogProvider } from './catalog.js';
import { resolveApiStore, resolveMarketPrincipal } from './store.js';

type AstroLike = Pick<APIContext, 'locals' | 'cookies' | 'url' | 'request'>;

export interface MarketplaceContext {
	store: any | null;
	principal: any | null;
}

export function loadMarketplaceContext(context: AstroLike): MarketplaceContext {
	return {
		store: resolveApiStore(context),
		principal: resolveMarketPrincipal(context.locals),
	};
}

export async function listMarketplaceKnowledgePacks(context: AstroLike) {
	const { store, principal } = loadMarketplaceContext(context);
	return store ? await store.listKnowledgePacks(principal).catch(() => []) : [];
}

export function listMarketplaceSiteTemplates(context: AstroLike) {
	return listSiteTemplates({
		locals: context.locals,
		catalogProvider: createMarketTemplateCatalogProvider(context),
	});
}

export function resolveMarketplaceSiteTemplate(context: AstroLike, slug: string) {
	return resolveSiteTemplate(slug, {
		locals: context.locals,
		catalogProvider: createMarketTemplateCatalogProvider(context),
	});
}

export async function resolveMarketplaceCatalogItem(context: AstroLike, kind: string, slug: string) {
	const { store } = loadMarketplaceContext(context);
	const entry = store ? await store.getCatalogItemBySlug(kind, slug).catch(() => null) : null;
	const artifacts = entry && store ? await store.listCatalogArtifactVersions(entry.id).catch(() => []) : [];
	return { entry, artifacts };
}

export async function resolveMarketplaceTeamProfile(context: AstroLike, name: string) {
	const { store, principal } = loadMarketplaceContext(context);
	return store ? await store.loadTeamProfileByName(name, principal).catch(() => null) : null;
}

export async function resolveMarketplaceUserProfile(context: AstroLike, username: string) {
	return await createApiFacade(context).loadUserProfileByUsername(username).catch(() => null);
}
