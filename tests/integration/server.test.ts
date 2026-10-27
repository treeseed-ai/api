import {test,expect} from 'bun:test';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ApiBuild,ApiApplication} from '../../src/server.js';
import {ApiTests} from '../support/server-test-support.js';
class ApiTestsIntegration extends ApiTests {

 metadata():void{const actual=JSON.parse(readFileSync('package.json','utf8'));expect(actual.cordis).toEqual(ApiBuild.metadata());expect(ApiBuild.providers().map(ApiTests.capability)).toEqual(['api.host','platform.invoker','api.routes','api.http']);}
}
const suite=new ApiTestsIntegration();
test('integration: API package projects actual owner plugin declarations',suite.metadata.bind(suite));
