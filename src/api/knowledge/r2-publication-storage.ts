import { createR2PublicationClient,type R2PublicationConfig } from '@treeseed/sdk/platform/published-content';
import { parseKnowledgePublicationManifest,type KnowledgePublicationManifest } from '@treeseed/sdk/knowledge';
import type { KnowledgePublicationStorage } from './publication-storage.ts';

const safeSegment = (value: string) => {
	const result = String(value).trim();
	if (!/^[a-zA-Z0-9._:-]+$/u.test(result)) throw new Error('Unsafe R2 publication storage segment.');
	return result;
};

function configFromEnvironment(env: NodeJS.ProcessEnv = process.env): R2PublicationConfig {
	const common = {
		accountId: String(env.TREESEED_CLOUDFLARE_ACCOUNT_ID ?? ''),
		bucket: String(env.TREESEED_CONTENT_BUCKET_NAME ?? ''),
	};
	const apiToken = String(env.TREESEED_CLOUDFLARE_API_TOKEN ?? '');
	const config: R2PublicationConfig = apiToken
		? { ...common, authMode: 'api-token', apiToken }
		: { ...common, authMode: 's3', accessKeyId: String(env.TREESEED_R2_ACCESS_KEY_ID ?? ''), secretAccessKey: String(env.TREESEED_R2_SECRET_ACCESS_KEY ?? '') };
	const missing = Object.entries(config).filter(([, value]) => !value).map(([key]) => key);
	if (missing.length) throw new Error(`R2 knowledge publication storage is missing: ${missing.join(', ')}.`);
	return config;
}

const manifestObjects = (manifest: KnowledgePublicationManifest) => new Set(manifest.entries.map((entry) => entry.content.objectKey));

export function createR2KnowledgePublicationStorage(options: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch } = {}): KnowledgePublicationStorage {
	const client = createR2PublicationClient(configFromEnvironment(options.env), options.fetchImpl ?? fetch);
	const currentKey = (teamId: string) => `teams/${safeSegment(teamId)}/published/common.json`;
	const revisionKey = (teamId: string, revision: string) => `teams/${safeSegment(teamId)}/published/manifests/${safeSegment(revision)}.json`;
	const readManifest = async (objectKey: string) => {
		const object = await client.get(objectKey);
		return object ? { manifest: parseKnowledgePublicationManifest(JSON.parse(object.body)), etag: object.etag } : null;
	};
	return {
		async readCurrent(teamId) { return (await readManifest(currentKey(teamId)))?.manifest ?? null; },
		async readRevision(teamId, revision) { return (await readManifest(revisionKey(teamId, revision)))?.manifest ?? null; },
		async listRevisions(teamId) {
			const keys = await client.list(`teams/${safeSegment(teamId)}/published/manifests/`);
			const values = await Promise.all(keys.map(readManifest));
			return values.map((value) => value?.manifest).filter((value): value is KnowledgePublicationManifest => Boolean(value));
		},
		async readObject(objectKey) { return (await client.get(objectKey))?.body ?? null; },
		async publish({ manifest, objects, expectedRevision }) {
			const current = await readManifest(currentKey(manifest.teamId));
			if ((current?.manifest.revision ?? undefined) !== expectedRevision) throw new Error('The published knowledge revision changed before R2 promotion.');
			for (const object of objects) {
				const existing = await client.get(object.key);
				if (existing && existing.body !== object.body) throw new Error('An immutable publication object digest collided with different content.');
				if (!existing) await client.put(object.key, object.body, { contentType: 'application/json; charset=utf-8', ifNoneMatch: '*' });
			}
			const body = `${JSON.stringify(manifest, null, 2)}\n`;
			const revision = await client.get(revisionKey(manifest.teamId, manifest.revision));
			if (revision && revision.body !== body) throw new Error('An immutable publication revision already contains different content.');
			if (!revision) await client.put(revisionKey(manifest.teamId, manifest.revision), body, { contentType: 'application/json; charset=utf-8', ifNoneMatch: '*' });
			await client.put(currentKey(manifest.teamId), body, { contentType: 'application/json; charset=utf-8', ...(current?.etag ? { ifMatch: current.etag } : { ifNoneMatch: '*' as const }) });
		},
		async rollback({ teamId, revision, expectedRevision }) {
			const target = await this.readRevision(teamId, revision);
			if (!target) throw new Error('The requested knowledge publication revision was not found.');
			await this.publish({ manifest: target, objects: [], expectedRevision });
			return target;
		},
		async retireRevisions({ teamId, revisions, expectedCurrentRevision }) {
			const current = await this.readCurrent(teamId);
			if (current?.revision !== expectedCurrentRevision) throw new Error('The published knowledge revision changed before revision retirement.');
			const requested = new Set(revisions.map(safeSegment));
			if (requested.has(current.revision) || (current.previousRevision && requested.has(current.previousRevision))) throw new Error('A current or rollback knowledge revision cannot be retired.');
			const all = await this.listRevisions!(teamId);
			const retiring = all.filter((item) => requested.has(item.revision));
			if (retiring.length !== requested.size) throw new Error('A requested knowledge revision was not found.');
			const retained = new Set(all.filter((item) => !requested.has(item.revision)).flatMap((item) => [...manifestObjects(item)]));
			const removedObjects = [...new Set(retiring.flatMap((item) => [...manifestObjects(item)]))].filter((item) => !retained.has(item));
			await Promise.all(removedObjects.map((item) => client.delete(item)));
			await Promise.all(retiring.map((item) => client.delete(revisionKey(teamId, item.revision))));
			return { revisionsRemoved: retiring.map((item) => item.revision), objectsRemoved: removedObjects };
		},
	};
}
