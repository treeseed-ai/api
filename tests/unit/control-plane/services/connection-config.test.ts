import {expect,it} from 'vitest';
import {cloudflareConnectionConfig} from '../../../../src/api/control-plane/repositories/services/connection-config.ts';
const cap=(capabilityType:string)=>({capabilityType,status:'configured'});
it('uses account-level configuration and requires domain only for DNS',()=>{
  expect(cloudflareConnectionConfig({deploymentEnvironment:'staging',domain:'unused',zoneId:'untrusted'},[cap('object-storage')])).toEqual({});
  expect(cloudflareConnectionConfig({deploymentEnvironment:'production'},[cap('frontend-hosting')])).toEqual({});
  expect(()=>cloudflareConnectionConfig({},[cap('dns-management')])).toThrow('domain');
  expect(cloudflareConnectionConfig({domain:'Example.COM'},[cap('dns-management')])).toEqual({domain:'example.com'});
});
it('only preserves previously verified IDs for unchanged domain and account',()=>{
  const existing={accountId:'a',domain:'example.com',zoneId:'verified'};
  expect(cloudflareConnectionConfig({...existing,zoneId:'injected'},[cap('dns-management')],existing).zoneId).toBe('verified');
  expect(cloudflareConnectionConfig({...existing,domain:'other.com'},[cap('dns-management')],existing).zoneId).toBeUndefined();
  expect(cloudflareConnectionConfig({...existing,accountId:'b'},[cap('dns-management')],existing).zoneId).toBeUndefined();
  expect(cloudflareConnectionConfig(existing,[cap('dns-management')]).zoneId).toBeUndefined();
});
