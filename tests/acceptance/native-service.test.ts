import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createServer,type Server } from 'node:http';
import { Context } from '@treeseed-cordis/sdk/composition';
import { ServiceSchemas,type ProbeContext,type ServiceObservationContext } from '@treeseed-cordis/sdk';
import { NodeApiServicePlugin,ApiReadinessPlugin } from '../../src/services.js';
import {NativeApiServiceTests} from '../support/native-service-test-support.js';
class NativeApiServiceTestsAcceptance extends NativeApiServiceTests {

    publicProgram(): void { const code = "import {NodeApiServicePlugin,ApiReadinessPlugin} from '@treeseed-cordis/api';class Program{static run(){if(NodeApiServicePlugin.container.providedContracts[0].contractId!=='platform.api'||NodeApiServicePlugin.declaration.contractVersion!=='0.4.0-cordis.1'||!ApiReadinessPlugin.probe.schemes.includes('https'))throw new Error('Missing native API contracts');process.stdout.write('native-api-contracts-ok\\n');}}Program.run();"; const result = spawnSync('node', ['--input-type=module', '-e', code], { encoding: 'utf8' }); expect(result.status).toBe(0); expect(result.stderr).toBe(''); expect(result.stdout).toBe('native-api-contracts-ok\n'); }
}
const nativeApiServices=new NativeApiServiceTestsAcceptance();
test("acceptance: API publicly exports its native service and direct routed readiness contracts", nativeApiServices.publicProgram.bind(nativeApiServices));
