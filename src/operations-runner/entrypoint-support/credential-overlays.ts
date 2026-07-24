import { objectValue, consumeLaunchCredentialSession, env } from './index.js';

export function runnerRuntimeFromOptions(options: any = {}) {
    const config = objectValue(options.config);
    return {
        resolved: {
            config: {
                baseUrl: config.marketUrl ?? null,
                marketUrl: config.marketUrl ?? null,
                apiDatabaseUrl: config.apiDatabaseUrl ?? null,
                environment: config.environment ?? process.env.TREESEED_PLATFORM_RUNNER_ENVIRONMENT ?? null,
                credentialSessionSecret: config.credentialSessionSecret ?? null,
            },
        },
    };
}

export function addCredentialOverlayAliases(overlay, session) {
    const config = objectValue(session?.config);
    for (const [key, value] of Object.entries(config)) {
        if (typeof value === 'string' && value.trim())
            overlay[key] = value;
    }
    const token = config.GH_TOKEN ?? config.GITHUB_TOKEN ?? config.githubToken ?? config.token;
    if (session?.hostKind === 'repository_host' && typeof token === 'string' && token.trim()) {
        overlay.GH_TOKEN = token;
        overlay.GITHUB_TOKEN = config.GITHUB_TOKEN ?? token;
        overlay.token = token;
    }
    const cloudflareToken = config.CLOUDFLARE_API_TOKEN ?? config.cloudflareApiToken ?? config.apiToken ?? config.token;
    if (session?.hostKind === 'web_host' && session?.provider === 'cloudflare' && typeof cloudflareToken === 'string' && cloudflareToken.trim()) {
        overlay.CLOUDFLARE_API_TOKEN = cloudflareToken;
        overlay.cloudflareApiToken = cloudflareToken;
        overlay.apiToken = cloudflareToken;
        overlay.token = cloudflareToken;
    }
    const accountId = config.CLOUDFLARE_ACCOUNT_ID ?? config.cloudflareAccountId ?? config.accountId;
    if (session?.hostKind === 'web_host' && session?.provider === 'cloudflare' && typeof accountId === 'string' && accountId.trim()) {
        overlay.CLOUDFLARE_ACCOUNT_ID = accountId;
        overlay.cloudflareAccountId = accountId;
        overlay.accountId = accountId;
    }
    if (session?.hostKind === 'email_host') {
        for (const [source, target] of [
            ['SMTP_HOST', 'smtpHost'],
            ['SMTP_PORT', 'smtpPort'],
            ['SMTP_USERNAME', 'smtpUsername'],
            ['SMTP_PASSWORD', 'smtpPassword'],
        ]) {
            const value = config[source] ?? config[target];
            if (typeof value === 'string' && value.trim()) {
                overlay[source] = value;
                overlay[target] = value;
            }
        }
    }
}

export async function consumeProjectHostCredentialOverlay(store, runtime, operationId, credentialSessions) {
    const overlay: Record<string, string> = {};
    const sessions = objectValue(credentialSessions);
    for (const sessionInfo of Object.values(sessions)) {
        const sessionId = typeof sessionInfo === 'string'
            ? sessionInfo
            : typeof (sessionInfo as Record<string, unknown> | null)?.id === 'string'
                ? (sessionInfo as { id: string }).id
                : '';
        if (!sessionId.trim())
            continue;
        const session = await consumeLaunchCredentialSession(store, runtime, operationId, sessionId.trim());
        addCredentialOverlayAliases(overlay, session);
    }
    return overlay;
}
