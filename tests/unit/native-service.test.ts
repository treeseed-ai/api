import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createServer,type Server } from 'node:http';
import { Context } from '@treeseed-cordis/sdk/composition';
import { ServiceSchemas,type ProbeContext,type ServiceObservationContext } from '@treeseed-cordis/sdk';
import { NodeApiServicePlugin,ApiReadinessPlugin } from '../../src/services.js';
import {NativeApiServiceTests} from '../support/native-service-test-support.js';
class NativeApiServiceTestsUnit extends NativeApiServiceTests {

    projection():void{const value=NodeApiServicePlugin.container;expect(value.definition.workerSocket).toBe(true);expect(value.definition.user).toBe('installation-owner');expect(value.dependencies.map(NativeApiServiceTests.port)).toEqual(['database','identity']);const json=JSON.stringify(value);expect(json).not.toContain('@database:');expect(json).not.toContain('http://identity:');expect(value.resources.grants).toHaveLength(3);}
}
const nativeApiServices=new NativeApiServiceTestsUnit();
test('unit: native API service owns typed dependencies and observer-only configuration',nativeApiServices.projection.bind(nativeApiServices));
