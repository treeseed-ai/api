import { afterEach, describe, expect, it, vi } from 'vitest';
import { constants } from 'node:fs';
import { readDatabaseUrlFile, validateDatabaseFileUrl } from '../../../../src/api/configuration/database-file.ts';
import { resolveApiDatabaseUrl } from '../../../../src/api/configuration/runtime-config.ts';

const fs = vi.hoisted(() => ({ openSync: vi.fn(), fstatSync: vi.fn(), readFileSync: vi.fn(), closeSync: vi.fn() }));
vi.mock('node:fs', async original => ({ ...await original<typeof import('node:fs')>(), ...fs }));
const path = '/run/treeseed/postgres/api/url';
const url = 'postgresql://api_runtime:synthetic-test-password@postgres:5432/api?sslmode=verify-full&sslrootcert=/run/treeseed/postgres/api/ca.pem';
afterEach(() => vi.resetAllMocks());

describe('managed PostgreSQL file input', () => {
  it('reads only the owned private allocation file and clears its temporary buffer', () => {
    const bytes = Buffer.from(url);
    fs.openSync.mockReturnValue(10);
    fs.fstatSync.mockReturnValue({ isFile: () => true, nlink: 1, uid: process.getuid?.(), mode: 0o100400, size: bytes.length });
    fs.readFileSync.mockReturnValue(bytes);
    expect(resolveApiDatabaseUrl({ TREESEED_DATABASE_URL_FILE: path })).toBe(url);
    expect(fs.openSync).toHaveBeenCalledWith(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    expect(fs.closeSync).toHaveBeenCalledWith(10);
    expect(bytes.every(byte => byte === 0)).toBe(true);
  });
  it('never falls back after a missing or unsafe managed input', () => {
    fs.openSync.mockImplementation(() => { throw new Error('sensitive internal diagnostic'); });
    expect(() => resolveApiDatabaseUrl({ TREESEED_DATABASE_URL_FILE: path, LOCAL_DEV_MODE: '1' })).toThrow('Managed database input is unavailable or unsafe');
    expect(() => readDatabaseUrlFile('/tmp/url')).toThrow('allocation mount');
    expect(() => resolveApiDatabaseUrl({ TREESEED_DATABASE_URL_FILE: path, TREESEED_DATABASE_URL: url })).toThrow('Choose one');
  });
  it.each([{ mode: 0o100440 }, { uid: -1 }, { nlink: 2 }, { size: 16385 }, { isFile: () => false }])('rejects unsafe file metadata %j', override => {
    fs.openSync.mockReturnValue(10);
    fs.fstatSync.mockReturnValue({ isFile: () => true, nlink: 1, uid: process.getuid?.(), mode: 0o100400, size: 100, ...override });
    expect(() => readDatabaseUrlFile(path)).toThrow('unavailable or unsafe');
    expect(fs.readFileSync).not.toHaveBeenCalled();
    expect(fs.closeSync).toHaveBeenCalledWith(10);
  });
  it.each([url.replace('verify-full', 'require'), url.replace('/api/ca.pem', '/other/ca.pem'), `${url}&sslmode=disable`, `${url}&options=unsafe`, url.replace('api_runtime:', 'postgres:')])('rejects relaxed TLS or unexpected binding fields', value => {
    expect(() => validateDatabaseFileUrl(value, path)).toThrow();
  });
  it('supports explicit externally provisioned URLs independently', () => {
    expect(resolveApiDatabaseUrl({ TREESEED_DATABASE_URL: url })).toBe(url);
    expect(fs.openSync).not.toHaveBeenCalled();
  });
});
