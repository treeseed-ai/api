import { expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ load: vi.fn(), app: vi.fn(), close: vi.fn(), migrate: vi.fn() }));
vi.mock('../../../../../src/api/configuration/identity-runtime.ts', () => ({ loadManagedApiIdentityRuntime: mocks.load }));
vi.mock('../../../../../src/api/configuration/runtime-config.ts', () => ({ resolveApiConfig: () => ({ baseUrl: 'https://api.test', port: 0, host: '127.0.0.1' }) }));
vi.mock('../../../../../src/api/support/app.ts', () => ({ createPlatformApiApp: mocks.app }));
vi.mock('../../../../../src/api/support/control-plane-postgres.js', () => ({ createControlPlanePostgresDatabase: () => ({ migrate: mocks.migrate, close: mocks.close }) }));
import { createApiServer } from '../../../../../src/api/support/server.ts';

it('refuses to create a listener or legacy app when managed Identity bootstrap is unavailable', async () => {
  mocks.load.mockRejectedValue(new Error('Managed API Identity bootstrap is unavailable'));
  await expect(createApiServer()).rejects.toMatchObject({ code: 'IDENTITY_FAILED', cause: expect.objectContaining({ message: 'Managed API Identity bootstrap is unavailable' }) });
  expect(mocks.app).not.toHaveBeenCalled();
  expect(mocks.close).toHaveBeenCalledOnce();
});
