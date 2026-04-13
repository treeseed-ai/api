import { CloudflareHttpD1Database } from '@treeseed/sdk';
import { WranglerD1Database } from '@treeseed/sdk/wrangler-d1';
import type { D1DatabaseLike } from '@treeseed/sdk/types/cloudflare';
import type { ApiConfig } from '../types.ts';

export function resolveApiD1Database(config: ApiConfig): D1DatabaseLike {
	if (config.cloudflareAccountId && config.cloudflareApiToken && config.d1DatabaseId) {
		return new CloudflareHttpD1Database({
			accountId: config.cloudflareAccountId,
			apiToken: config.cloudflareApiToken,
			databaseId: config.d1DatabaseId,
		});
	}

	if (config.d1DatabaseName) {
		return new WranglerD1Database(
			config.d1DatabaseName,
			config.repoRoot,
			config.d1LocalPersistTo || undefined,
		);
	}

	throw new Error(
		'Treeseed API auth requires either CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN + TREESEED_API_D1_DATABASE_ID for remote D1 access, or TREESEED_API_D1_DATABASE_NAME for local Wrangler-backed D1 access.',
	);
}
