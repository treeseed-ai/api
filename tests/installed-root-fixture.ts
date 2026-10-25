import { spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:net';
import { mkdirSync, readFileSync, copyFileSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { CanonicalJson, ServiceSchemas, PluginManagementSchemas, type ServiceInstance, type ContainerProjection, type PluginExportDescriptor } from '@treeseed-cordis/sdk';
import { ServiceRuntimeFixture } from '@treeseed-cordis/deployment/testing/runtime';
import { PostgresServicePlugin, PostgresReadinessPlugin, CaddyServicePlugin, ServiceProjection, ServiceWorkerBuild, PackageArchiveInspector } from '@treeseed-cordis/deployment';
import { KeycloakServicePlugin, KeycloakReadinessPlugin } from '@treeseed-cordis/identity/services';
import { NodeApiServicePlugin, ApiReadinessPlugin } from '../src/services.js';
import { ApiBuild } from '../src/server.js';
import { PreparedApiPackages, type PreparedApiPackage } from './runtime-packages.js';
class FixturePort {
    private readonly server: Server = createServer();
    async get(): Promise<number> { await new Promise<void>(this.listen.bind(this)); const address = this.server.address(); if (!address || typeof address === 'string') throw new Error('Fixture port unavailable'); const port = address.port; await new Promise<void>(this.close.bind(this)); return port; }
    private listen(accept: (value: void) => void): void { this.server.listen(0, '127.0.0.1', accept); }
    private close(accept: (value: void) => void): void { this.server.close(this.closed.bind(this, accept)); }
    private closed(accept: (value: void) => void): void { accept(); }
}
interface FixtureDefinition { id: string; owner: string; container: typeof NodeApiServicePlugin | typeof PostgresServicePlugin | typeof KeycloakServicePlugin | typeof CaddyServicePlugin; probe: typeof ApiReadinessPlugin | typeof PostgresReadinessPlugin | typeof KeycloakReadinessPlugin; dependencies: Record<string, string>; }
/** Genuine owner archives/images. This class is a test-only composition producer. */
export class InstalledApiFixture extends ServiceRuntimeFixture {
    private readonly apiTag = 'cordis-api-root-fixture:' + CanonicalJson.digest(this.root).slice(0, 16);
    private static command(args: string[], cwd?: string): string { const result = spawnSync('docker', args, { cwd, encoding: 'utf8', timeout: 180000, maxBuffer: 16 * 1024 * 1024 }); if (result.status !== 0) throw new Error('API fixture Docker prerequisite failed: ' + result.stderr.slice(-2000)); return result.stdout.trim(); }
    private readonly packages = new Map<string, PreparedApiPackage>(); private readonly descriptors = new Map<string, ReturnType<typeof PluginManagementSchemas.packageDescriptor.parse>>();
    private reference(owner: string, providerId: string): ServiceInstance['provider'] { const name = '@treeseed-cordis/' + owner, artifact = this.packages.get(name)!, descriptor = this.descriptors.get(name)!; let exported: PluginExportDescriptor | undefined; for (const candidate of descriptor.providers) if (candidate.declaration.id === providerId) exported = candidate; if (!exported) throw new Error('Fixture owner export unavailable'); return ServiceSchemas.provider.parse({ pluginId: descriptor.pluginId, providerId, target: 'deployment', package: { name, version: artifact.version, sha256: artifact.sha256 }, entry: exported.entry, classExport: exported.classExport, contractVersion: exported.declaration.contractVersion }); }
    async prepared(): Promise<this> {
        await this.services(); this.configuration.origin = 'https://localhost:' + await new FixturePort().get();
        const sources = await new PreparedApiPackages(join(this.bundle, 'archives')).prepare();
        for (const item of sources) { this.packages.set(item.name, item); const index = await PackageArchiveInspector.inspect(item.path, item.sha256); if (index.metadata.cordisPackage !== undefined) this.descriptors.set(item.name, PluginManagementSchemas.packageDescriptor.parse(index.metadata.cordisPackage)); }
        this.configuration.plugins = []; for (const [name, descriptor] of this.descriptors) { const item = this.packages.get(name)!; this.configuration.plugins.push({ id: descriptor.pluginId, package: name, version: item.version, integrity: item.sha256 }); }
        const build = join(this.root, 'api-image-context'); mkdirSync(build, { mode: 0o700 }); const base = spawnSync('docker', ['image', 'inspect', ServiceRuntimeFixture.base], { encoding: 'utf8' }); if (base.status !== 0) InstalledApiFixture.command(['image', 'pull', ServiceRuntimeFixture.base]);
        const built = await ApiBuild.imageContext(build, ServiceRuntimeFixture.base, sources); InstalledApiFixture.command(['build', '--network=none', '--pull=false', '--tag', this.apiTag, build]);
        const postgres = this.preparedImage(PostgresServicePlugin.image.reference, 'postgres', 'oci-postgres'), identity = this.preparedImage(KeycloakServicePlugin.image.reference, 'keycloak', 'oci-keycloak'), caddy = this.preparedImage(CaddyServicePlugin.image.reference, 'caddy', 'oci-caddy'), api = this.preparedImage(this.apiTag, 'api', 'oci-api'); api.reference = 'fixture/api@sha256:' + api.manifestDigest;
        for (const [actual, expected] of [[postgres, PostgresServicePlugin.image], [identity, KeycloakServicePlugin.image], [caddy, CaddyServicePlugin.image]] as const) {if(actual.manifestDigest!==expected.manifestDigest)throw new Error('Prepared owner manifest selection changed');if(actual.indexSha256!==expected.indexSha256){const path=join(this.bundle,actual.layout,'index.json'),before=readFileSync(path);if(ApiBuildHash.sha(before)!==actual.indexSha256)throw new Error('Fixture index changed');const canonical=CanonicalJson.stringify(JSON.parse(before.toString()))+'\n';if(ApiBuildHash.sha(Buffer.from(canonical))!==expected.indexSha256)throw new Error('Prepared owner index selection changed');writeFileSync(path,canonical);actual.indexSha256=expected.indexSha256;}}
        const workerDirectory = join(this.root, 'worker-build'); mkdirSync(workerDirectory, { mode: 0o700 }); const worker = ServiceWorkerBuild.produce(workerDirectory); copyFileSync(join(workerDirectory, worker.path), join(this.bundle, 'host-worker'));
        const definitions: FixtureDefinition[] = [
            { id: 'store-main', owner: 'deployment', container: PostgresServicePlugin, probe: PostgresReadinessPlugin, dependencies: {} },
            { id: 'issuer-main', owner: 'identity', container: KeycloakServicePlugin, probe: KeycloakReadinessPlugin, dependencies: { database: 'store-main' } },
            { id: 'api-main', owner: 'api', container: NodeApiServicePlugin, probe: ApiReadinessPlugin, dependencies: { database: 'store-main', identity: 'issuer-main' } },
            { id: 'public-main', owner: 'deployment', container: CaddyServicePlugin, probe: ApiReadinessPlugin, dependencies: { api: 'api-main', identity: 'issuer-main' } }
        ];
        const services: ServiceInstance[] = [];
        for (const item of definitions) {
            const projection: ContainerProjection = item.container.container, dependencies = []; for (const required of projection.dependencies) dependencies.push({ ...required, bindingId: item.dependencies[required.port]! });
            const grants = []; for (const grant of projection.resources.grants) grants.push({ serviceId: item.dependencies[grant.dependencyPort]!, slot: grant.slot });
            const probeOwner = item.probe === ApiReadinessPlugin ? 'api' : item.owner, configuration = item.probe === KeycloakReadinessPlugin ? { issuer: this.configuration.origin + '/identity/realms/cordis' } : {};
            services.push(ServiceSchemas.service.parse({ serviceId: item.id, provider: this.reference(item.owner, item.container.declaration.id), configuration: {}, definition: projection.definition, bindings: projection.providedContracts.map(InstalledApiFixture.serviceBinding.bind(null, item.id)), dependencies, resources: { ...projection.resources, grants }, transitionPolicy: projection.transitionPolicy, readiness: { provider: this.reference(probeOwner, item.probe.declaration.id), configuration, scheme: item.probe === PostgresReadinessPlugin ? 'tcp' : item.id === 'public-main' ? 'https' : 'http', endpoint: { serviceId: item.id, portId: item.id === 'public-main' ? 'https' : item.probe === PostgresReadinessPlugin ? 'postgres' : 'http' }, observationContract: projection.observationContract, deadlineMs: 120000, credentialReferences: item.probe === PostgresReadinessPlugin ? ['secret://' + item.id + '/database-password'] : item.id === 'public-main' ? ['secret://' + item.id + '/public-ca'] : [] } }));
        }
        const graph = ServiceSchemas.graph.parse({ profile: { id: 'genuine-api-fixture', version: '1.0.0', requiredBindings: definitions.map(InstalledApiFixture.id), workerSocketServiceId: 'api-main' }, assetDigest: built.assetDigest, worker: { ...worker, path: 'host-worker' }, services });
        this.recipe = { services: {}, volumes: {}, secrets: {} }; this.configuration.credentialReferences = [];
        const images = [postgres, identity, api, caddy];
        for (const service of graph.services) {
            const item = definitions.find(InstalledApiFixture.matches.bind(null, service.serviceId))!, projection = ServiceProjection.resolve(service, item.container.container, graph, this.configuration); service.definition = projection.definition; service.resources = projection.resources;
            const image = images.find(InstalledApiFixture.image.bind(null, service.definition.imageId))!, spec: typeof this.recipe.services[string] = { image: image.reference };
            if (service.dependencies.length) spec.depends_on = service.dependencies.map(InstalledApiFixture.dependency).sort();
            if (service.definition.volumes.length) { spec.volumes = []; for (const volume of service.definition.volumes) { const key = InstalledApiFixture.resource(service.serviceId, volume.source); this.recipe.volumes[key] = {}; spec.volumes.push({ type: 'volume', source: key, target: volume.target, read_only: volume.readOnly }); } }
            for (const slot of Object.keys(service.resources.slots)) { const key = InstalledApiFixture.resource(service.serviceId, slot); this.recipe.secrets[key] = { file: '.cordis/credentials/' + service.serviceId + '/' + slot }; this.configuration.credentialReferences.push('secret://' + service.serviceId + '/' + slot); }
            if (service.definition.secrets.length) { spec.secrets = []; for (const secret of service.definition.secrets) spec.secrets.push(InstalledApiFixture.resource(service.serviceId, secret.slot)); }
            if (service.serviceId === 'public-main') { const port = Number(new URL(this.configuration.origin).port); service.definition.ports[0]!.publication = { host: '127.0.0.1', port }; spec.ports = [{ host_ip: '127.0.0.1', published: port, target: 443, protocol: 'tcp' }]; }
            this.recipe.services[service.serviceId] = spec;
        }
        const dependencies: Record<string, string> = {}; for (const source of sources) dependencies[source.name] = source.name.startsWith('@treeseed-cordis/') ? 'file:archives/' + basename(source.path) : source.version;
        const packageJson = this.write('package.json', { name: 'genuine-api-root-fixture', version: '1.0.0', private: true, dependencies }), lock = spawnSync('bun', ['install', '--lockfile-only', '--force', '--ignore-scripts'], { cwd: this.bundle, encoding: 'utf8', timeout: 30000, env: { ...process.env, BUN_INSTALL_CACHE_DIR: join(this.root, 'bundle-lock-cache') } }); if (lock.status !== 0) throw new Error('API fixture local lock failed: ' + lock.stderr.slice(-2000));
        this.release = ServiceSchemas.release.parse({ formatVersion: 3, packageJson: { path: 'package.json', sha256: packageJson }, lockfile: { path: 'bun.lock', sha256: ApiBuildHash.sha(readFileSync(join(this.bundle, 'bun.lock'))) }, recipe: { path: 'compose.json', sha256: this.write('compose.json', this.recipe) }, requiredPluginIds: this.configuration.plugins.map(InstalledApiFixture.plugin), requiredServices: ['container.service', 'probe.service'], packages: sources.map(InstalledApiFixture.archive), images, composition: graph }); this.refreshService(); return this;
    }
    private static serviceBinding(id: string, contract: { port: string; contractId: string; contractVersion: string }): { port: string; bindingId: string; contractId: string; contractVersion: string } { return { ...contract, bindingId: id }; }
    private static id(item: FixtureDefinition): string { return item.id; }
    private static matches(id: string, item: FixtureDefinition): boolean { return item.id === id; }
    private static image(id: string, image: { id: string }): boolean { return image.id === id; }
    private static dependency(item: { bindingId: string }): string { return item.bindingId; }
    private static resource(serviceId: string, slot: string): string { return 'r-' + CanonicalJson.digest({ serviceId, slot }).slice(0, 48); }
    private static plugin(item: { id: string }): string { return item.id; }
    private static archive(item: PreparedApiPackage): PreparedApiPackage { return { ...item, path: 'archives/' + basename(item.path) }; }
    override close(): void { super.close(); spawnSync('docker', ['image', 'rm', this.apiTag], { encoding: 'utf8' }); }
}
import { createHash } from 'node:crypto';
class ApiBuildHash { static sha(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); } }
