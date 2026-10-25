import {test,expect} from 'bun:test';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ApiBuild,ApiApplication} from '../src/server.js';
class ApiTests {
 program():void{const result=spawnSync('node',['dist/src/server.js','--describe'],{encoding:'utf8',timeout:5000});expect(result.status).toBe(0);expect(result.stderr).toBe('');const metadata=JSON.parse(result.stdout);expect(metadata.container.capability).toBe('container.api');expect(metadata.providers).toEqual(ApiBuild.providers());}
 invalidConfiguration():void{const directory=mkdtempSync(join(tmpdir(),'cordis api program ')),file=join(directory,'private.json');try{writeFileSync(file,JSON.stringify({secret:'API_SECRET_CANARY'}),{mode:0o600});const result=spawnSync('node',['dist/src/server.js','--serve','--configuration',file],{encoding:'utf8',timeout:5000});expect(result.status).toBe(2);expect(result.stdout+result.stderr).not.toContain('API_SECRET_CANARY');expect(ApiApplication.configurationFile.bind(ApiApplication,file)).toThrow();}finally{rmSync(directory,{recursive:true,force:true});}}
 metadata():void{const actual=JSON.parse(readFileSync('package.json','utf8'));expect(actual.cordis).toEqual(ApiBuild.metadata());expect(ApiBuild.providers().map(ApiTests.capability)).toEqual(['api.host','platform.invoker','api.routes','api.http']);}
 static capability(value:{capability:string}):string{return value.capability;}
}
const suite=new ApiTests();test('smoke: built API program declares real native roots and container',suite.program.bind(suite));test('unit: unconfigured API refuses credentials without output or listener',suite.invalidConfiguration.bind(suite));test('integration: API package projects actual owner plugin declarations',suite.metadata.bind(suite));
