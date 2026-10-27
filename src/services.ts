import { Service } from 'cordis';
import { Context } from '@treeseed-cordis/sdk/composition';
import { PlatformSchemas, ProviderV4Schemas, ServiceSchemas, ServiceProjectionSchemas, ServiceTokens, CanonicalJson, type ContainerService, type ServiceEngine, type ServiceExecutionContext, type ServiceIdentity, type ServiceReadiness, type ServiceProbe, type ProbeContext, type ServiceObservationContext } from '@treeseed-cordis/sdk';
import { ServiceHttpClient, type ServiceHttpRequests } from '@treeseed-cordis/deployment';
import { ApiJson } from './json.js';
export class ApiServicePolicy { static readonly replacement = { kind: 'restart' as const, stateVersion: 1, qualificationDigest: null }; }
export class NodeApiServicePlugin implements ContainerService {
    static readonly provide = ['container.service']; static readonly inject = ['deployment.services', 'service.context']; static readonly Config: typeof PlatformSchemas.empty = PlatformSchemas.empty; static readonly replacement = ApiServicePolicy.replacement;
    static readonly declaration: ReturnType<typeof ProviderV4Schemas.declaration.parse> = ProviderV4Schemas.declaration.parse({ id: 'api.node.service', pluginId: 'api', capability: 'container.service', contractVersion: ProviderV4Schemas.version, target: 'deployment', provide: this.provide, inject: this.inject });
    static readonly runtimeImages = [{ id: 'api', entry: 'dist/src/server.js' }];
    static readonly container: ReturnType<typeof ServiceProjectionSchemas.container.parse> = ServiceProjectionSchemas.container.parse({ definition: { imageId: 'api', command: ['--serve', '--configuration', '/run/secrets/api-config'], environment: {}, user: 'installation-owner', workerSocket: true, ports: [{ id: 'http', target: 8080 }], volumes: [], secrets: [{ slot: 'api-config', target: '/run/secrets/api-config' }] }, resources: { volumes: [], authorities: [], grants: [{ dependencyPort: 'database', slot: 'database-password' }, { dependencyPort: 'identity', slot: 'oidc-client' }, { dependencyPort: 'identity', slot: 'bootstrap-subject' }], slots: { 'api-config': { kind: 'json', value: {
        installationId: { $context: 'installationId' }, serviceId: { $context: 'serviceId' }, origin: { $context: 'origin' }, issuer: { $template: [{ $context: 'origin' }, '/identity/realms/cordis'] }, identityInternalOrigin: { $endpoint: { dependencyPort: 'identity', portId: 'http', scheme: 'http', path: '/', part: 'url' } }, clientId: 'cordis-admin', clientSecret: { $secret: { dependencyPort: 'identity', slot: 'oidc-client' } }, databaseUrl: { $template: ['postgresql://cordis:', { $secret: { dependencyPort: 'database', slot: 'database-password' } }, '@', { $endpoint: { dependencyPort: 'database', portId: 'postgres', scheme: 'tcp', path: '/', part: 'authority' } }, '/cordis'] }, bootstrapSubject: { $secret: { dependencyPort: 'identity', slot: 'bootstrap-subject' } }, workerSocket: '/run/cordis-host/host.sock', runtimeReceipt: '/app/cordis-runtime.json', assetDigest: { $context: 'assetDigest' }
    } } } }, providedContracts: [{ port: 'api', contractId: 'platform.api', contractVersion: '1.0.0' }], dependencies: [{ port: 'database', contractId: 'storage.postgres', contractVersion: '1.0.0' }, { port: 'identity', contractId: 'identity.oidc', contractVersion: '1.0.0' }], observationContract: 'platform.api', transitionPolicy: { kind: 'restart-required', stateVersion: 1 } });
    private readonly engine: ServiceEngine; private readonly execution: ServiceExecutionContext;
    constructor(private readonly context: Context) { this.engine = ServiceTokens.engine.parse(Reflect.get(context, ServiceTokens.engine.id)); this.execution = ServiceTokens.context.parse(Reflect.get(context, ServiceTokens.context.id)); }
    async [Service.init](): Promise<void> { await this.engine.start(this.execution.service.serviceId, this.execution.service.definition); this.context.provide(ServiceTokens.container().id, this); }
    identity(): ServiceIdentity { return this.engine.identity(this.execution.service.serviceId); }
    ready(): Promise<ServiceReadiness> { return this.engine.ready(this.execution.service.serviceId); }
}
export class ApiReadinessPlugin implements ServiceProbe {
    static readonly provide = ['probe.service']; static readonly inject: string[] = []; static readonly replacement = ApiServicePolicy.replacement;
    static readonly Config = PlatformSchemas.empty.extend({ apiPort: ServiceSchemas.serviceId.default('api'), authoritySlot: PlatformSchemas.slot.default('public-ca') });
    static readonly declaration: ReturnType<typeof ProviderV4Schemas.declaration.parse> = ProviderV4Schemas.declaration.parse({ id: 'api.runtime.readiness', pluginId: 'api', capability: 'probe.service', contractVersion: ProviderV4Schemas.version, target: 'deployment', provide: this.provide, inject: this.inject });
    static readonly probe = { observationContracts: ['platform.api', 'edge.https'], schemes: ['http', 'https'], maximumDeadlineMs: 120000 };
    private readonly configuration: ReturnType<typeof ApiReadinessPlugin.Config.parse>;
    constructor(context: Context, configuration: unknown, private readonly transport: ServiceHttpRequests = new ServiceHttpClient()) { this.configuration = ApiReadinessPlugin.Config.parse(configuration); context.provide(ServiceTokens.probe().id, this); }
    private target(context: ProbeContext): ServiceObservationContext['identity'] {
        const observation = ServiceSchemas.observationContext.parse(context.observation), identity = observation.identity;
        if (identity.serviceId !== context.serviceId || identity.installationId !== context.expected.installationId || identity.compositionGeneration !== context.expected.compositionGeneration || identity.serviceGeneration !== context.expected.serviceGeneration || identity.assetDigest !== context.expected.assetDigest) throw new Error('API_OBSERVATION_UNAVAILABLE');
        if (new URL(context.endpoint).protocol === 'http:') return identity;
        let selected: ServiceObservationContext['identity'] | undefined;
        for (const dependency of observation.dependencies) if (dependency.port === this.configuration.apiPort && dependency.contractId === 'platform.api' && dependency.contractVersion === '1.0.0') { if (selected) throw new Error('API_OBSERVATION_UNAVAILABLE'); selected = dependency.identity; }
        if (!selected) throw new Error('API_OBSERVATION_UNAVAILABLE'); return selected;
    }
    async observe(context: ProbeContext): Promise<ServiceReadiness> {
        try {
            const target = this.target(context); if (!target.runtime) throw new Error('API_OBSERVATION_UNAVAILABLE');
            const authorityReference = new URL(context.endpoint).protocol === 'https:' ? 'secret://' + context.serviceId + '/' + this.configuration.authoritySlot : undefined;
            const evidence = ServiceSchemas.runtimeEvidence.parse(ApiJson.parse(await this.transport.read(context, { path: '/health/ready', maximumBytes: 65536, authorityReference })));
            if (context.signal.aborted || context.deadline <= Date.now() || !evidence.ready || evidence.installationId !== target.installationId || evidence.serviceId !== target.serviceId || evidence.compositionGeneration !== target.compositionGeneration || evidence.serviceGeneration !== target.serviceGeneration || evidence.assetDigest !== target.assetDigest || evidence.content?.packageSetDigest !== target.runtime.packageSetDigest || evidence.content.entryDigest !== target.runtime.entryDigest) throw new Error('API_OBSERVATION_UNAVAILABLE');
            const acknowledgement = ServiceSchemas.acknowledgement.parse({ target: 'api', scopeId: 'installation:' + target.installationId + ':service:' + target.serviceId, generation: target.compositionGeneration, runtimeGeneration: evidence.runtimeGeneration, observationDigest: CanonicalJson.digest(evidence), ready: true });
            return { serviceId: context.serviceId, ready: true, observations: ['api.runtime.verified'], acknowledgements: [acknowledgement] };
        } catch { return { serviceId: context.serviceId, ready: false, observations: ['api.runtime.unavailable'] }; }
    }
}
