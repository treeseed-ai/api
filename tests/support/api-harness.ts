import { execFileSync } from 'node:child_process';

import { createServer } from 'node:http';

import { existsSync,mkdirSync,mkdtempSync,rmSync,writeFileSync } from 'node:fs';

import { tmpdir } from 'node:os';

import { resolve } from 'node:path';

import { afterEach,describe,expect,it,vi } from 'vitest';

import { DataType,newDb } from 'pg-mem';

import * as Core from '@treeseed/sdk';

import { AgentSdk,PlatformRunnerClient } from '@treeseed/sdk';

import { createPlatformApiApp } from '../../src/api/support/app.js';

import { MarketPostgresDatabase } from '../../src/api/support/market-postgres.js';

import { MarketControlPlaneStore } from '../../src/api/persistence/store.js';

import { runOnceWithClient } from '../../src/operations-runner/entrypoint.js';

vi.mock('@treeseed/sdk', async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import('@treeseed/sdk')>()),
        COMMERCE_PRODUCT_KINDS: [
            'template',
            'knowledge_pack',
            'ui_library',
            'admin_interface',
            'api_platform',
            'hosted_project',
            'professional_hosting',
            'scoped_service',
            'capacity_listing',
        ],
        COMMERCE_OFFER_MODES: [
            'free',
            'private',
            'contact',
            'one_time',
            'one_time_current_version',
            'subscription',
            'subscription_updates',
            'professional_hosting',
            'scoped_contract',
            'external',
        ],
        COMMERCE_VENDOR_TRUST_LEVELS: [
            'public_publisher',
            'verified_seller',
            'trusted_service_vendor',
            'trusted_capacity_vendor',
            'integration_partner',
        ],
        COMMERCE_GOVERNANCE_STATES: [
            'draft',
            'submitted',
            'approved',
            'rejected',
            'suspended',
            'archived',
        ],
        COMMERCE_OWNERSHIP_MODELS: [
            'team_owned',
            'individual_contributor_owned',
            'multi_contributor_attributed',
            'steward_maintained',
            'cooperative_owned',
            'community_governed',
            'foundation_or_trust_held',
            'transferred_or_succeeded',
        ],
        COMMERCE_STEWARDSHIP_ROLES: [
            'owner',
            'seller',
            'maintainer',
            'governance_steward',
            'support_steward',
            'security_steward',
            'community_steward',
            'successor',
        ],
        COMMERCE_STRIPE_ACCOUNT_STATUSES: [
            'not_started',
            'pending',
            'restricted',
            'enabled',
            'disabled',
        ],
        COMMERCE_STRIPE_ENVIRONMENTS: ['test', 'live'],
        COMMERCE_STRIPE_ONBOARDING_STATUSES: [
            'not_started',
            'started',
            'returned',
            'completed',
            'expired',
        ],
    };
});

export const packageRoot = process.cwd();

export const marketMigrationRoot = existsSync(resolve(packageRoot, '../sdk/drizzle/market'))
    ? resolve(packageRoot, '../sdk/drizzle/market')
    : resolve(packageRoot, 'node_modules/@treeseed/sdk/drizzle/market');

export async function withEnv<T>(values: Record<string, string | undefined>, action: () => T | Promise<T>) {
    const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
    for (const [key, value] of Object.entries(values)) {
        if (value == null) {
            delete process.env[key];
        }
        else {
            process.env[key] = value;
        }
    }
    try {
        return await action();
    }
    finally {
        for (const [key, value] of Object.entries(previous)) {
            if (value == null) {
                delete process.env[key];
            }
            else {
                process.env[key] = value;
            }
        }
    }
}

export async function waitForCondition(assertion: () => Promise<boolean> | boolean, timeoutMs = 1500) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (await assertion())
            return true;
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return false;
}

export function createTestPostgresDatabase() {
    const memory = newDb();
    memory.public.registerFunction({
        name: 'md5',
        args: [DataType.text],
        returns: DataType.text,
        implementation: (value: string) => `md5:${value}`,
    });
	memory.public.registerFunction({
		name: 'nullif',
		args: [DataType.text, DataType.text],
		returns: DataType.text,
		implementation: (left: string, right: string) => left === right ? null : left,
	});
    const pg = memory.adapters.createPg();
    return MarketPostgresDatabase.fromPool(new pg.Pool(), { migrationRoot: marketMigrationRoot });
}

export type ApiTestOptions = {
    db?: ReturnType<typeof createTestPostgresDatabase>;
    store?: MarketControlPlaneStore;
    sdk?: AgentSdk;
    config?: Record<string, unknown>;
    fetchImpl?: typeof fetch;
    logRequests?: boolean;
    stripeConnectService?: any;
    clock?: { now: () => Date };
	feedbackStorage?: any;
};

export function createTestApp(options: ApiTestOptions = {}) {
    return createPlatformApiApp({
        ...options,
        db: options.db ?? createTestPostgresDatabase(),
        sdk: options.sdk ?? new AgentSdk({
            repoRoot: packageRoot,
        }),
        config: {
            repoRoot: packageRoot,
            authSecret: 'test-secret',
            baseUrl: 'https://market.example.com',
            siteUrl: 'https://market.example.com',
            issuer: 'https://market.example.com',
            projectId: 'treeseed-market',
            projectApiKey: 'market-project-key',
            projectApiPermissions: ['sdk:execute:global', 'agent:execute:global', 'operations:execute:global'],
            webServiceId: 'web',
            webServiceSecret: 'web-test-secret',
            webAssertionSecret: 'web-assertion-secret',
            ...(options.config ?? {}),
        },
    });
}

