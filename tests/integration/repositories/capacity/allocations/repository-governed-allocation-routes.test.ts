import { Hono } from 'hono';
import { describe,expect,it,vi } from 'vitest';
import type { CapacityGovernanceDatabase } from '../../../../../src/api/capacity/database.ts';
import { installCapacityPolicyRoutes } from '../../../../../src/api/capacity/routes/support/policy.ts';

describe('repository-governed allocation routes',()=>{
	it.each([
		['/v1/teams/team-a/capacity/allocation-sets/plan',{}],
		['/v1/teams/team-a/capacity/allocation-sets',{}],
		['/v1/teams/team-a/capacity/allocation-sets/allocation-a/activate',{}],
		['/v1/teams/team-a/capacity/allocation-sets/allocation-a/supersede',{}],
		['/v1/teams/team-a/capacity/allocation-sets/allocation-a/archive',{}],
	])('returns unknown-route behavior with zero control-plane mutation for %s',async(path,body)=>{
		const app=new Hono();
		const mutation=vi.fn();
		const store={run:mutation,batch:mutation} as unknown as CapacityGovernanceDatabase;
		const requireTeamAccess=vi.fn(async()=>({principal:{id:'owner-a'}}));
		installCapacityPolicyRoutes(app,{store,requireTeamAccess});
		const response=await app.request(path,{method:'POST',headers:{'content-type':'application/json','idempotency-key':'denied'},body:JSON.stringify(body)});
		expect(response.status).toBe(404);
		expect(requireTeamAccess).not.toHaveBeenCalled();
		expect(mutation).not.toHaveBeenCalled();
	});
});
