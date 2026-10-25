import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { type IncomingMessage } from 'node:http';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { CanonicalJson, ServiceSchemas, PluginManagementSchemas, type ProbeContext, type ServicePlan } from '@treeseed-cordis/sdk';
import { ComposeDeploymentHost, ServiceHostRuntime, ServiceWorkerOwnerClient, ServiceWorkerClient, ServicePlanStore, ServiceAuthorityExports, ServiceRuntimeInspection, PackageArchiveInspector } from '@treeseed-cordis/deployment';
import { ApiJson } from '../src/json.js';
class EdgeRead {
    private resolve: ((value: { status: number; body: Buffer; headers: IncomingMessage['headers'] }) => void) | null = null; private reject: ((error: Error) => void) | null = null;
    private chunks: Buffer[] = []; private length = 0; private response: IncomingMessage | null = null;
    constructor(private readonly origin: URL, private readonly path: string, private readonly ca: Buffer) { }
    get(): Promise<{ status: number; body: Buffer; headers: IncomingMessage['headers'] }> { return new Promise(this.start.bind(this)); }
    private start(resolve: (value: { status: number; body: Buffer; headers: IncomingMessage['headers'] }) => void, reject: (error: Error) => void): void { this.resolve = resolve; this.reject = reject; const options: RequestOptions = { hostname: '127.0.0.1', port: Number(this.origin.port || 443), servername: this.origin.hostname, path: this.path, method: 'GET', headers: { host: this.origin.host }, ca: this.ca, rejectUnauthorized: true, agent: false, timeout: 10000 }, request = httpsRequest(options, this.received.bind(this)); request.once('error', this.failed.bind(this)); request.once('timeout', request.destroy.bind(request)); request.end(); }
    private received(response: IncomingMessage): void { this.response = response; response.on('data', this.data.bind(this)); response.once('error', this.failed.bind(this)); response.once('end', this.end.bind(this)); }
    private data(bytes: Buffer): void { this.length += bytes.length; if (this.length > 4 * 1024 * 1024) { this.response?.destroy(); this.failed(); return; } this.chunks.push(bytes); }
    private end(): void { if (!this.response?.complete || this.length > 4 * 1024 * 1024) { this.failed(); return; } this.resolve!({ status: this.response.statusCode ?? 0, body: Buffer.concat(this.chunks), headers: this.response.headers }); }
    private failed(): void { this.reject!(new Error('Fixture verified HTTPS request failed')); }
}
class InstalledApiProgram {
    private static require(value: unknown): asserts value { if (!value) throw new Error('Genuine API root qualification failed'); }
    static async run(file: string): Promise<void> {
        this.require(readFileSync('/etc/os-release', 'utf8').includes('VERSION_ID="26.04"') && process.arch === 'x64'); const configuration = ServiceSchemas.configuration.parse(ApiJson.parse(readFileSync(file))), plan = await new ComposeDeploymentHost().plan(configuration); this.require(plan.formatVersion === 3);
        const host = await ServiceHostRuntime.start(plan), owner = new ServiceWorkerOwnerClient({ installationDirectory: configuration.installationDirectory }), observer = new ServiceWorkerClient({ installationDirectory: configuration.installationDirectory });
        try {
            const accepted = await owner.submit({ protocol: 3, operation: 'submit', planId: plan.id, digest: plan.digest, idempotencyKey: 'genuine-api-root' }), until = Date.now() + 180000; let application = await owner.application(accepted.id);
            while (!['completed', 'failed', 'cancelled'].includes(application.phase) && Date.now() < until) { await new Promise(this.delay); application = await owner.application(accepted.id); }
            if (application.phase !== 'completed') throw new Error('Genuine API root application phase: ' + application.phase + '; result: ' + application.result);
            const status = await observer.status(); this.require(status.ready && status.services.length === 4); const identity = (await observer.observationContext('api-main')).identity, exports = new ServiceAuthorityExports(plan), ca = Buffer.from(await exports.read('public-main', 'secret://public-main/public-ca', { deadline: Date.now() + 10000, signal: new AbortController().signal })), origin = new URL(configuration.origin);
            const response = await new EdgeRead(origin, '/health/ready', ca).get(), evidence = ServiceSchemas.runtimeEvidence.parse(ApiJson.parse(response.body)); this.require(response.status === 200 && evidence.ready && evidence.installationId === identity.installationId && evidence.serviceId === identity.serviceId && evidence.compositionGeneration === identity.compositionGeneration && evidence.serviceGeneration === identity.serviceGeneration && evidence.assetDigest === plan.composition.assetDigest && evidence.content?.entryDigest === identity.runtime?.entryDigest && evidence.content?.packageSetDigest === identity.runtime?.packageSetDigest);
            const discovery = await new EdgeRead(origin, '/identity/realms/cordis/.well-known/openid-configuration', ca).get(), document = ApiJson.parse(discovery.body) as { issuer: string; token_endpoint: string; code_challenge_methods_supported: string[] }; this.require(discovery.status === 200 && document.issuer === configuration.origin + '/identity/realms/cordis' && document.token_endpoint === document.issuer + '/protocol/openid-connect/token' && document.code_challenge_methods_supported.includes('S256'));
            const denied = await new EdgeRead(origin, '/v1/platform/status', ca).get(); this.require(denied.status === 401 && (ApiJson.parse(denied.body) as { code: string }).code === 'AUTHENTICATION_REQUIRED');
            let assets = 0; for (const archive of plan.artifacts) if (archive.kind === 'package') { const source = plan.composition.services.find(InstalledApiProgram.package.bind(null, archive.name)); if (source || ['@treeseed-cordis/ui', '@treeseed-cordis/admin'].includes(archive.name)) { const release = ServiceSchemas.release.parse(ApiJson.parse(readFileSync(join(configuration.release.directory, 'release.json')))), inventory = release.packages.find(InstalledApiProgram.name.bind(null, archive.name))!; const index = await PackageArchiveInspector.inspect(join(configuration.release.directory, inventory.path), archive.sha256); if (index.metadata.cordisPackage) { const descriptor = PluginManagementSchemas.packageDescriptor.parse(index.metadata.cordisPackage); for (const asset of descriptor.assets) { const extension = asset.path.endsWith('.css') ? '.css' : '.js', path = '/assets/' + (extension === '.css' ? 'ui/' : '') + asset.sha256 + extension, actual = await new EdgeRead(origin, path, ca).get(); this.require(actual.status === 200 && actual.body.length === asset.size && createHash('sha256').update(actual.body).digest('hex') === asset.sha256 && actual.headers['cache-control'] === 'public, max-age=31536000, immutable'); assets++; } } } }
            this.require(assets >= 3); const store = new ServicePlanStore(configuration.installationDirectory), before = CanonicalJson.stringify({ resources: store.resources(), current: store.current() }); this.require(status.acknowledgements.some(InstalledApiProgram.apiAck));
            rmSync(configuration.release.directory, { recursive: true }); this.require((await observer.status()).ready && before === CanonicalJson.stringify({ resources: store.resources(), current: store.current() }));
            await host.close(); for (const service of plan.composition.services) { const retained = spawnSync('docker', ['--host', plan.expectedEngine.endpoint, 'container', 'inspect', '--format', '{{.State.Running}}', plan.projectName + '_' + service.serviceId], { encoding: 'utf8' }); this.require(retained.status === 0 && retained.stdout.trim() === 'true'); }
            process.stdout.write(JSON.stringify({ fixtureOnly: true, genuineKeycloak: true, nativeApi: true, publicTls: true, unauthenticatedDenied: true, assetsVerified: true, sourceFree: true, retained: true }) + '\n');
        } finally { await host.close(); }
    }
    private static name(name: string, item: { name: string }): boolean { return item.name === name; }
    private static package(name: string, service: ServicePlan['composition']['services'][number]): boolean { return service.provider.package.name === name; }
    private static apiAck(value: { target: string; ready: boolean }): boolean { return value.target === 'api' && value.ready; }
    private static delay(accept: (value: void) => void): void { setTimeout(accept, 100); }
}
await InstalledApiProgram.run(process.argv[2]!);
