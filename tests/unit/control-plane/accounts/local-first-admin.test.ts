import { describe, expect, it, vi } from 'vitest';
import { bootstrapRolesForUserMethod } from '../../../../src/api/auth/postgres-store/teams/bootstrap-roles-for-user.ts';
import { reconcileBootstrapAdminsMethod } from '../../../../src/api/auth/postgres-store/teams/reconcile-bootstrap-admins.ts';
import { resolveApiConfig } from '../../../../src/api/configuration/runtime-config.ts';

function store(options: { local: boolean; users?: string[]; administratorCount?: number; roles?: string[] }) {
	const assigned: Array<[string, string]> = [];
	const audits: Array<Record<string, unknown>> = [];
	return {
		config: { bootstrapAdminAllowlist: [], localFirstUserAdmin: options.local },
		assignRole: vi.fn(async (userId: string, role: string) => { assigned.push([userId, role]); }),
		rolesForUser: vi.fn(async () => options.roles ?? []),
		first: vi.fn(async () => ({ count: options.administratorCount ?? 0 })),
		all: vi.fn(async (query: string) => query.includes('FROM users')
			? (options.users ?? []).map((id) => ({ id }))
			: []),
		writeAuditEvent: vi.fn(async (event: Record<string, unknown>) => { audits.push(event); }),
		assigned,
		audits,
	};
}

const identity = { provider: 'credential', providerSubject: 'adrian', email: 'user@example.test' };

describe('local first-user platform administrator bootstrap', () => {
	it('is enabled only by an explicit local-development marker', () => {
		expect(resolveApiConfig({ TREESEED_API_BASE_URL: 'https://api.example.test', TREESEED_ENVIRONMENT: 'production' }).localFirstUserAdmin).toBe(false);
		expect(resolveApiConfig({ TREESEED_API_BASE_URL: 'https://api.treeseed.local', TREESEED_ENVIRONMENT: 'local' }).localFirstUserAdmin).toBe(true);
		expect(resolveApiConfig({ TREESEED_API_BASE_URL: 'http://127.0.0.1:3000' }).localFirstUserAdmin).toBe(false);
	});

	it('elevates the sole first user only in local development', async () => {
		const local = store({ local: true, users: ['user-1'] });
		await bootstrapRolesForUserMethod.call(local as never, 'user-1', identity);
		expect(local.assigned).toEqual([['user-1', 'member'], ['user-1', 'platform_admin']]);
		expect(local.audits).toContainEqual(expect.objectContaining({
			eventType: 'auth.bootstrap_admin',
			data: { matched: 'local-first-user' },
		}));

		const remote = store({ local: false, users: ['user-1'] });
		await bootstrapRolesForUserMethod.call(remote as never, 'user-1', identity);
		expect(remote.assigned).toEqual([['user-1', 'member']]);
	});

	it('reconciles an existing sole local user', async () => {
		const local = store({ local: true, users: ['user-1'] });
		await reconcileBootstrapAdminsMethod.call(local as never);
		expect(local.assigned).toEqual([['user-1', 'platform_admin']]);
	});

	it('fails closed with multiple users or an existing administrator', async () => {
		const multiple = store({ local: true, users: ['user-1', 'user-2'] });
		await reconcileBootstrapAdminsMethod.call(multiple as never);
		expect(multiple.assigned).toEqual([]);

		const administered = store({ local: true, users: ['user-1'], administratorCount: 1 });
		await reconcileBootstrapAdminsMethod.call(administered as never);
		expect(administered.assigned).toEqual([]);
	});
});
