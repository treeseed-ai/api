import {test,expect} from 'bun:test';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {ApiContainerBuild,NodeApiContainerPlugin} from '../../src/container.js';
import {InstalledSchemas} from '@treeseed-cordis/sdk';
class ApiContainerTestsIntegration {

 metadata():void{const metadata=JSON.parse(readFileSync('package.json','utf8'));expect(metadata.cordis).toEqual(ApiContainerBuild.metadata());expect(metadata.cordisService).toEqual(NodeApiContainerPlugin.definition);}
}
const suite=new ApiContainerTestsIntegration();
test('integration: package projects actual container class definition',suite.metadata.bind(suite));
