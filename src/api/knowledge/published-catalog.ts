import { createHash } from 'node:crypto';
import type { KnowledgePublicationManifest } from '@treeseed/sdk/knowledge';
import { canonicalKnowledgePublicationValue } from './build-publication.ts';
import type { KnowledgePublicationStorage } from './publication-storage.ts';
import type { KnowledgeSnapshotProject } from '@treeseed/sdk/knowledge-packs';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');

async function publicationPayload(storage: KnowledgePublicationStorage, entry: any) {
	const body = await storage.readObject(entry.content.objectKey);
	if (!body || digest(body) !== entry.content.sha256 || Buffer.byteLength(body) !== entry.content.byteSize) {
		throw new Error(`Published knowledge object ${entry.id} is missing or corrupt.`);
	}
	return JSON.parse(body);
}

export async function loadPublishedTeamCatalog(input: { storage: KnowledgePublicationStorage;
	manifest: KnowledgePublicationManifest; teamSlug: string; projectIds: Set<string> }) {
	const { digest: expectedDigest, ...unsigned } = input.manifest;
	if (digest(canonicalKnowledgePublicationValue(unsigned)) !== expectedDigest) {
		throw new Error('The knowledge publication manifest digest is invalid.');
	}
	const books: any[] = [];
	const pages: any[] = [];
	for (const entry of input.manifest.entries) {
		if (!input.projectIds.has(entry.projectId)) continue;
		const payload = await publicationPayload(input.storage, entry);
		const project = input.manifest.projects.find((candidate) => candidate.projectId === entry.projectId);
		if (!project || payload?.definition?.id !== entry.id || payload?.definition?.visibility !== entry.visibility
			|| payload?.definition?.status !== entry.status) {
			throw new Error(`Published knowledge object ${entry.id} does not match its manifest.`);
		}
		const item = { ...payload.definition, source: { teamId: input.manifest.teamId, teamSlug: input.teamSlug,
			projectId: entry.projectId, repositoryId: project.repositoryId, commitSha: project.commitSha,
			graphRef: project.ref, path: entry.sourcePath } };
		if (entry.kind === 'book') books.push(item);
		else pages.push(item);
	}
	return { books, pages, revision: input.manifest.revision };
}

export async function loadPublishedKnowledgeSnapshots(storage: KnowledgePublicationStorage,
	manifest: KnowledgePublicationManifest): Promise<KnowledgeSnapshotProject[]> {
	const projects = new Map(manifest.projects.map((project) => [project.projectId, {
		teamId: project.teamId, projectId: project.projectId, repositoryId: project.repositoryId,
		commitSha: project.commitSha, books: [], pages: [], bookSourcePaths: {},
	} as KnowledgeSnapshotProject]));
	for (const entry of manifest.entries) {
		if (entry.status !== 'published') continue;
		const project = projects.get(entry.projectId);
		if (!project) throw new Error(`Published knowledge project ${entry.projectId} is missing.`);
		const payload = await publicationPayload(storage, entry);
		if (entry.kind === 'book') {
			project.books.push(payload.definition);
			project.bookSourcePaths![entry.id] = entry.sourcePath;
		} else project.pages.push({ definition: payload.definition, source: String(payload.sourceMarkdown ?? ''), sourcePath: entry.sourcePath });
	}
	return [...projects.values()];
}
