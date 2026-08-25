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

function trailEntry(item: any) {
	return {
		id: `project:${item.id}`,
		type: 'project',
		title: item.title ?? item.name,
		summary: item.summary ?? null,
		href: item.href ?? null,
		occurredAt: item.updatedAt,
		action: 'Project maintained',
	};
}

export async function publicTeamKnowledgeProfile(store: any, teamId: string) {
	const projects = (await store.listTeamProjects(teamId)).map(publicProject).filter(Boolean);
	const trail = projects.map((item: any) => trailEntry({ ...item, title: item.name }))
		.filter((item) => item.occurredAt)
		.sort((left, right) => String(right.occurredAt).localeCompare(String(left.occurredAt)))
		.slice(0, 24);
	return {
		stats: {
			templates: 0,
			knowledgePacks: 0,
			projects: projects.length,
			publications: 0,
		},
		catalog: [],
		knowledgePacks: [],
		projects,
		trail,
	};
}

export async function publicUserKnowledgeProfile(_store: any, _userId: string) {
	return {
		stats: {
			contributions: 0,
			templates: 0,
			knowledgePacks: 0,
		},
		contributions: [],
		trail: [],
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
