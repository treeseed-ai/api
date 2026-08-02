function record(value: unknown): Record<string, any> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}

function text(value: unknown, maximum = 500) {
	const normalized = typeof value === 'string' ? value.trim() : '';
	return normalized ? normalized.slice(0, maximum) : null;
}

function publicProject(project: any) {
	const metadata = record(project?.metadata);
	const declared = record(metadata.metadata);
	const visibility = String(declared.visibility ?? metadata.visibility ?? 'private').toLowerCase();
	if (visibility !== 'public') return null;
	return {
		id: project.id,
		slug: project.slug,
		name: project.name,
		summary: project.description ?? null,
		updatedAt: project.updatedAt ?? project.createdAt,
	};
}

function catalogHref(item: any) {
	const collection = item.kind === 'knowledge_pack' ? 'knowledge-packs' : item.kind === 'template' ? 'templates' : 'products';
	return `/market/${collection}/${encodeURIComponent(item.slug)}/`;
}

function publicCatalogItem(item: any, latest: any = null) {
	return {
		id: item.id,
		kind: item.kind,
		slug: item.slug,
		title: item.title,
		summary: item.summary ?? null,
		offerMode: item.offerMode ?? 'private',
		version: latest?.version ?? null,
		href: catalogHref(item),
		updatedAt: latest?.publishedAt ?? item.updatedAt ?? item.createdAt,
	};
}

function trailEntry(item: any, source: 'catalog' | 'knowledge' | 'project') {
	const type = source === 'project' ? 'project' : item.kind === 'template' ? 'template' : 'knowledge_pack';
	return {
		id: `${source}:${item.id}`,
		type,
		title: item.title ?? item.name,
		summary: item.summary ?? null,
		href: item.href ?? null,
		occurredAt: item.updatedAt,
		action: source === 'project' ? 'Project maintained' : source === 'knowledge' ? 'Knowledge pack updated' : 'Published to the catalog',
	};
}

export async function publicTeamKnowledgeProfile(store: any, teamId: string) {
	const catalogItems = await store.listCatalogItems(null, { teamId });
	const catalog = await Promise.all(catalogItems.map(async (item: any) => {
		const latest = (await store.listCatalogArtifactVersions(item.id))[0] ?? null;
		return publicCatalogItem(item, latest);
	}));
	const knowledgePacks = catalog.filter((item: any) => item.kind === 'knowledge_pack');
	const projects = (await store.listTeamProjects(teamId)).map(publicProject).filter(Boolean);
	const trail = [
		...catalog.map((item: any) => trailEntry(item, 'catalog')),
		...projects.map((item: any) => trailEntry({ ...item, title: item.name }, 'project')),
	].filter((item) => item.occurredAt).sort((left, right) => String(right.occurredAt).localeCompare(String(left.occurredAt))).slice(0, 24);
	return {
		stats: {
			templates: catalog.filter((item: any) => item.kind === 'template').length,
			knowledgePacks: knowledgePacks.length,
			projects: projects.length,
			publications: catalog.length,
		},
		catalog,
		knowledgePacks,
		projects,
		trail,
	};
}

export async function publicUserKnowledgeProfile(store: any, userId: string) {
	const rows = await store.all(`SELECT contributions.id, contributions.role, contributions.summary,
			contributions.effective_at, items.id AS item_id, items.kind, items.slug, items.title,
			items.summary AS item_summary, items.offer_mode, items.updated_at
		FROM commerce_contributions contributions
		INNER JOIN catalog_items items ON items.id = contributions.product_id
		WHERE contributions.contributor_type = 'user'
		  AND contributions.contributor_id = ?
		  AND contributions.attribution_visibility = 'public'
		  AND items.visibility = 'public'
		  AND items.listing_enabled = 1
		ORDER BY contributions.effective_at DESC
		LIMIT 100`, [userId]);
	const contributions = rows.map((row: any) => ({
		id: row.id,
		role: text(row.role, 80),
		summary: text(row.summary, 500),
		effectiveAt: row.effective_at,
		item: publicCatalogItem({
			id: row.item_id,
			kind: row.kind,
			slug: row.slug,
			title: row.title,
			summary: row.item_summary,
			offerMode: row.offer_mode,
			updatedAt: row.updated_at,
		}),
	}));
	return {
		stats: {
			contributions: contributions.length,
			templates: new Set(contributions.filter((entry: any) => entry.item.kind === 'template').map((entry: any) => entry.item.id)).size,
			knowledgePacks: new Set(contributions.filter((entry: any) => entry.item.kind === 'knowledge_pack').map((entry: any) => entry.item.id)).size,
		},
		contributions,
		trail: contributions.map((entry: any) => ({
			id: `contribution:${entry.id}`,
			type: entry.item.kind,
			title: entry.item.title,
			summary: entry.summary,
			href: entry.item.href,
			occurredAt: entry.effectiveAt,
			action: entry.role ? `Contributed as ${entry.role}` : 'Public contribution',
		})),
	};
}

export function publicUserProfileMetadata(metadataValue: unknown) {
	const metadata = record(metadataValue);
	const expertise = Array.isArray(metadata.expertise)
		? metadata.expertise.map((entry: unknown) => text(entry, 48)).filter(Boolean).slice(0, 8)
		: [];
	const website = text(metadata.website, 240);
	return {
		headline: text(metadata.headline, 120),
		profileSummary: text(metadata.profileSummary, 600),
		location: text(metadata.location, 100),
		website: website?.startsWith('https://') ? website : null,
		expertise,
	};
}
