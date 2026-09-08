import { describe, expect, it } from 'vitest';
import { planIdentityMappings } from '../../../../src/api/auth/identity-mapping-plan.ts';

const mapping = { userId: 'existing-user', issuer: 'https://identity.example.test/realms/local', subject: 'imported-subject' };
const inventory = { users: [{ id: mapping.userId, status: 'active' }], mappings: [] };
describe('explicit identity migration planning', () => {
  it('preserves user IDs and does not mutate the inventory', () => {
    expect(planIdentityMappings(inventory, [mapping]).operations).toEqual([{ ...mapping, action: 'bind' }]);
    expect(inventory.mappings).toEqual([]);
  });
  it('replays an existing exact mapping as noop', () => {
    expect(planIdentityMappings({ ...inventory, mappings: [mapping] }, [mapping]).operations[0].action).toBe('noop');
  });
  it('rejects reassignment and duplicate requests', () => {
    expect(() => planIdentityMappings({ ...inventory, mappings: [{ ...mapping, userId: 'other' }] }, [mapping])).toThrow('another user');
    expect(() => planIdentityMappings(inventory, [mapping, mapping])).toThrow('Duplicate');
  });
  it('rejects absent and disabled users instead of creating accounts', () => {
    expect(() => planIdentityMappings({ users: [], mappings: [] }, [mapping])).toThrow('active existing user');
    expect(() => planIdentityMappings({ users: [{ id: mapping.userId, status: 'disabled' }], mappings: [] }, [mapping])).toThrow('active existing user');
  });
  it('rejects unsafe issuers and empty subjects', () => {
    for (const issuer of ['http://identity.test', 'https://user:password@identity.test', 'https://identity.test/?q=1', 'https://identity.test/#fragment']) {
      expect(() => planIdentityMappings(inventory, [{ ...mapping, issuer }])).toThrow();
    }
    expect(() => planIdentityMappings(inventory, [{ ...mapping, subject: ' ' }])).toThrow();
  });
  it('binds the plan to account status and preserves exact issuer distinctions', () => {
    const before = planIdentityMappings(inventory, []);
    const after = planIdentityMappings({ users: [{ id: mapping.userId, status: 'disabled' }], mappings: [] }, []);
    expect(before.inventoryDigest).not.toBe(after.inventoryDigest);
    expect(planIdentityMappings({ ...inventory, mappings: [mapping] }, [{ ...mapping, issuer: `${mapping.issuer}/` }]).operations[0].action).toBe('bind');
  });
});
