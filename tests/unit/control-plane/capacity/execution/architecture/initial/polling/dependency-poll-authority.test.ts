import { describe, expect, it, vi } from 'vitest';
import { providerPrincipal } from '../../../../../../../../src/api/control-plane/repositories/providers/provider-runtime-service.ts';
import { leaseNextProviderAssignment, normalizeProviderAssignmentLeaseSeconds } from '../../../../../../../../src/api/capacity/services/capacity/assignments/lifecycle/assignment-lease-service.ts';

describe('provider poll input authority', () => {
	it('missing and insufficient provider poll scope deny before any assignment authority is returned', () => {
		for (const auth of [undefined, null, {}, { principal: { teamId: 'team', membershipId: 'membership', capacityProviderId: 'provider', scopes: [] } }]) {
			const before = structuredClone(auth); expect(() => providerPrincipal(auth, ['provider:assignments:read'])).toThrow(); expect(auth).toEqual(before);
		}
		const auth = { principal: { teamId: 'team', membershipId: 'membership', capacityProviderId: 'provider', scopes: ['provider:assignments:read'] } };
		expect(providerPrincipal(auth, ['provider:assignments:read'])).toEqual(auth.principal);
	});
	it('coerced empty fractional and nonfinite explicit lease seconds deny instead of creating authority from malformed poll input', () => {
		expect(normalizeProviderAssignmentLeaseSeconds(undefined)).toBe(300); expect(normalizeProviderAssignmentLeaseSeconds(30)).toBe(30);
		for (const value of ['', '30', null, true, 30.5, Number.NaN, Infinity, -Infinity]) expect(() => normalizeProviderAssignmentLeaseSeconds(value)).toThrow();
	});
	it('revalidates original provider availability after asynchronous synthesis before recovery explanations or lease writes', async () => {
		for (const boundary of ['synthesis', 'inventory']) {
		const expiry=Date.now()+100, session={id:'session',membership_id:'membership',team_id:'team',capacity_provider_id:'provider',
			status:'open',available_from:new Date(expiry-1000).toISOString(),available_until:new Date(expiry).toISOString(),
			execution_providers_json:JSON.stringify([{id:'executor',runtimeBuild:`sha256:${'a'.repeat(64)}`,status:'available'}])};
		const principal={teamId:'team',membershipId:'membership',capacityProviderId:'provider'}, request={providerSessionId:'session',leaseSeconds:30};
		const inputs=structuredClone({session,principal,request}); let writes=0,syntheses=0;
		const store:Parameters<typeof leaseNextProviderAssignment>[0]={ensureInitialized:async()=>undefined,
			first:async()=>null,all:async(sql)=>{if(boundary==='inventory'&&sql.includes("status IN ('pending', 'returned')")) {
				expect(Date.now()).toBeLessThan(expiry);while(Date.now()<expiry)await new Promise<void>(resolve=>setTimeout(resolve,expiry-Date.now()));
			}return [];},run:async()=>{writes++;},batch:async()=>{writes++;return [];},
			recordProviderAssignmentExplanation:async()=>{writes++;return null;},
			synthesizeProviderAssignments:async()=>{syntheses++;expect(Date.now()).toBeLessThan(expiry);
				if(boundary==='synthesis')while(Date.now()<expiry)await new Promise<void>(resolve=>setTimeout(resolve,expiry-Date.now()));return {};}};
		const reads=vi.spyOn(store,'first').mockImplementation(async(sql:string)=>sql.includes('provider.id AS provider_id')
			?{provider_id:'provider',provider_status:'active'}:sql.includes('capacity_provider_availability_sessions')?session:null);
		await expect(leaseNextProviderAssignment(store,principal,request)).rejects.toMatchObject({code:'provider_synthesis_window_expired',status:409});
		expect(syntheses).toBe(1);expect(writes).toBe(boundary==='synthesis'?0:1);expect({session,principal,request}).toEqual(inputs);
		reads.mockRestore();
		}
	});
});
