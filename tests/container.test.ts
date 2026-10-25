import {test,expect} from 'bun:test';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {ApiContainerBuild,NodeApiContainerPlugin} from '../src/container.js';
import {InstalledSchemas} from '@treeseed-cordis/sdk';
class ApiContainerTests {
 program():void{const result=spawnSync('node',['dist/src/container.js','--describe'],{encoding:'utf8'});expect(result.status).toBe(0);expect(result.stderr).toBe('');expect(JSON.parse(result.stdout).capability).toBe('container.api');}
 definition():void{const definition=InstalledSchemas.definition.parse(NodeApiContainerPlugin.definition);expect(definition.service.workerSocket).toBe(true);expect(definition.service.command).toEqual(['--serve','--configuration','/run/secrets/api-config']);expect(definition.service.environment).toBeUndefined();expect(NodeApiContainerPlugin.inject).toEqual(['deployment.engine','container.database','container.identity']);}
 metadata():void{const metadata=JSON.parse(readFileSync('package.json','utf8'));expect(metadata.cordis).toEqual(ApiContainerBuild.metadata());expect(metadata.cordisService).toEqual(NodeApiContainerPlugin.definition);}
}
const suite=new ApiContainerTests();test('smoke: built API container program declares native provider',suite.program.bind(suite));test('unit: API container declares bounded configuration and dependencies',suite.definition.bind(suite));test('integration: package projects actual container class definition',suite.metadata.bind(suite));
