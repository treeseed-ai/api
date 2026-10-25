import { InstalledSchemas, ServiceSchemas, PlatformSchemas, type ServerConfiguration } from '@treeseed-cordis/sdk';
export class ApiConfiguration {
    static readonly schema = InstalledSchemas.serverConfiguration.extend({ serviceId: ServiceSchemas.serviceId.optional(), runtimeReceipt: PlatformSchemas.absolute.optional() });
    static parse(value: unknown): ReturnType<typeof ApiConfiguration.schema.parse> { const configuration = this.schema.parse(value); if ((configuration.serviceId === undefined) !== (configuration.runtimeReceipt === undefined)) throw new Error('API_CONFIGURATION_UNAVAILABLE'); if (configuration.serviceId && configuration.workerSocket !== '/run/cordis-host/host.sock') throw new Error('API_CONFIGURATION_UNAVAILABLE'); return configuration; }
    static owner(value: ReturnType<typeof ApiConfiguration.schema.parse>): ServerConfiguration { const { serviceId: _serviceId, runtimeReceipt: _runtimeReceipt, ...configuration } = value; return InstalledSchemas.serverConfiguration.parse(configuration); }
}
export type ApiServerConfiguration = ReturnType<typeof ApiConfiguration.parse>;
