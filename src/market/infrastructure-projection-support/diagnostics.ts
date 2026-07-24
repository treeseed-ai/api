import { anchorPart, compact, describeState, safeArray, toneForState } from '../operations/operational-artifacts.js';
import { type InfrastructureBundle, type InfrastructureItem, type InfrastructureProjection } from '../projects/hosting/infrastructure-projection.js';
import { latestDate, titleFromEvent } from './index.js';

export function diagnosticsFromCapacity(teamCapacitySummary: any, bundles: InfrastructureBundle[]): InfrastructureItem[] {
    const teamDiagnostic = teamCapacitySummary && !['ready', 'active'].includes(compact(teamCapacitySummary.readiness, '').toLowerCase())
        ? [{
                id: 'diagnostic-team-capacity',
                title: 'Team capacity requires attention',
                description: safeArray(teamCapacitySummary.reasons).join(', ') || describeState(teamCapacitySummary.readiness, 'capacity state'),
                category: 'infrastructure' as const,
                state: compact(teamCapacitySummary.readiness, 'review'),
                tone: toneForState(teamCapacitySummary.readiness),
                href: '/app/projects',
                meta: 'capacity',
            }]
        : [];
    return teamDiagnostic;
}

export function diagnosticsFromDeployments(deployments: InfrastructureItem[]): InfrastructureItem[] {
    return deployments.filter((deployment) => ['failed', 'blocked'].includes(compact(deployment.state, '').toLowerCase()))
        .map((deployment) => ({
        ...deployment,
        id: `diagnostic-${deployment.id}`,
        title: `${deployment.title} needs attention`,
        href: '/app/projects',
    }));
}

export function diagnosticsFromHosts(hosts: InfrastructureItem[]): InfrastructureItem[] {
    return hosts.filter((host) => ['failed', 'inactive', 'missing', 'blocked'].includes(compact(host.state, '').toLowerCase()))
        .map((host) => ({
        ...host,
        id: `diagnostic-${host.id}`,
        title: `${host.title} host issue`,
        href: '/app',
    }));
}

export function diagnosticsFromSeeds(seedState: any): InfrastructureItem[] {
    return safeArray(seedState?.diagnostics).map((diagnostic: any, index) => ({
        id: `diagnostic-seed-${index}`,
        title: compact(diagnostic?.code, 'Seed diagnostic'),
        description: compact(diagnostic?.message, describeState(diagnostic?.severity, 'diagnostic')),
        category: 'infrastructure',
        state: compact(diagnostic?.severity, 'info'),
        tone: diagnostic?.severity === 'error' ? 'danger' : diagnostic?.severity === 'warning' ? 'warning' : 'info',
        href: '/app',
        meta: compact(diagnostic?.path, 'seed'),
    }));
}

export function auditDiagnosticItem(event: any): InfrastructureItem {
    const id = compact(event?.id, compact(event?.eventType, 'audit'));
    return {
        id: `audit-${anchorPart(id)}`,
        title: titleFromEvent(event?.eventType),
        description: compact(event?.data?.summary, describeState(event?.targetType, 'audit event')),
        category: 'governance',
        state: compact(event?.eventType, 'recorded'),
        tone: 'info',
        timestamp: latestDate(event?.createdAt),
        href: '/app/work/decisions',
        meta: 'audit',
    };
}

export function emptyProjection(): InfrastructureProjection {
    return {
        metrics: [],
        projects: [],
        repositories: [],
        deployments: [],
        capacity: [],
        workers: [],
        hosts: [],
        integrations: [],
        resources: [],
        seeds: [],
        policies: [],
        diagnostics: [],
    };
}
