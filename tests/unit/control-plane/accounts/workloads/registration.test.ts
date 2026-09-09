import { describe, expect, it } from 'vitest';
import { planIdentityWorkloads } from '../../../../../src/api/auth/identity-workload-plan.ts';

const value = { id: 'preserved-service', issuer: 'https://identity.example.test/realms/local', subject: 'verified-subject',
  clientId: 'admin-bff', displayName: 'Admin', permissions: ['auth:read:self'], scopes: ['treeseed:read'] };
const empty = { workloads: [], humans: [] };
const existing = { ...empty, workloads: [{ ...value, status: 'active' as const }] };
describe('explicit workload registration plans', () => {
  it('preserves IDs, bounds grants and replays only exact active registrations', () => {
    expect(planIdentityWorkloads(empty, [value]).operations).toEqual([{ ...value, action: 'register' }]);
    expect(planIdentityWorkloads(existing, [value]).operations[0].action).toBe('noop');
    expect(empty.workloads).toEqual([]);
  });
  it('never reactivates revoked records or silently changes authority', () => {
    expect(() => planIdentityWorkloads({ ...existing, workloads: [{ ...value, status: 'revoked' }] }, [value])).toThrow('revocation');
    for (const change of [{ subject: 'new' }, { issuer: value.issuer + '/' }, { clientId: 'other' }, { permissions: ['*:*:*'] }, { scopes: [] }]) {
      expect(() => planIdentityWorkloads(existing, [{ ...value, ...change }])).toThrow('drift');
    }
  });
  it('rejects human IDs/subjects and client/subject rebinding', () => {
    for (const human of [{ userId: value.id, issuer: '', subject: '' }, { userId: 'human', issuer: value.issuer, subject: value.subject }]) {
      expect(() => planIdentityWorkloads({ ...empty, humans: [human] }, [value])).toThrow('human');
    }
    for (const change of [{ subject: 'other' }, { clientId: 'other' }]) {
      expect(() => planIdentityWorkloads(existing, [{ ...value, id: 'other', ...change }])).toThrow('bound');
    }
  });
  it('rejects conflicting inventories and duplicate batch bindings', () => {
    expect(() => planIdentityWorkloads({ ...existing, workloads: [...existing.workloads, ...existing.workloads] }, [])).toThrow('inventory');
    expect(() => planIdentityWorkloads(empty, [value, value])).toThrow('Duplicate');
    expect(() => planIdentityWorkloads(empty, [value, { ...value, id: 'other' }])).toThrow('bound');
  });
  it('binds desired grants and complete observed custody independently', () => {
    const plan = planIdentityWorkloads(empty, [value]);
    expect(planIdentityWorkloads(empty, [{ ...value, scopes: [] }]).requestDigest).not.toBe(plan.requestDigest);
    expect(planIdentityWorkloads(existing, [value]).inventoryDigest).not.toBe(plan.inventoryDigest);
    expect(planIdentityWorkloads(empty, [{ ...value, permissions: ['a', 'b'] }]).requestDigest)
      .toBe(planIdentityWorkloads(empty, [{ ...value, permissions: ['b', 'a'] }]).requestDigest);
  });
  it('rejects malformed or secret-bearing descriptors', () => {
    for (const change of [{ issuer: 'http://identity.test' }, { subject: ' ' }, { permissions: ['duplicate', 'duplicate'] }, { token: 'never' }]) {
      expect(() => planIdentityWorkloads(empty, [{ ...value, ...change }])).toThrow();
    }
  });
});
