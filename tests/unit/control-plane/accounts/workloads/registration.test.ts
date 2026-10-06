import { describe, expect, it } from 'vitest';
import { planIdentityWorkloads } from '../../../../../src/api/auth/identity/workload-plan.ts';
import ts from 'typescript';
import { resolve } from 'node:path';
import { identityEndpointSchema } from '@treeseed/sdk/identity';

const value = { id: 'preserved-service', issuer: 'https://identity.example.test/realms/local', subject: 'verified-subject',
  clientId: 'admin-bff', displayName: 'Admin', permissions: ['auth:read:self'], scopes: ['treeseed:read'] };
const empty = { workloads: [], humans: [] };
const existing = { ...empty, workloads: [{ ...value, status: 'active' as const }] };
describe('explicit workload registration plans', () => {
  it('retains canonical endpoint validation across package schema versions and compiles its full owning plan strictly', () => {
    for (const issuer of ['https://identity.example.test/realms/local', 'https://identity.example.test:8443/realms/local',
      'http://identity.example.test', 'https://user:secret@identity.example.test', 'https://identity.example.test?query=1',
      'https://identity.example.test#fragment', '', 'not-a-url']) {
      const input = [{ ...value, issuer }], before = structuredClone(input);
      if (identityEndpointSchema.safeParse(issuer).success) expect(planIdentityWorkloads(empty, input).operations[0]!.issuer).toBe(issuer);
      else expect(() => planIdentityWorkloads(empty, input)).toThrow();
      expect(input).toEqual(before);
    }
    const source = resolve('src/api/auth/identity/workload-plan.ts');
    const program = ts.createProgram([source], { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler, strict: true, noEmit: true, allowImportingTsExtensions: true,
      skipLibCheck: false, noCheck: false, types: ['node'] });
    expect(ts.getPreEmitDiagnostics(program).map(diagnostic => `${diagnostic.code}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`)).toEqual([]);
  });
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
