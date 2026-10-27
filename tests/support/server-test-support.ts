import {test,expect} from 'bun:test';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ApiBuild,ApiApplication} from '../../src/server.js';
export class ApiTests {
 static capability(value:{capability:string}):string{return value.capability;}
}
