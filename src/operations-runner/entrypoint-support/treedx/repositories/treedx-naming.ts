import { randomBytes } from 'node:crypto';
import { deployRailwayServiceInstance, ensureRailwayEnvironment, ensureRailwayGeneratedServiceDomain, ensureRailwayProject, ensureRailwayService, ensureRailwayServiceInstanceConfiguration, ensureRailwayServiceVolume, listRailwayVariables, normalizeRailwayEnvironmentName, upsertRailwayVariables } from '@treeseed/sdk';
import { env } from '../../index.js';

export function treeDxSlug(value, fallback = 'treedx') {
    const slug = String(value ?? '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/gu, '')
        .replace(/[^a-z0-9-]+/giu, '-')
        .toLowerCase()
        .replace(/-+/gu, '-')
        .replace(/^-|-$/gu, '')
        .slice(0, 56);
    return slug || fallback;
}

export function treeDxRailwayEnvironment(value) {
    return normalizeRailwayEnvironmentName(value || process.env.TREESEED_PLATFORM_RUNNER_ENVIRONMENT || 'staging') || 'staging';
}

export function treeDxEnvironmentNeutralProjectName(value, fallback) {
    const projectName = String(value || fallback || '').trim();
    if (!projectName)
        return fallback;
    return projectName
        .replace(/^(treeseed-team-[a-z0-9-]+-treedx)-(?:staging|prod|production)$/iu, '$1');
}

export function treeDxRailwayNames({ team, teamId, publicRead, environment }) {
    const envName = treeDxRailwayEnvironment(environment);
    if (publicRead) {
        return {
            projectName: treeDxEnvironmentNeutralProjectName(process.env.TREESEED_PUBLIC_TREEDX_RAILWAY_PROJECT_NAME, 'treeseed-api'),
            serviceName: process.env.TREESEED_PUBLIC_TREEDX_RAILWAY_SERVICE_NAME || 'public-treedx-node-01',
            volumeName: process.env.TREESEED_PUBLIC_TREEDX_RAILWAY_VOLUME_NAME || 'public-treedx-node-01-volume',
            environmentName: envName,
            scope: 'public_federation',
        };
    }
    const teamSlug = treeDxSlug(team?.slug ?? team?.name ?? teamId, 'team');
    return {
        projectName: treeDxEnvironmentNeutralProjectName(null, `treeseed-team-${teamSlug}-treedx`),
        serviceName: 'treedx',
        volumeName: 'treedx-data',
        environmentName: envName,
        scope: 'private_team',
    };
}

export function treeDxSecretBase() {
    return randomBytes(48).toString('base64url');
}

export function treeDxRailway(options: any = {}) {
    return {
        ensureProject: options.ensureProject ?? ensureRailwayProject,
        ensureEnvironment: options.ensureEnvironment ?? ensureRailwayEnvironment,
        ensureService: options.ensureService ?? ensureRailwayService,
        ensureServiceInstanceConfiguration: options.ensureServiceInstanceConfiguration ?? ensureRailwayServiceInstanceConfiguration,
        ensureServiceVolume: options.ensureServiceVolume ?? ensureRailwayServiceVolume,
        ensureGeneratedServiceDomain: options.ensureGeneratedServiceDomain ?? ensureRailwayGeneratedServiceDomain,
        listVariables: options.listVariables ?? listRailwayVariables,
        upsertVariables: options.upsertVariables ?? upsertRailwayVariables,
        deployServiceInstance: options.deployServiceInstance ?? deployRailwayServiceInstance,
    };
}
