import { describe, expect, it, vi } from 'vitest';
import { createProviderEnvironmentService } from '../../../../src/api/control-plane/repositories/providers/provider-environment-service.ts';

const digest = `sha256:${'a'.repeat(64)}`;
const profile = {
	schemaVersion: 'treeseed.provider-environment-profile/v1', id: 'runtime', generation: 1,
	variables: [{ name: 'OPENAI_API_KEY', available: true }], updatedAt: '2026-09-01T20:00:00.000Z',
};
const grant = {
	schemaVersion: 'treeseed.assignment-environment-grant/v1', grantId: 'grant-1', assignmentId: 'assignment-1',
	providerId: 'provider-1', teamId: 'team-1', projectId: 'project-1', profileId: 'runtime', variables: ['OPENAI_API_KEY'],
	network: { allowed: false, destinations: [] },
	policy: { handlerDeclarationDigest: digest, providerOfferDigest: digest, providerPermissionDigest: digest,
		teamApprovalDigest: digest, assignmentGrantDigest: digest, sandboxPolicyDigest: digest },
	issuedAt: '2026-09-01T20:00:00.000Z', expiresAt: '2026-09-01T21:00:00.000Z',
};

function store() {
	return {
		ensureInitialized: vi.fn(), run: vi.fn(), batch: vi.fn(), all: vi.fn().mockResolvedValue([]),
		principalCanAccessTeam: vi.fn().mockResolvedValue(true), principalCanManageTeam: vi.fn().mockResolvedValue(true),
		first: vi.fn(async (query: string) => {
			if (query.includes('FROM capacity_provider_assignments')) return { team_id: 'team-1', project_id: 'project-1', capacity_provider_id: 'provider-1' };
			if (query.includes('FROM capacity_provider_environment_profiles')) return { descriptor_json: JSON.stringify(profile) };
			if (query.includes('FROM capacity_assignment_environment_grants')) return null;
			return null;
		}),
	} as any;
}

describe('provider environment authority', () => {
	it('persists only descriptor-bound assignment grants', async () => {
		const database = store();
		const service = createProviderEnvironmentService(database);
		await expect(service.putGrant({ id: 'owner-1' }, 'team-1', 'assignment-1', grant, 'new')).resolves.toEqual(grant);
		expect(database.run).toHaveBeenCalledOnce();
		expect(JSON.stringify(database.run.mock.calls)).not.toContain('secret-value');
	});

	it('rejects values in provider descriptors and grants before persistence', async () => {
		const database = store();
		const service = createProviderEnvironmentService(database);
		await expect(service.publish({ principal: { membershipId: 'membership-1', teamId: 'team-1', capacityProviderId: 'provider-1', scopes: ['provider:availability:write'] } },
			'runtime', { ...profile, variables: [{ ...profile.variables[0], value: 'secret-value' }] })).rejects.toThrow();
		await expect(service.putGrant({ id: 'owner-1' }, 'team-1', 'assignment-1', { ...grant, values: { OPENAI_API_KEY: 'secret-value' } }, 'new')).rejects.toThrow();
		expect(database.run).not.toHaveBeenCalled();
	});

	it('rejects variables the provider did not offer as available', async () => {
		const database = store();
		const service = createProviderEnvironmentService(database);
		await expect(service.putGrant({ id: 'owner-1' }, 'team-1', 'assignment-1', { ...grant, variables: ['MISSING_KEY'] }, 'new'))
			.rejects.toMatchObject({ code: 'assignment_environment_variables_unavailable', status: 409 });
		expect(database.run).not.toHaveBeenCalled();
	});
});
