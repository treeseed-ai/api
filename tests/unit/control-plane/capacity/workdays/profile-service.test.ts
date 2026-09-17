import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_WORKDAY_POLICY } from '@treeseed/sdk/agent-capacity';
import { createWorkdayProfileService, readTeamWorkdayProfile } from '../../../../../src/api/control-plane/repositories/capacity/workdays/profile-service.ts';

const principal = { id: 'owner' };
function store() {
	return {
		principalCanAccessTeam: vi.fn(async () => true),
		getTeamAccessSummary: vi.fn(async () => ({ permissions: ['teams:manage:team', 'projects:read:team'] })),
		first: vi.fn(async (sql: string): Promise<Record<string, unknown> | null> => sql.startsWith('UPDATE') ? { id: 'team' } : { metadata_json: '{}' }),
	};
}
describe('canonical team workday policy', () => {
	it('provides one default without reading repository allocation records', async () => {
		const db = store();
		await expect(createWorkdayProfileService(db).profilesShow(principal, 'team', 'default')).resolves
			.toMatchObject({ id: 'default', teamId: 'team', revision: 1, policy: DEFAULT_WORKDAY_POLICY });
		expect(db.first.mock.calls.every(([sql]) => !sql.includes('allocation_sets'))).toBe(true);
		await expect(createWorkdayProfileService(db).profilesShow(principal, 'team', 'feature-heavy')).rejects
			.toMatchObject({ code: 'workday_profile_not_found' });
	});
	it('fails closed on invalid persisted policy', async () => {
		const db = store(); db.first.mockResolvedValue({ metadata_json: '{"workdayProfile":{"revision":1,"policy":{"tiers":[]}}}' });
		await expect(readTeamWorkdayProfile(db, 'team')).rejects.toMatchObject({ code: 'workday_profile_invalid' });
	});
	it('requires current version and management authority, then atomically advances policy', async () => {
		const db = store(), service = createWorkdayProfileService(db);
		await expect(service.profilesUpdate(principal, 'team', 'default', { policy: DEFAULT_WORKDAY_POLICY }))
			.rejects.toMatchObject({ code: 'workday_profile_precondition_failed' });
		await expect(service.profilesUpdate(principal, 'team', 'default', { policy: { ...DEFAULT_WORKDAY_POLICY, planningPercent: 30 } }, '"1"'))
			.resolves.toMatchObject({ revision: 2, policy: { planningPercent: 30 } });
		expect(db.first.mock.calls.at(-1)?.[0]).toContain('jsonb_set');
		db.getTeamAccessSummary.mockResolvedValue({ permissions: ['projects:read:team'] });
		await expect(service.profilesUpdate(principal, 'team', 'default', { policy: DEFAULT_WORKDAY_POLICY }, '1'))
			.rejects.toMatchObject({ code: 'capacity_permission_denied' });
	});
	it('rejects a concurrent policy writer', async () => {
		const db = store(); db.first.mockImplementation(async (sql: string) => sql.startsWith('UPDATE') ? null : { metadata_json: '{}' });
		await expect(createWorkdayProfileService(db).profilesUpdate(principal, 'team', 'default', { policy: DEFAULT_WORKDAY_POLICY }, '1'))
			.rejects.toMatchObject({ code: 'workday_profile_precondition_failed' });
	});
});
