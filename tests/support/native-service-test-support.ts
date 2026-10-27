import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createServer,type Server } from 'node:http';
import { Context } from '@treeseed-cordis/sdk/composition';
import { ServiceSchemas,type ProbeContext,type ServiceObservationContext } from '@treeseed-cordis/sdk';
import { NodeApiServicePlugin,ApiReadinessPlugin } from '../../src/services.js';
export class NativeApiServiceTests {
    protected body='';
    protected respond(_request:unknown,response:import('node:http').ServerResponse):void{response.end(this.body);}
    protected server:Server|null=null;
    protected listen(accept:(value:void)=>void):void{this.server!.listen(0,'127.0.0.1',accept);}
    protected close(accept:(value:void)=>void):void{this.server!.close(this.closed.bind(this,accept));}
    protected closed(accept:(value:void)=>void):void{accept();}
    protected async denied():Promise<Uint8Array>{throw new Error('Unexpected credential access');}
    protected static port(value:{port:string}):string{return value.port;}
}
