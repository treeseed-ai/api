import {test,expect} from 'bun:test';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ApiBuild,ApiApplication} from '../../src/server.js';
import {ApiTests} from '../support/server-test-support.js';
class ApiTestsAcceptance extends ApiTests {

 program():void{const result=spawnSync('node',['dist/src/server.js','--describe'],{encoding:'utf8',timeout:5000});expect(result.status).toBe(0);expect(result.stderr).toBe('');const metadata=JSON.parse(result.stdout);expect(metadata.container.capability).toBe('container.api');expect(metadata.providers).toEqual(ApiBuild.providers());}
}
const suite=new ApiTestsAcceptance();
test("acceptance: built API program declares real native roots and container",suite.program.bind(suite));
