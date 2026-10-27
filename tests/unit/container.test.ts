import {test,expect} from 'bun:test';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {ApiContainerBuild,NodeApiContainerPlugin} from '../../src/container.js';
import {InstalledSchemas} from '@treeseed-cordis/sdk';
class ApiContainerTestsUnit {

 definition():void{const definition=InstalledSchemas.definition.parse(NodeApiContainerPlugin.definition);expect(definition.service.workerSocket).toBe(true);expect(definition.service.command).toEqual(['--serve','--configuration','/run/secrets/api-config']);expect(definition.service.environment).toBeUndefined();expect(NodeApiContainerPlugin.inject).toEqual(['deployment.engine','container.database','container.identity']);}
}
const suite=new ApiContainerTestsUnit();
test('unit: API container declares bounded configuration and dependencies',suite.definition.bind(suite));
