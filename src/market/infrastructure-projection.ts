import { anchorPart, compact, compareDatesDesc, describeState, safeArray, toneForState, type OperationalTone, } from './operational-artifacts.js';
import { loadProjectBundle, projectItem, repositoryItems, deploymentItems, providerItem, providerDetailItems, capacityOperationItems, workerItems, hostItem, projectResourceItem, productItem, policyItems, seedItems, diagnosticsFromCapacity, diagnosticsFromDeployments, diagnosticsFromHosts, diagnosticsFromSeeds, auditDiagnosticItem, emptyProjection, call, latestDate, compareItemDesc, repositoryLabel, projectName, seedSummary, titleFromEvent, dedupeBy } from "./infrastructure-projection-support/index.js";
export interface InfrastructureMetric {
    label: string;
    value: string | number;
    description?: string;
    tone?: OperationalTone;
}
export interface InfrastructureItem {
    id: string;
    title: string;
    description?: string;
    category: 'infrastructure' | 'governance' | 'knowledge' | 'execution';
    state?: string;
    tone?: OperationalTone;
    href?: string;
    meta?: string;
    timestamp?: string | null;
    projectId?: string | null;
    projectName?: string | null;
    details?: Record<string, string | number | boolean | null>;
}
export interface InfrastructureProjection {
    metrics: InfrastructureMetric[];
    projects: InfrastructureItem[];
    repositories: InfrastructureItem[];
    deployments: InfrastructureItem[];
    capacity: InfrastructureItem[];
    workers: InfrastructureItem[];
    hosts: InfrastructureItem[];
    integrations: InfrastructureItem[];
    resources: InfrastructureItem[];
    seeds: InfrastructureItem[];
    policies: InfrastructureItem[];
    diagnostics: InfrastructureItem[];
}
export interface BuildInfrastructureProjectionInput {
    store: any;
    principal?: any;
    team?: any | null;
    projects?: any[];
    seedState?: any;
}
export interface InfrastructureBundle {
    project: any;
    summary: any | null;
    details: any | null;
    agents: any | null;
    releases: any | null;
    capacityOperations: any | null;
}
export async function buildInfrastructureProjection(input: BuildInfrastructureProjectionInput): Promise<InfrastructureProjection> {
    const store = input.store;
    if (!store)
        return emptyProjection();
    const teamId = compact(input.team?.id);
    const [webHosts, repositoryHosts, capacityProviders, products, teamCapacitySummary, teamAuditEvents] = teamId
        ? await Promise.all([
            call(store, 'listTeamWebHosts', teamId),
            call(store, 'listRepositoryHosts', teamId),
            call(store, 'listTeamCapacityProviders', teamId),
            call(store, 'listTeamProducts', teamId, input.principal),
            call(store, 'getTeamCapacitySummary', teamId),
            call(store, 'listAuditEventsForTarget', 'team', teamId, 50),
        ])
        : [[], [], [], [], null, []];
    const providerDetails = await Promise.all(safeArray(capacityProviders).map(async (provider: any) => ({
        provider,
        hosts: teamId ? await call(store, 'listCapacityProviderHosts', teamId, provider.id) : [],
    })));
    const bundles = await Promise.all(safeArray(input.projects).map((project: any) => loadProjectBundle(input, project)));
    const projects = safeArray(input.projects).map(projectItem);
    const repositories = bundles.flatMap(repositoryItems);
    const deployments = bundles.flatMap(deploymentItems).sort(compareItemDesc);
    const capacity = [
        ...safeArray(capacityProviders).map(providerItem),
        ...providerDetails.flatMap(providerDetailItems),
        ...bundles.flatMap(capacityOperationItems),
    ].sort(compareItemDesc);
    const workers = bundles.flatMap(workerItems).sort(compareItemDesc);
    const hosts = [...safeArray(webHosts), ...safeArray(repositoryHosts)].map(hostItem);
    const integrations = [
        ...hosts,
        ...bundles.flatMap((bundle) => safeArray(bundle.details?.resources).map((resource: any) => projectResourceItem(bundle, resource))),
    ].sort(compareItemDesc);
    const resources = [
        ...safeArray(products).map(productItem),
        ...bundles.flatMap((bundle) => safeArray(bundle.details?.resources).map((resource: any) => projectResourceItem(bundle, resource))),
    ].sort(compareItemDesc);
    const seeds = seedItems(input.seedState);
    const policies = [
        ...bundles.flatMap(policyItems),
        ...capacity.filter((item) => item.id.startsWith('grant-')),
    ].sort(compareItemDesc);
    const diagnostics = [
        ...diagnosticsFromCapacity(teamCapacitySummary, bundles),
        ...diagnosticsFromDeployments(deployments),
        ...diagnosticsFromHosts(hosts),
        ...diagnosticsFromSeeds(input.seedState),
        ...safeArray(teamAuditEvents).slice(0, 8).map(auditDiagnosticItem),
    ].sort(compareItemDesc);
    return {
        metrics: [
            { label: 'Projects', value: projects.length },
            { label: 'Repositories', value: repositories.length },
            { label: 'Deployments', value: deployments.length },
            { label: 'Capacity entries', value: capacity.length, tone: capacity.length ? 'info' : 'muted' },
            { label: 'Worker queue', value: workers.length, tone: workers.some((item) => item.tone === 'danger') ? 'danger' : workers.length ? 'warning' : 'muted' },
            { label: 'Diagnostics', value: diagnostics.length, tone: diagnostics.some((item) => item.tone === 'danger') ? 'danger' : diagnostics.length ? 'warning' : 'success' },
        ],
        projects,
        repositories,
        deployments,
        capacity,
        workers,
        hosts,
        integrations,
        resources,
        seeds,
        policies,
        diagnostics,
    };
}
