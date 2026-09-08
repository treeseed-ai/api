import {afterEach, expect, it, vi} from 'vitest';
import {main} from '../../../../../scripts/support/migrate-db.ts';

afterEach(() => vi.unstubAllEnvs());
it('never reports an applied migration from a live verification-only session', async () => {
  vi.stubEnv('TREESEED_DEVELOPMENT_MODE', 'live');
  vi.stubEnv('TREESEED_DATABASE_URL', '');
  await expect(main()).rejects.toThrow('live_migration_apply_forbidden');
});
