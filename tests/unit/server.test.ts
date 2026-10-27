import {test,expect} from 'bun:test';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ApiBuild,ApiApplication} from '../../src/server.js';
import {ApiTests} from '../support/server-test-support.js';
class ApiTestsUnit extends ApiTests {

 invalidConfiguration():void{const directory=mkdtempSync(join(tmpdir(),'cordis api program ')),file=join(directory,'private.json');try{writeFileSync(file,JSON.stringify({secret:'API_SECRET_CANARY'}),{mode:0o600});const result=spawnSync('node',['dist/src/server.js','--serve','--configuration',file],{encoding:'utf8',timeout:5000});expect(result.status).toBe(2);expect(result.stdout+result.stderr).not.toContain('API_SECRET_CANARY');expect(ApiApplication.configurationFile.bind(ApiApplication,file)).toThrow();}finally{rmSync(directory,{recursive:true,force:true});}}
}
const suite=new ApiTestsUnit();
test('unit: unconfigured API refuses credentials without output or listener',suite.invalidConfiguration.bind(suite));
