import { describe, expect, it } from 'vitest';
import { identityMigrationConfigurationSchema } from '../../../../../src/api/configuration/identity-migration.ts';
import { identityMigrationFailureReason } from '../../../../../src/api/configuration/identity-migration-diagnostic.ts';

const descriptor = () => ({ schemaVersion:'treeseed.identity-api-migration/v1',
  issuer:'https://identity.example.test/realms/treeseed',resource:'https://api.example.test',backupGeneration:42,
  workloads:[{id:'admin-bff',issuer:'https://identity.example.test/realms/treeseed',subject:'service-account-id',
    clientId:'admin-bff',displayName:'Admin BFF',permissions:['identity:sessions:manage'],scopes:['treeseed:identity:sessions']}] });

describe('managed Identity migration descriptor uses the SDK schema dialect',()=>{
  it('never returns arbitrary migration error details',()=>{
    expect(identityMigrationFailureReason(new Error('token=private-value'))).toBe('unclassified');
    expect(identityMigrationFailureReason(Object.assign(new Error('private SQL'),{code:'42501'}))).toBe('database-permission');
    expect(identityMigrationFailureReason(new Error('Identity account import request failed'))).toBe('issuer-request-failed');
  });
  it('parses the complete supervisor descriptor including workload issuer schemas',()=>{
    const value=descriptor();expect(identityMigrationConfigurationSchema.parse(value)).toEqual(value);
  });
  it.each(['issuer','resource'] as const)('rejects unsafe %s',field=>{
    expect(()=>identityMigrationConfigurationSchema.parse({...descriptor(),[field]:'http://identity.example.test'})).toThrow();
  });
  it('rejects unrecognized bootstrap material and unsafe workload issuers',()=>{
    expect(()=>identityMigrationConfigurationSchema.parse({...descriptor(),token:'not-a-token'})).toThrow();
    const value=descriptor();value.workloads[0]!.issuer='http://untrusted.example.test';
    expect(()=>identityMigrationConfigurationSchema.parse(value)).toThrow();
  });
});
