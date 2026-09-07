import {CONTROL_PLANE_OPERATIONS} from '@treeseed/sdk/operator-contracts';
import type {createAiInstanceService} from '../../repositories/infrastructure/ai-instance-service.ts';
import {CapacityOperationError} from '../../repositories/capacity/capacity-operation-error.ts';
import {ControlPlaneOperationError,type BoundOperation} from '../operation-registry.ts';
export interface AiInstanceDependencies{aiInstances:ReturnType<typeof createAiInstanceService>}
export function createAiInstanceOperations({aiInstances:service}:AiInstanceDependencies):BoundOperation[]{
 const ops=CONTROL_PLANE_OPERATIONS.aiInstances;
 const wrap=async(call:()=>Promise<any>)=>{try{return await call();}catch(error){if(error instanceof CapacityOperationError)throw new ControlPlaneOperationError(error.status,error.code,error.message);throw error;}};
 return [
 {binding:ops.register,handler:(input,ctx)=>wrap(()=>service.register(ctx.principal,input.path.teamId,input.path.instanceId,input.body,ctx.ifMatch))},
 {binding:ops.list,handler:(input,ctx)=>wrap(()=>service.list(ctx.principal,input.path.teamId,input.query))},
 {binding:ops.show,handler:(input,ctx)=>wrap(()=>service.show(ctx.principal,input.path.teamId,input.path.instanceId))},
 {binding:ops.put,handler:(input,ctx)=>wrap(()=>service.put(ctx.principal,input.path.teamId,input.path.instanceId,input.body,ctx.ifMatch))},
 {binding:ops.remove,handler:(input,ctx)=>wrap(()=>service.remove(ctx.principal,input.path.teamId,input.path.instanceId,ctx.ifMatch))},
 ];
}
