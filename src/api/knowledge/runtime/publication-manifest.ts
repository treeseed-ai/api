import type { KnowledgePublicationManifest } from '@treeseed/sdk/knowledge';

const visibilityKeys = ['public', 'authenticated', 'team', 'project', 'admin'] as const;
export function parseKnowledgePublicationManifest(value: unknown): KnowledgePublicationManifest {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid knowledge publication manifest.');
	const input = value as Record<string, any>; if (input.schemaVersion !== 'treeseed.knowledge-publication/v1') throw new Error('Unsupported knowledge publication schema.');
	const entries = Array.isArray(input.entries) ? input.entries : []; const indexes = input.indexes && typeof input.indexes === 'object' ? input.indexes : {};
	for (const key of visibilityKeys) if (!Array.isArray(indexes[key])) throw new Error(`Knowledge publication index ${key} is missing.`);
	for (const entry of entries) if (!['book', 'page'].includes(entry?.kind) || !visibilityKeys.includes(entry?.visibility) || !['published', 'archived'].includes(entry?.status) || !entry?.content) throw new Error('Invalid knowledge publication entry.');
	const text = (entry: unknown, label: string) => { if (typeof entry !== 'string' || !entry.trim()) throw new Error(`Invalid knowledge publication ${label}.`); return entry.trim(); };
	return { schemaVersion: 'treeseed.knowledge-publication/v1', teamId: text(input.teamId, 'team'), revision: text(input.revision, 'revision'), generatedAt: text(input.generatedAt, 'generated time'), previousRevision: input.previousRevision ? text(input.previousRevision, 'previous revision') : undefined, sourceClosure: text(input.sourceClosure, 'source closure'), projects: Array.isArray(input.projects) ? input.projects : [], entries, indexes: Object.fromEntries(visibilityKeys.map((key) => [key, [...new Set(indexes[key].map(String))].sort()])), digest: text(input.digest, 'digest') } as KnowledgePublicationManifest;
}
