import {test,expect} from 'bun:test';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {ApiContainerBuild,NodeApiContainerPlugin} from '../../src/container.js';
import {InstalledSchemas} from '@treeseed-cordis/sdk';
class ApiContainerTestsAcceptance {

 program():void{const result=spawnSync('node',['dist/src/container.js','--describe'],{encoding:'utf8'});expect(result.status).toBe(0);expect(result.stderr).toBe('');expect(JSON.parse(result.stdout).capability).toBe('container.api');}
}
const suite=new ApiContainerTestsAcceptance();
test("acceptance: built API container program declares native provider",suite.program.bind(suite));
