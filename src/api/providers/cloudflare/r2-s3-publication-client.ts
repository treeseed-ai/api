import { createHash, createHmac } from 'node:crypto';

export interface R2S3PublicationConfig {
	accountId: string;
	bucket: string;
	accessKeyId: string;
	secretAccessKey: string;
}

interface PutOptions {
	contentType: string;
	ifMatch?: string;
	ifNoneMatch?: '*';
}

const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const hmac = (key: string | Buffer, value: string) => createHmac('sha256', key).update(value).digest();
const encodePath = (value: string) => value.split('/').map(encodeURIComponent).join('/');

function sign(input: { config: R2S3PublicationConfig; method: string; key: string; body: string; headers?: Record<string, string>; query?: URLSearchParams }) {
	const now = new Date();
	const timestamp = now.toISOString().replace(/[:-]|\.\d{3}/gu, '');
	const day = timestamp.slice(0, 8);
	const host = `${input.config.accountId}.r2.cloudflarestorage.com`;
	const path = `/${encodeURIComponent(input.config.bucket)}/${encodePath(input.key)}`;
	const headers = { host, 'x-amz-content-sha256': sha256(input.body), 'x-amz-date': timestamp, ...(input.headers ?? {}) };
	const names = Object.keys(headers).map((name) => name.toLowerCase()).sort();
	const canonicalHeaders = Object.fromEntries(names.map((name) => [name, headers[name as keyof typeof headers]!.trim()]));
	const headerBlock = `${names.map((name) => `${name}:${canonicalHeaders[name]}`).join('\n')}\n`;
	const signedHeaders = names.join(';');
	const query = input.query ? [...input.query.entries()].sort(([a, av], [b, bv]) => a.localeCompare(b) || av.localeCompare(bv))
		.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&') : '';
	const canonical = [input.method, path, query, headerBlock, signedHeaders, sha256(input.body)].join('\n');
	const scope = `${day}/auto/s3/aws4_request`;
	const stringToSign = `AWS4-HMAC-SHA256\n${timestamp}\n${scope}\n${sha256(canonical)}`;
	const signingKey = hmac(hmac(hmac(hmac(`AWS4${input.config.secretAccessKey}`, day), 'auto'), 's3'), 'aws4_request');
	const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
	return {
		url: `https://${host}${path}${query ? `?${query}` : ''}`,
		headers: { ...canonicalHeaders, authorization: `AWS4-HMAC-SHA256 Credential=${input.config.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` },
	};
}

export class R2S3PublicationClient {
	constructor(private readonly config: R2S3PublicationConfig, private readonly fetchImpl: typeof fetch = fetch) {}

	private async request(method: string, key: string, body = '', headers?: Record<string, string>, query?: URLSearchParams) {
		for (let attempt = 0; attempt < 4; attempt += 1) {
			const signed = sign({ config: this.config, method, key, body, headers, query });
			try {
				const response = await this.fetchImpl(signed.url, { method, headers: signed.headers, body: method === 'GET' || method === 'HEAD' ? undefined : body });
				if (attempt < 3 && (response.status === 429 || response.status >= 500)) {
					await response.body?.cancel();
					await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
					continue;
				}
				return response;
			} catch (error) {
				if (attempt < 3) {
					await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
					continue;
				}
				const cause = error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : '';
				throw new Error(`R2 ${method} transport failed for ${key || '(bucket)'}${cause}`, { cause: error });
			}
		}
		throw new Error(`R2 ${method} transport retry limit reached for ${key || '(bucket)'}.`);
	}

	async get(key: string) {
		const response = await this.request('GET', key, '', { 'accept-encoding': 'identity' });
		if (response.status === 404) return null;
		if (!response.ok) throw new Error(`R2 read failed for ${key} (HTTP ${response.status}).`);
		return { body: await response.text(), etag: response.headers.get('etag') ?? null };
	}

	async exists(key: string) {
		const response = await this.request('HEAD', key, '', { 'accept-encoding': 'identity' });
		if (response.status === 404) return false;
		if (!response.ok) throw new Error(`R2 head failed for ${key} (HTTP ${response.status}).`);
		return true;
	}

	async put(key: string, body: string, options: PutOptions) {
		const headers: Record<string, string> = { 'content-type': options.contentType };
		if (options.ifMatch) headers['if-match'] = options.ifMatch;
		if (options.ifNoneMatch) headers['if-none-match'] = options.ifNoneMatch;
		const response = await this.request('PUT', key, body, headers);
		if (response.status === 412) {
			const readback = await this.get(key);
			if (readback?.body === body) return;
			throw new Error(`R2 conditional write conflict for ${key}.`);
		}
		if (!response.ok) throw new Error(`R2 write failed for ${key} (HTTP ${response.status}).`);
	}

	async delete(key: string) {
		const response = await this.request('DELETE', key);
		if (!response.ok && response.status !== 404) throw new Error(`R2 delete failed for ${key} (HTTP ${response.status}).`);
	}

	async list(prefix: string) {
		const keys: string[] = [];
		let continuationToken: string | null = null;
		for (let page = 0; page < 10_000; page += 1) {
			const query = new URLSearchParams({ 'list-type': '2', 'max-keys': '1000', prefix });
			if (continuationToken) query.set('continuation-token', continuationToken);
			const response = await this.request('GET', '', '', undefined, query);
			if (!response.ok) throw new Error(`R2 list failed for ${prefix} (HTTP ${response.status}).`);
			const xml = await response.text();
			keys.push(...[...xml.matchAll(/<Key>([^<]+)<\/Key>/gu)].map((match) => decodeXml(match[1]!)));
			if (!/<IsTruncated>true<\/IsTruncated>/u.test(xml)) return keys;
			const next = xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/u)?.[1];
			if (!next) throw new Error('R2 list was truncated without a continuation token.');
			const decoded = decodeXml(next);
			if (decoded === continuationToken) throw new Error('R2 list repeated its continuation token.');
			continuationToken = decoded;
		}
		throw new Error('R2 list exceeded the bounded pagination limit.');
	}
}

function decodeXml(value: string) {
	return value.replace(/&amp;/gu, '&').replace(/&lt;/gu, '<').replace(/&gt;/gu, '>')
		.replace(/&quot;/gu, '"').replace(/&apos;/gu, "'");
}
