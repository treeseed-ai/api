import { describe, expect, it } from 'vitest';
import { planIdentityMappings } from '../../../../src/api/auth/identity-mapping-plan.ts';

const mapping = { userId: 'existing-user', issuer: 'https://identity.example.test/realms/local', subject: 'imported-subject' };
const inventory = { users: [{ id: mapping.userId, status: 'active' }], mappings: [], workloads: [] };
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
    expect(() => planIdentityMappings({ ...inventory, users: [] }, [mapping])).toThrow('active existing user');
    expect(() => planIdentityMappings({ ...inventory, users: [{ id: mapping.userId, status: 'disabled' }] }, [mapping])).toThrow('active existing user');
  });
  it('rejects unsafe issuers and empty subjects', () => {
    for (const issuer of ['http://identity.test', 'https://user:password@identity.test', 'https://identity.test/?q=1', 'https://identity.test/#fragment']) {
      expect(() => planIdentityMappings(inventory, [{ ...mapping, issuer }])).toThrow();
    }
    expect(() => planIdentityMappings(inventory, [{ ...mapping, subject: ' ' }])).toThrow();
  });
  it('binds the plan to account status and preserves exact issuer distinctions', () => {
    const before = planIdentityMappings(inventory, []);
    const after = planIdentityMappings({ ...inventory, users: [{ id: mapping.userId, status: 'disabled' }] }, []);
    expect(before.inventoryDigest).not.toBe(after.inventoryDigest);
    expect(planIdentityMappings({ ...inventory, mappings: [mapping] }, [{ ...mapping, issuer: `${mapping.issuer}/` }]).operations[0].action).toBe('bind');
  });
  it('rejects workload subjects and principal IDs without treating them as human accounts', () => {
    for (const workload of [{ id: 'service', issuer: mapping.issuer, subject: mapping.subject },
      { id: mapping.userId, issuer: mapping.issuer, subject: 'service-subject' }]) {
      expect(() => planIdentityMappings({ ...inventory, workloads: [workload] }, [mapping])).toThrow('workload identity');
    }
  });
  it('binds exact requests and all workload inventory while retaining valid opaque subjects', () => {
    const before = planIdentityMappings(inventory, [mapping]);
    const changed = planIdentityMappings(inventory, [{ ...mapping, subject: 'other|subject' }]);
    expect(changed.requestDigest).not.toBe(before.requestDigest);
    expect(changed.inventoryDigest).toBe(before.inventoryDigest);
    expect(planIdentityMappings({ ...inventory, workloads: [{ id: 'service', issuer: mapping.issuer, subject: 'other' }] }, [mapping]).inventoryDigest).not.toBe(before.inventoryDigest);
    for (const subject of ['x'.repeat(256), 'bad\nsubject', 'with space'])
      expect(() => planIdentityMappings(inventory, [{ ...mapping, subject }])).toThrow();
  });
});
