import { createHash } from 'node:crypto';
import { R2S3PublicationClient, type R2S3PublicationConfig } from './r2-s3-publication-client.ts';

export interface R2ApiTokenPublicationConfig {
	authMode: 'api-token';
	accountId: string;
	bucket: string;
	apiToken: string;
}

export type R2PublicationConfig = R2ApiTokenPublicationConfig | (R2S3PublicationConfig & { authMode?: 's3' });
export type R2PublicationClient = Pick<R2S3PublicationClient, 'get' | 'exists' | 'put' | 'delete' | 'list'>;

class R2ApiTokenPublicationClient {
	private resolved: Promise<R2S3PublicationClient> | null = null;

	constructor(private readonly config: R2ApiTokenPublicationConfig, private readonly fetchImpl: typeof fetch = fetch) {}

	private async resolveClient() {
		if (this.resolved) return this.resolved;
		this.resolved = (async () => {
			const urls = [
				`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(this.config.accountId)}/tokens/verify`,
				'https://api.cloudflare.com/client/v4/user/tokens/verify',
			];
			for (const url of urls) {
				const response = await this.fetchImpl(url, { headers: { authorization: `Bearer ${this.config.apiToken}` } });
				if (!response.ok) continue;
				const envelope = await response.json() as { success?: boolean; result?: { id?: string; status?: string } };
				const accessKeyId = envelope.result?.id?.trim();
				if (envelope.success !== false && envelope.result?.status === 'active' && accessKeyId) {
					return new R2S3PublicationClient({
						accountId: this.config.accountId,
						bucket: this.config.bucket,
						accessKeyId,
						secretAccessKey: createHash('sha256').update(this.config.apiToken).digest('hex'),
					}, this.fetchImpl);
				}
			}
			throw new Error('Cloudflare token verification did not return an active token identifier for R2 S3 authentication.');
		})();
		return this.resolved;
	}

	async get(key: string) { return (await this.resolveClient()).get(key); }
	async exists(key: string) { return (await this.resolveClient()).exists(key); }
	async put(key: string, body: string, options: { contentType: string; ifMatch?: string; ifNoneMatch?: '*' }) { return (await this.resolveClient()).put(key, body, options); }
	async delete(key: string) { return (await this.resolveClient()).delete(key); }
	async list(prefix: string) { return (await this.resolveClient()).list(prefix); }
}

export function createR2PublicationClient(config: R2PublicationConfig, fetchImpl: typeof fetch = fetch): R2PublicationClient {
	return config.authMode === 'api-token'
		? new R2ApiTokenPublicationClient(config, fetchImpl)
		: new R2S3PublicationClient(config, fetchImpl);
}
