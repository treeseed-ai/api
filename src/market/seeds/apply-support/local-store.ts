import { resolveApiDatabaseUrl } from '@treeseed/sdk/api';
import { createMarketPostgresDatabase } from '../../../api/market-postgres.js';
import { MarketControlPlaneStore } from '../../../api/store.js';

export function resolveLocalSeedEnv(_projectRoot, env = process.env) {
    const localEnv: Record<string, string | undefined> = {
        ...env,
        TREESEED_ENVIRONMENT: env.TREESEED_ENVIRONMENT ?? 'local',
        TREESEED_API_ENVIRONMENT: env.TREESEED_API_ENVIRONMENT ?? 'local',
        TREESEED_LOCAL_DEV_MODE: env.TREESEED_LOCAL_DEV_MODE ?? 'local',
    };
    const apiDatabaseUrl = resolveApiDatabaseUrl(localEnv, localEnv.TREESEED_API_BASE_URL ?? 'http://127.0.0.1:3000');
    if (apiDatabaseUrl && !localEnv.TREESEED_DATABASE_URL) {
        localEnv.TREESEED_DATABASE_URL = apiDatabaseUrl;
    }
    return localEnv;
}

export async function createLocalSeedStore(projectRoot, env = process.env) {
    const localEnv = resolveLocalSeedEnv(projectRoot, env);
    const apiDatabaseUrl = localEnv.TREESEED_DATABASE_URL?.trim();
    if (!apiDatabaseUrl) {
        throw new Error('TREESEED_DATABASE_URL could not be resolved for local Treeseed seed apply.');
    }
    const db = createMarketPostgresDatabase(apiDatabaseUrl);
    return new MarketControlPlaneStore({
        repoRoot: projectRoot,
        projectId: localEnv.TREESEED_PROJECT_ID ?? 'treeseed-market',
        authSecret: localEnv.TREESEED_AUTH_SECRET ?? localEnv.TREESEED_API_AUTH_SECRET ?? localEnv.TREESEED_BETTER_AUTH_SECRET ?? 'treeseed-local-seed-auth-secret',
        assertionSecret: localEnv.TREESEED_WEB_ASSERTION_SECRET ?? localEnv.TREESEED_API_WEB_ASSERTION_SECRET ?? 'treeseed-local-seed-assertion-secret',
        serviceId: localEnv.TREESEED_WEB_SERVICE_ID ?? localEnv.TREESEED_API_SERVICE_ID ?? 'web',
        serviceSecret: localEnv.TREESEED_WEB_SERVICE_SECRET ?? localEnv.TREESEED_API_WEB_SERVICE_SECRET ?? localEnv.TREESEED_API_SERVICE_SECRET ?? 'treeseed-local-seed-service-secret',
    }, db);
}
