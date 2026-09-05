import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { createOperationHttpHandler } from '../../../../src/api/control-plane/http/operation-http-handler.ts';
import { createReadinessOperation } from '../../../../src/api/control-plane/catalog/core-operations.ts';
describe('managed credentials HTTP boundary',()=>{
  it('accepts explicit OAuth/CAS input without a confirmation challenge and returns metadata only',async()=>{
    const binding=CONTROL_PLANE_OPERATIONS.services.putCredentials;
    const handler=vi.fn(async(input:any)=>{
      expect(input.body).toEqual({expectedVersion:0,values:{apiToken:'synthetic-private'}});
      return{...input.path,custody:'openbao',version:1,configured:true,fields:['apiToken']};
    });
    const app=new Hono();
    app.put('/v1/teams/:teamId/services/:connectionId/credentials/:profileId',createOperationHttpHandler({binding,handler},async()=>({token:'synthetic',clientId:'client',scopes:['treeseed:projects:write'],extra:{principal:{id:'user'}}}),'digest'));
    const response=await app.request('/v1/teams/team/services/connection/credentials/profile',{method:'PUT',headers:{'content-type':'application/json','Idempotency-Key':'mutation-1'},body:JSON.stringify({expectedVersion:0,values:{apiToken:'synthetic-private'}})});
    expect(response.status).toBe(200);expect(await response.text()).not.toContain('synthetic-private');expect(handler).toHaveBeenCalledOnce();
  });
  it('readiness fails closed while OpenBao is unavailable',async()=>{
    const operation=createReadinessOperation({store:{ensureInitialized:async()=>{},first:async()=>({ok:1})},custodyReady:async()=>false});
    await expect(operation.handler({path:{},query:{},body:undefined},{} as any)).rejects.toMatchObject({status:503,code:'control_plane_custody_unavailable'});
  });
});
