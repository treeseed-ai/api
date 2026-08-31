import { createHash } from 'node:crypto';
import type { R2S3PublicationClient } from '../../api/providers/cloudflare/r2-s3-publication-client.ts';

const sha256 = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
export const TREE_DX_MIRROR_SCHEMA = 'treeseed.treedx-r2-file-mirror/v2';
export const TREE_DX_MIRROR_SKIPPED_SCHEMA = 'treeseed.treedx-r2-file-mirror-skipped/v1';
type MirrorEntry = { path: string; objectKey: string; sha256: string; byteLength: number; contentType: string;
	treeDxObjectId: string | null; treeDxContentHash: string | null };

function safePath(value: unknown) {
	const path = String(value ?? '').replace(/^\/+|\/+$/gu, '');
	if (!path || path.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error(`TreeDX returned an unsafe repository path: ${String(value ?? '')}`);
	return path;
}

const projectRoot = (teamId: string, projectId: string) => `teams/${encodeURIComponent(teamId)}/projects/${encodeURIComponent(projectId)}`;
const manifestKey = (teamId: string, projectId: string) => `_treeseed/mirrors/teams/${encodeURIComponent(teamId)}/projects/${encodeURIComponent(projectId)}/manifest.json`;

export function resolveCanonicalTreeDxRef(refs: any[], branch: string, configuredRef: unknown) {
	const canonicalNames = [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`];
	const normalized = String(configuredRef ?? '').trim();
	const target = (ref: any) => String(ref?.target ?? ref?.sha ?? '');
	if (canonicalNames.includes(normalized)) {
		const configured = refs.find((ref) => ref?.name === normalized);
		if (configured) return { name: normalized, commit: target(configured) };
	}
	if (/^[a-f0-9]{40}$/u.test(normalized)) {
		for (const name of canonicalNames) {
			const configured = refs.find((ref) => ref?.name === name && target(ref) === normalized);
			if (configured) return { name, commit: normalized };
		}
	}
	for (const name of canonicalNames) {
		const fallback = refs.find((ref) => ref?.name === name);
		if (fallback) return { name, commit: target(fallback) };
	}
	return { name: canonicalNames[0]!, commit: '' };
}

async function listBlobEntries(connection: any, ref: string) {
	const entries: any[] = []; let cursor: string | undefined;
	for (let pageNumber = 0; pageNumber < 10_000; pageNumber += 1) {
		const response = await connection.client.listRepositoryPaths({ repoId: connection.repositoryId, ref,
			paths: ['**'], kinds: ['blob'], limit: 500, allowProtected: true, ...(cursor ? { cursor } : {}) });
		const pageEntries = Array.isArray(response?.entries) ? response.entries : Array.isArray(response?.query?.entries) ? response.query.entries : [];
		entries.push(...pageEntries.map((entry: any) => ({ path: safePath(entry?.path),
			contentHash: String(entry?.contentHash ?? '').trim() || null, objectId: String(entry?.objectId ?? entry?.sha ?? '').trim() || null })));
		const page = response?.page ?? response?.query?.page ?? {};
		if (!page.hasMore) return [...new Map(entries.map((entry) => [entry.path, entry])).values()].sort((a, b) => a.path.localeCompare(b.path));
		const next = String(page.nextCursor ?? '').trim();
		if (!next || next === cursor) throw new Error('TreeDX path pagination did not advance.'); cursor = next;
	}
	throw new Error('TreeDX repository path listing exceeded the bounded page limit.');
}

function decodeBlob(response: any, expectedPath: string) {
	const blob = response?.blob ?? response;
	if (safePath(blob?.path) !== expectedPath || blob?.encoding !== 'base64' || typeof blob?.contentBase64 !== 'string') throw new Error(`TreeDX returned an invalid blob response for ${expectedPath}.`);
	const bytes = new Uint8Array(Buffer.from(blob.contentBase64, 'base64'));
	if (Number.isInteger(blob.byteLength) && blob.byteLength !== bytes.byteLength) throw new Error(`TreeDX blob byte length did not match for ${expectedPath}.`);
	return { bytes, contentType: String(blob.contentType || 'application/octet-stream'),
		objectId: String(blob.objectId ?? blob.sha ?? '').trim() || null, contentHash: String(blob.contentHash ?? '').trim() || null };
}

async function mapConcurrent<T, R>(values: T[], concurrency: number, run: (value: T) => Promise<R>) {
	const results = new Array<R>(values.length); let index = 0;
	await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
		for (;;) { const current = index++; if (current >= values.length) return; results[current] = await run(values[current]!); }
	})); return results;
}

async function previousManifest(client: R2S3PublicationClient, key: string) {
	const object = await client.get(key); if (!object) return null;
	try { const value = JSON.parse(object.body); return value?.schemaVersion === TREE_DX_MIRROR_SCHEMA ? value : null; } catch { return null; }
}

export async function mirrorTreeDxCommit(input: { client: R2S3PublicationClient; connection: any; teamId: string;
	projectId: string; projectSlug: string; repositoryId: string; commitSha: string; sourceRef: string }) {
	const root = projectRoot(input.teamId, input.projectId), indexKey = manifestKey(input.teamId, input.projectId);
	const prior = await previousManifest(input.client, indexKey);
	const priorByPath = new Map<string, MirrorEntry>((Array.isArray(prior?.files) ? prior.files : []).map((entry: MirrorEntry) => [entry.path, entry]));
	const listed = await listBlobEntries(input.connection, input.sourceRef); let uploadedFiles = 0, unchangedFiles = 0;
	const entries = await mapConcurrent(listed, 8, async (listedEntry): Promise<MirrorEntry> => {
		const priorEntry = priorByPath.get(listedEntry.path);
		if (priorEntry && listedEntry.contentHash && priorEntry.treeDxContentHash === listedEntry.contentHash && await input.client.exists(priorEntry.objectKey)) {
			unchangedFiles += 1; return priorEntry;
		}
		const response = await input.connection.client.readRepositoryBlob({ repoId: input.repositoryId,
			ref: input.sourceRef, path: listedEntry.path, encoding: 'base64', allowProtected: true });
		const blob = decodeBlob(response, listedEntry.path), digest = sha256(blob.bytes), objectKey = `${root}/${listedEntry.path}`;
		if (priorEntry?.sha256 === digest && priorEntry.objectKey === objectKey && await input.client.exists(objectKey)) {
			unchangedFiles += 1;
			return { ...priorEntry, treeDxObjectId: blob.objectId, treeDxContentHash: blob.contentHash };
		}
		await input.client.putBytes(objectKey, blob.bytes, { contentType: blob.contentType, metadata: { sha256: digest,
			'team-id': input.teamId, 'project-id': input.projectId, 'commit-sha': input.commitSha, 'treedx-path': listedEntry.path } });
		const readback = await input.client.getBytes(objectKey);
		if (!readback || sha256(readback.body) !== digest) throw new Error(`R2 verification failed for ${listedEntry.path}.`);
		uploadedFiles += 1;
		return { path: listedEntry.path, objectKey, sha256: digest, byteLength: blob.bytes.byteLength,
			contentType: blob.contentType, treeDxObjectId: blob.objectId, treeDxContentHash: blob.contentHash };
	});
	const expectedKeys = new Set(entries.map((entry) => entry.objectKey));
	const staleKeys = (await input.client.list(`${root}/`)).filter((key) => !expectedKeys.has(key));
	await mapConcurrent(staleKeys, 8, (key) => input.client.delete(key));
	const generatedAt = new Date().toISOString();
	const manifest = { schemaVersion: TREE_DX_MIRROR_SCHEMA, team: { id: input.teamId }, project: { id: input.projectId, slug: input.projectSlug },
		repositoryId: input.repositoryId, commitSha: input.commitSha, sourceRef: input.sourceRef, generatedAt, fileCount: entries.length, files: entries };
	const manifestBody = `${JSON.stringify(manifest, null, 2)}\n`;
	await input.client.put(indexKey, manifestBody, { contentType: 'application/json; charset=utf-8',
		metadata: { sha256: sha256(manifestBody), 'team-id': input.teamId, 'project-id': input.projectId, 'commit-sha': input.commitSha } });
	return { schemaVersion: TREE_DX_MIRROR_SCHEMA, root, manifestKey: indexKey, commitSha: input.commitSha,
		fileCount: entries.length, uploadedFiles, unchangedFiles, deletedFiles: staleKeys.length,
		totalBytes: entries.reduce((sum, entry) => sum + entry.byteLength, 0), manifestSha256: sha256(manifestBody), verifiedAt: generatedAt };
}

export function isR2ReplicationReceipt(value: any, commitSha: string) {
	if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return false; } }
	return (value?.schemaVersion === TREE_DX_MIRROR_SCHEMA && value?.commitSha === commitSha && Number.isInteger(value?.fileCount)
		&& typeof value?.manifestKey === 'string') || (value?.schemaVersion === TREE_DX_MIRROR_SKIPPED_SCHEMA && value?.commitSha === commitSha);
}
