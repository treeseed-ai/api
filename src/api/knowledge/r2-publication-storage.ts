import { createHash, createHmac } from 'node:crypto';
import { parseKnowledgePublicationManifest, type KnowledgePublicationManifest } from '@treeseed/sdk/knowledge';
import type { KnowledgePublicationStorage } from './publication-storage.ts';

type R2Config = { accountId: string; accessKeyId: string; secretAccessKey: string; bucket: string; prefix: string };

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const hmac = (key: string | Buffer, value: string) => createHmac('sha256', key).update(value).digest();
const safeSegment = (value: string) => {
	const result = String(value).trim();
	if (!/^[a-zA-Z0-9._:-]+$/u.test(result)) throw new Error('Unsafe R2 publication storage segment.');
	return result;
};

function configFromEnvironment(env: NodeJS.ProcessEnv = process.env): R2Config {
	const config = {
		accountId: String(env.TREESEED_CLOUDFLARE_ACCOUNT_ID ?? ''),
		accessKeyId: String(env.TREESEED_R2_ACCESS_KEY_ID ?? ''),
		secretAccessKey: String(env.TREESEED_R2_SECRET_ACCESS_KEY ?? ''),
		bucket: String(env.TREESEED_CONTENT_BUCKET_NAME ?? ''),
		prefix: String(env.TREESEED_KNOWLEDGE_PUBLICATION_PREFIX ?? 'knowledge-publications').replace(/^\/+|\/+$/gu, ''),
	};
	const missing = Object.entries(config).filter(([, value]) => !value).map(([key]) => key);
	if (missing.length) throw new Error(`R2 knowledge publication storage is missing: ${missing.join(', ')}.`);
	return config;
}

function encodePath(value: string) {
	return value.split('/').map((part) => encodeURIComponent(part)).join('/');
}

function awsTimestamp(date: Date) {
	return date.toISOString().replace(/[:-]|\.\d{3}/gu, '');
}

function signedRequest(input: { config: R2Config; method: string; key?: string; query?: URLSearchParams;
	body?: string; headers?: Record<string, string>; date?: Date }) {
	const date = input.date ?? new Date();
	const timestamp = awsTimestamp(date);
	const day = timestamp.slice(0, 8);
	const host = `${input.config.accountId}.r2.cloudflarestorage.com`;
	const path = `/${encodeURIComponent(input.config.bucket)}${input.key ? `/${encodePath(input.key)}` : ''}`;
	const query = input.query ? [...input.query.entries()].sort(([a, av], [b, bv]) => a.localeCompare(b) || av.localeCompare(bv))
		.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&') : '';
	const payloadHash = sha256(input.body ?? '');
	const canonicalHeaders: Record<string, string> = { host, 'x-amz-content-sha256': payloadHash,
		'x-amz-date': timestamp, ...(input.headers ?? {}) };
	const names = Object.keys(canonicalHeaders).map((name) => name.toLowerCase()).sort();
	const normalized = Object.fromEntries(Object.entries(canonicalHeaders).map(([key, value]) => [key.toLowerCase(), value.trim().replace(/\s+/gu, ' ')]));
	const headerBlock = names.map((name) => `${name}:${normalized[name]}\n`).join('');
	const signedHeaders = names.join(';');
	const canonical = [input.method, path, query, headerBlock, signedHeaders, payloadHash].join('\n');
	const scope = `${day}/auto/s3/aws4_request`;
	const stringToSign = `AWS4-HMAC-SHA256\n${timestamp}\n${scope}\n${sha256(canonical)}`;
	const signingKey = hmac(hmac(hmac(hmac(`AWS4${input.config.secretAccessKey}`, day), 'auto'), 's3'), 'aws4_request');
	const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
	return { url: `https://${host}${path}${query ? `?${query}` : ''}`, body: input.body,
		headers: { ...canonicalHeaders,
			authorization: `AWS4-HMAC-SHA256 Credential=${input.config.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` } };
}