export function createTestStore(db = createTestPostgresDatabase()) {
    return new MarketControlPlaneStore({
        repoRoot: packageRoot,
        authSecret: 'test-secret',
        baseUrl: 'https://market.example.com',
        siteUrl: 'https://market.example.com',
        issuer: 'https://market.example.com',
        projectId: 'treeseed-market',
        projectApiKey: 'market-project-key',
        projectApiPermissions: ['sdk:execute:global', 'agent:execute:global', 'operations:execute:global'],
        serviceId: 'web',
        serviceSecret: 'web-test-secret',
        assertionSecret: 'web-assertion-secret',
    }, db);
}

export async function json(response: Response) {
    return response.json() as Promise<any>;
}

export function git(cwd: string, args: string[]) {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

export async function withHttpMarketApp<T>(app: ReturnType<typeof createTestApp>, action: (baseUrl: string) => Promise<T>) {
    const server = createServer((request, response) => {
        void (async () => {
            const chunks: Buffer[] = [];
            for await (const chunk of request)
                chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
            const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
            const webResponse = await app.fetch(new Request(url, {
                method: request.method,
                headers: request.headers as HeadersInit,
                body,
            }));
            response.writeHead(webResponse.status, Object.fromEntries(webResponse.headers.entries()));
            response.end(Buffer.from(await webResponse.arrayBuffer()));
        })().catch((error) => {
            response.writeHead(500, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
        });
    });
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    const address = server.address();
    const baseUrl = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : '';
    try {
        return await action(baseUrl);
    }
    finally {
        await new Promise<void>((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
    }
}

export function createRunnerRepoFixture() {
    const root = mkdtempSync(resolve(tmpdir(), 'treeseed-operations-runner-'));
    const repo = resolve(root, 'repo');
    const workspace = resolve(root, 'workspace');
    mkdirSync(resolve(repo, 'src/content/notes'), { recursive: true });
    mkdirSync(workspace, { recursive: true });
    writeFileSync(resolve(repo, 'README.md'), 'runner fixture\n', 'utf8');
    git(repo, ['init', '-b', 'staging']);
    git(repo, ['config', 'user.email', 'test@example.com']);
    git(repo, ['config', 'user.name', 'TreeSeed Test']);
    git(repo, ['add', '.']);
    git(repo, ['commit', '-m', 'init']);
    return { root, repo, workspace };
}

export function unsignedTestJwt(payload: Record<string, unknown>) {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
    return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.`;
}

export async function authorizeApp(app: ReturnType<typeof createTestApp>, input: {
    principalId?: string;
    displayName?: string;
} = {}) {
    const principalId = input.principalId ?? 'user-1';
    const namespace = `device-${principalId.replace(/[^a-z0-9-]+/giu, '-').toLowerCase()}`;
    const seeded = await json(await app.request('/v1/acceptance/seed', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-treeseed-service-id': 'web', 'x-treeseed-service-secret': 'web-test-secret' },
        body: JSON.stringify({ namespace, actorsOnly: true, actors: { deviceApprover: { userId: principalId, displayName: input.displayName ?? 'Market User', siteRoles: ['member'] } } }),
    }));
    if (!seeded.ok)
        throw new Error(`Acceptance actor seed failed: ${JSON.stringify(seeded)}`);
    const approverToken = seeded.payload.actors.deviceApprover.accessToken;
    const started = await json(await app.request('/v1/auth/device/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scopes: ['auth:me'] }),
    }));
    const approval = await json(await app.request('/v1/auth/device/approve', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${approverToken}` },
        body: JSON.stringify({
            userCode: started.userCode,
        }),
    }));
    if (approval.ok === false)
        throw new Error(`Authenticated device approval failed: ${JSON.stringify(approval)}`);
    const tokenPayload = await json(await app.request('/v1/auth/device/poll', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceCode: started.deviceCode }),
    }));
    if (!tokenPayload.accessToken)
        throw new Error(`Device token poll failed: ${JSON.stringify(tokenPayload)}`);
    return tokenPayload.accessToken as string;
}

export async function createTeamAndProject(app: ReturnType<typeof createTestApp>, token: string, projectInput: Record<string, unknown>) {
    const team = await json(await app.request('/v1/teams', {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ slug: 'team-one', name: 'Team One' }),
    }));
    const project = await json(await app.request(`/v1/teams/${team.payload.id}/projects`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(projectInput),
    }));
    return {
        team: team.payload,
        project: project.payload.project,
    };
}

export async function createTeam(app: ReturnType<typeof createTestApp>, token: string) {
    const team = await json(await app.request('/v1/teams', {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ slug: 'team-one', name: 'Team One' }),
    }));
    return team.payload;
}

afterEach(() => {
    vi.restoreAllMocks();
});
export { afterEach,AgentSdk,Core,createPlatformApiApp,createServer,DataType,describe,execFileSync,existsSync,expect,it,MarketControlPlaneStore,MarketPostgresDatabase,mkdirSync,mkdtempSync,newDb,PlatformRunnerClient,resolve,rmSync,runOnceWithClient,tmpdir,vi,writeFileSync };
