import { describe, expect, it } from 'vitest';
import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { prepareIdentityPasswordImport } from '../../../../../src/api/auth/identity-password-import.ts';

describe('maintenance-only Identity password import', () => {
  for (const password of ['Disposable acceptance password 42!', 'Synthetïc 密码🔑 only 42!']) {
    it(`preserves the existing verifier byte semantics (${password.includes('密') ? 'unicode' : 'ascii'})`, () => {
      const salt = randomBytes(16).toString('base64url');
      const digest = pbkdf2Sync(password, salt, 210000, 32, 'sha256');
      const imported = prepareIdentityPasswordImport(`pbkdf2-sha256$210000$${salt}$${digest.toString('base64url')}`);
      const data = JSON.parse(imported.secretData);
      expect(imported.type).toBe('password'); expect(imported.temporary).toBe(false);
      expect(JSON.parse(imported.credentialData)).toEqual({ algorithm: 'pbkdf2-sha256', hashIterations: 210000 });
      expect(Buffer.from(data.salt, 'base64')).toEqual(Buffer.from(salt, 'utf8'));
      expect(pbkdf2Sync(password, Buffer.from(data.salt, 'base64'), 210000, 32, 'sha256')).toEqual(Buffer.from(data.value, 'base64'));
      expect(JSON.stringify(imported)).not.toContain(password);
    });
  }
  it('rejects unknown, malformed and noncanonical verifiers without disclosing them', () => {
    const salt = Buffer.alloc(16).toString('base64url'), digest = Buffer.alloc(32).toString('base64url');
    for (const value of [null, {}, 'private-material', 'x'.repeat(129),
      `pbkdf2-sha256$999999999$${salt}$${digest}`, `pbkdf2-sha256$210000$${salt}$${digest}$extra`,
      `pbkdf2-sha256$210000$${salt.slice(0, -1)}B$${digest}`,
      `pbkdf2-sha256$210000$${salt}$${digest.slice(0, -1)}B`]) {
      expect(() => prepareIdentityPasswordImport(value)).toThrow('Unsupported existing password verifier; Identity password reset required');
    }
  });
});
