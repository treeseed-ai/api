import { Hono } from 'hono';
import { expect, it } from 'vitest';
import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { OperationRegistry } from '../../../../src/api/control-plane/catalog/operation-registry.ts';
import { installControlPlaneProtocolRoutes } from '../../../../src/api/control-plane/http/protocol-routes.ts';

for (const roles of [['admin'],['platform_admin'],['team_owner'],[]]) {
  it(`does not expand read-only token scopes from roles or wildcard permission (${roles.join(',')})`, async () => {
    let invoked = false;
    const app = new Hono();
    const registry = new OperationRegistry([{binding:CONTROL_PLANE_OPERATIONS.projects.create,handler:async()=>{invoked=true;return {};}}]);
    installControlPlaneProtocolRoutes(app,async()=>({principal:{id:'user',roles,permissions:['*:*:*'],scopes:['treeseed:read']},credential:{id:'token'}}),undefined,registry);
    const result = await app.request('/v1/teams/team/projects',{method:'POST',headers:{authorization:'Bearer token','content-type':'application/json','idempotency-key':'test'},body:JSON.stringify({slug:'project',name:'Project'})});
    expect(result.status).toBe(403); expect(invoked).toBe(false);
  });
}

it('does not invent read scope when a valid token has no delegated scopes',async()=>{
  let invoked=false;
  const app=new Hono();
  const registry=new OperationRegistry([{binding:CONTROL_PLANE_OPERATIONS.projects.list,handler:async()=>{invoked=true;return [];}}]);
  installControlPlaneProtocolRoutes(app,async()=>({principal:{id:'user',roles:['admin'],scopes:[]},credential:{id:'token'}}),undefined,registry);
  const result=await app.request('/v1/projects',{headers:{authorization:'Bearer token'}});
  expect(result.status).toBe(403);expect(invoked).toBe(false);
});
