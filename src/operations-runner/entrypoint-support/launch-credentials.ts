import { createDecipheriv, createHash } from 'node:crypto';
import { objectValue, env, isLoopbackUrl } from './index.js';

export async function consumeLaunchCredentialSession(store, runtime, jobId, sessionId) {
    const consumed = await store.consumeProviderCredentialSession(jobId, sessionId);
    if (!consumed.ok) {
        throw new Error(`Unable to consume provider credential session: ${consumed.error}`);
    }
    const session = consumed.payload;
    const payload = decryptCredentialSessionPayloadForRunner(runtime, session.encryptedPayload);
    return {
        id: session.id,
        hostKind: session.hostKind,
        hostId: session.hostId,
        purpose: session.purpose,
        provider: payload.provider ?? null,
        config: payload.config && typeof payload.config === 'object' ? payload.config : {},
    };
}

export function credentialSessionSecretForRunner(runtime) {
    const configured = process.env.TREESEED_CREDENTIAL_SESSION_SECRET
        ?? runtime?.resolved?.config?.credentialSessionSecret
        ?? null;
    if (configured && String(configured).trim())
        return String(configured);
    const runtimeConfig = runtime?.resolved?.config ?? {};
    const environment = String(runtimeConfig.environment ?? process.env.TREESEED_API_ENVIRONMENT ?? process.env.TREESEED_ENVIRONMENT ?? '').trim().toLowerCase();
    const localDatabase = isLoopbackUrl(runtimeConfig.apiDatabaseUrl ?? process.env.TREESEED_DATABASE_URL ?? '');
    const localBaseUrl = isLoopbackUrl(runtimeConfig.baseUrl ?? runtimeConfig.marketUrl ?? process.env.TREESEED_API_BASE_URL ?? process.env.TREESEED_SITE_URL ?? process.env.TREESEED_BETTER_AUTH_URL ?? '');
    if (process.env.NODE_ENV === 'test'
        || process.env.TREESEED_LOCAL_DEV_MODE
        || environment === 'local'
        || localDatabase
        || localBaseUrl) {
        return 'treeseed-local-test-credential-session-secret';
    }
    throw new Error('TREESEED_CREDENTIAL_SESSION_SECRET is required for provider credential sessions.');
}

export function decryptCredentialSessionPayloadForRunner(runtime, envelope) {
    if (!envelope || typeof envelope !== 'object') {
        throw new Error('Credential session payload is missing.');
    }
    const key = createHash('sha256').update(credentialSessionSecretForRunner(runtime)).digest();
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(String(envelope.iv ?? ''), 'base64url'));
    decipher.setAuthTag(Buffer.from(String(envelope.tag ?? ''), 'base64url'));
    const plaintext = Buffer.concat([
        decipher.update(Buffer.from(String(envelope.ciphertext ?? ''), 'base64url')),
        decipher.final(),
    ]);
    return JSON.parse(plaintext.toString('utf8'));
}

export async function prepareLaunchIntentForMarketRunner(store, runtime, job) {
    const launchJobInput = objectValue(job.input);
    const launchIntent = objectValue(launchJobInput.launchIntent);
    const nextIntent = JSON.parse(JSON.stringify(launchIntent));
    const execution = objectValue(nextIntent.execution);
    const providerLaunchInput = objectValue(execution.providerLaunchInput);
    const sessions = objectValue(launchJobInput.credentialSessions);
    if (Object.keys(sessions).length > 0) {
        throw new Error('launch_project jobs must not contain provider credential sessions. Project launch credentials are bootstrapped by the API only.');
    }
    const envOverlay: Record<string, unknown> = {};
    const consume = async (key) => {
        const sessionId = typeof sessions[key] === 'string' ? sessions[key].trim() : '';
        if (!sessionId)
            return null;
        return consumeLaunchCredentialSession(store, runtime, job.id, sessionId);
    };
    const repositorySession = await consume('repositoryHost');
    if (repositorySession?.config) {
        const token = repositorySession.config.GH_TOKEN ?? repositorySession.config.GITHUB_TOKEN;
        if (token) {
            envOverlay.GH_TOKEN = token;
            envOverlay.GITHUB_TOKEN = repositorySession.config.GITHUB_TOKEN ?? token;
        }
        const owner = repositorySession.config.organizationOrOwner ?? repositorySession.config.owner;
        if (owner) {
            envOverlay.TREESEED_GITHUB_IDENTITY_MODE = 'account';
            envOverlay.TREESEED_HOSTED_HUBS_GITHUB_OWNER = owner;
            nextIntent.repository = {
                ...objectValue(nextIntent.repository),
                owner,
            };
            providerLaunchInput.repoOwner = owner;
        }
    }
    const webSession = await consume('webHost');
    if (webSession?.config) {
        const webConfig = objectValue(webSession.config);
        for (const [key, value] of Object.entries(webConfig)) {
            if (typeof value === 'string' && value.trim())
                envOverlay[key] = value;
        }
        providerLaunchInput.cloudflareHost = {
            ...objectValue(providerLaunchInput.cloudflareHost),
            config: webConfig,
        };
    }
    const emailSession = await consume('emailHost');
    if (emailSession?.config) {
        const emailConfig = objectValue(emailSession.config);
        for (const [key, value] of Object.entries(emailConfig)) {
            if (typeof value === 'string' && value.trim())
                envOverlay[key] = value;
        }
        providerLaunchInput.emailHost = {
            ...objectValue(providerLaunchInput.emailHost),
            config: emailConfig,
        };
    }
    nextIntent.execution = {
        ...execution,
        providerLaunchInput,
    };
    return { intent: nextIntent, envOverlay, resume: launchJobInput.resume === true };
}
