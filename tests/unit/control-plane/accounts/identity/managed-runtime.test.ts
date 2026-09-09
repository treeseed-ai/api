import { describe, expect, it, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ read: vi.fn(), compose: vi.fn() }));
vi.mock('@treeseed/deployment/security/custody', () => ({ readOsCredentialFile: mocks.read }));
vi.mock('../../../../../src/api/auth/browser/configured-runtime.ts', () => ({ createConfiguredApiIdentityRuntime: mocks.compose }));
import { loadManagedApiIdentityRuntime } from '../../../../../src/api/configuration/identity-runtime.ts';

describe('managed API bootstrap mounts', () => {
  beforeEach(() => { vi.resetAllMocks(); });
  it('uses fixed per-API custody paths and clears the descriptor buffer', async () => {
    const descriptor = Buffer.from('{"schemaVersion":"test-descriptor"}'), key = Buffer.from('synthetic-key');
    mocks.read.mockReturnValueOnce(descriptor).mockReturnValueOnce(key);
    mocks.compose.mockImplementation(async (input, ports) => {
      expect(input).toEqual({ schemaVersion: 'test-descriptor' });
      expect(await ports.resolveCredential('browser-key')).toBe(key);
      await expect(ports.resolveCredential('../escape')).rejects.toThrow();
      return { metadata: 'composed' };
    });
    expect(await loadManagedApiIdentityRuntime({ transaction: vi.fn() }, fetch)).toEqual({ metadata: 'composed' });
    expect(mocks.read.mock.calls).toEqual([
      ['/run/treeseed/identity/api/runtime.json'], ['/run/treeseed/identity/api/credentials/browser-key'],
    ]);
    expect(descriptor.every(byte => byte === 0)).toBe(true);
  });
  it.each(['malformed', 'oversized', 'missing'])('fails closed for %s with no environment fallback', async fault => {
    if (fault === 'missing') mocks.read.mockImplementation(() => { throw new Error('private provider diagnostic'); });
    else mocks.read.mockReturnValue(Buffer.from(fault === 'oversized' ? 'x'.repeat(262145) : 'private malformed JSON'));
    await expect(loadManagedApiIdentityRuntime({ transaction: vi.fn() }, fetch)).rejects.toThrow('Managed API Identity bootstrap is unavailable');
    expect(mocks.compose).not.toHaveBeenCalled();
  });
});
