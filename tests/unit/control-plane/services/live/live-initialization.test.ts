import {afterEach, describe, expect, it, vi} from 'vitest';
import {ensureInitializedMethod} from '../../../../../src/api/store/support/contracts/ensure-initialized.ts';

afterEach(()=>vi.unstubAllEnvs());
describe('live initialization',()=>{
  it('verifies migrations without seeding roles or changing platform ownership',async()=>{
    vi.stubEnv('TREESEED_DEVELOPMENT_MODE','live');
    const store={db:{migrate:vi.fn()},seedTeamRoles:vi.fn(),syncPlatformAdminOwners:vi.fn(),initializationPromise:null};
    await ensureInitializedMethod.call(store as any);
    expect(store.db.migrate).toHaveBeenCalledOnce();
    expect(store.seedTeamRoles).not.toHaveBeenCalled();
    expect(store.syncPlatformAdminOwners).not.toHaveBeenCalled();
  });
  it('retains released startup reconciliation',async()=>{
    vi.stubEnv('TREESEED_DEVELOPMENT_MODE','');
    const store={db:{migrate:vi.fn()},seedTeamRoles:vi.fn(),syncPlatformAdminOwners:vi.fn(),initializationPromise:null};
    await ensureInitializedMethod.call(store as any);
    expect(store.seedTeamRoles).toHaveBeenCalledOnce();
    expect(store.syncPlatformAdminOwners).toHaveBeenCalledOnce();
  });
});