function createR2Client(config: R2Config, fetchImpl: typeof fetch) {
	const request = async (method: string, key?: string, options: { body?: string; headers?: Record<string, string>; query?: URLSearchParams } = {}) => {
		const signed = signedRequest({ config, method, key, ...options });
		return fetchImpl(signed.url, { method, headers: signed.headers, body: signed.body });
	};
	return {
		async get(key: string) {
			const response = await request('GET', key);
			if (response.status === 404) return null;
			if (!response.ok) throw new Error(`R2 object read failed (HTTP ${response.status}).`);
			return { body: await response.text(), etag: response.headers.get('etag') };
		},
		async put(key: string, body: string, condition?: { etag?: string; absent?: boolean }) {
			const headers: Record<string, string> = { 'content-type': 'application/json; charset=utf-8' };
			if (condition?.etag) headers['if-match'] = condition.etag;
			if (condition?.absent) headers['if-none-match'] = '*';
			const response = await request('PUT', key, { body, headers });
			if (response.status === 412) throw new Error('The published knowledge revision changed during R2 promotion.');
			if (!response.ok) throw new Error(`R2 object write failed (HTTP ${response.status}).`);
		},
		async delete(key: string) {
			const response = await request('DELETE', key);
			if (!response.ok && response.status !== 404) throw new Error(`R2 object deletion failed (HTTP ${response.status}).`);
		},
		async list(prefix: string) {
			const keys: string[] = [];
			let continuationToken: string | null = null;
			for (let page = 0; page < 10_000; page += 1) {
				const query = new URLSearchParams({ 'list-type': '2', 'max-keys': '1000', prefix });
				if (continuationToken) query.set('continuation-token', continuationToken);
				const response = await request('GET', undefined, { query });
				if (!response.ok) throw new Error(`R2 object listing failed (HTTP ${response.status}).`);
				const xml = await response.text();
				keys.push(...[...xml.matchAll(/<Key>([^<]+)<\/Key>/gu)].map((match) => decodeXml(match[1])));
				const truncated = /<IsTruncated>true<\/IsTruncated>/u.test(xml);
				const next = xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/u)?.[1];
				if (!truncated) return keys;
				if (!next) throw new Error('R2 object listing was truncated without a continuation token.');
				const decoded = decodeXml(next);
				if (decoded === continuationToken) throw new Error('R2 object listing returned a repeated continuation token.');
				continuationToken = decoded;
			}
			throw new Error('R2 object listing exceeded the bounded pagination limit.');
		},
	};
}

function decodeXml(value: string) {
	return value.replace(/&amp;/gu, '&').replace(/&lt;/gu, '<').replace(/&gt;/gu, '>')
		.replace(/&quot;/gu, '"').replace(/&apos;/gu, "'");
}

const manifestObjects = (manifest: KnowledgePublicationManifest) => new Set(manifest.entries.map((entry) => entry.content.objectKey));

export function createR2KnowledgePublicationStorage(options: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch } = {}): KnowledgePublicationStorage {
	const config = configFromEnvironment(options.env);
	const client = createR2Client(config, options.fetchImpl ?? fetch);
	const key = (value: string) => `${config.prefix}/${value}`;
	const currentKey = (teamId: string) => key(`teams/${safeSegment(teamId)}/current.json`);
	const revisionKey = (teamId: string, revision: string) => key(`teams/${safeSegment(teamId)}/revisions/${safeSegment(revision)}.json`);
	const readManifest = async (objectKey: string) => {
		const object = await client.get(objectKey);
		return object ? { manifest: parseKnowledgePublicationManifest(JSON.parse(object.body)), etag: object.etag } : null;
	};
	return {
		async readCurrent(teamId) { return (await readManifest(currentKey(teamId)))?.manifest ?? null; },
		async readRevision(teamId, revision) { return (await readManifest(revisionKey(teamId, revision)))?.manifest ?? null; },
		async listRevisions(teamId) {
			const prefix = key(`teams/${safeSegment(teamId)}/revisions/`);
			const keys = await client.list(prefix);
			const values = await Promise.all(keys.map(readManifest));
			return values.map((value) => value?.manifest).filter((value): value is KnowledgePublicationManifest => Boolean(value));
		},
		async readObject(objectKey) { return (await client.get(key(objectKey)))?.body ?? null; },
		async publish({ manifest, objects, expectedRevision }) {
			const current = await readManifest(currentKey(manifest.teamId));
			if ((current?.manifest.revision ?? undefined) !== expectedRevision) throw new Error('The published knowledge revision changed before R2 promotion.');
			for (const object of objects) {
				const existing = await client.get(key(object.key));
				if (existing && existing.body !== object.body) throw new Error('An immutable publication object digest collided with different content.');
				if (!existing) await client.put(key(object.key), object.body, { absent: true });
			}
			const body = `${JSON.stringify(manifest, null, 2)}\n`;
			const revision = await client.get(revisionKey(manifest.teamId, manifest.revision));
			if (revision && revision.body !== body) throw new Error('An immutable publication revision already contains different content.');
			if (!revision) await client.put(revisionKey(manifest.teamId, manifest.revision), body, { absent: true });
			await client.put(currentKey(manifest.teamId), body, current?.etag ? { etag: current.etag } : { absent: true });
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
			await Promise.all(removedObjects.map((item) => client.delete(key(item))));
			await Promise.all(retiring.map((item) => client.delete(revisionKey(teamId, item.revision))));
			return { revisionsRemoved: retiring.map((item) => item.revision), objectsRemoved: removedObjects };
		},
	};
}
