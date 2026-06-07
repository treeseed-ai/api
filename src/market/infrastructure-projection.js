import { anchorPart, compact, compareDatesDesc, describeState, safeArray, toneForState, } from './operational-artifacts.js';
export async function buildInfrastructureProjection(input) {
    const store = input.store;
    if (!store)
        return emptyProjection();
    const teamId = compact(input.team?.id);
    const [webHosts, repositoryHosts, capacityProviders, capacityGrants, products, teamCapacitySummary, teamAuditEvents] = teamId
        ? await Promise.all([
            call(store, 'listTeamWebHosts', teamId),
            call(store, 'listRepositoryHosts', teamId),
            call(store, 'listTeamCapacityProviders', teamId),
            call(store, 'listCapacityGrants', teamId),
            call(store, 'listTeamProducts', teamId, input.principal),
            call(store, 'getTeamCapacitySummary', teamId),
            call(store, 'listAuditEventsForTarget', 'team', teamId, 50),
        ])
        : [[], [], [], [], [], null, []];
    const providerDetails = await Promise.all(safeArray(capacityProviders).map(async (provider) => ({
        provider,
        hosts: teamId ? await call(store, 'listCapacityProviderHosts', teamId, provider.id) : [],
        lanes: teamId ? await call(store, 'listCapacityProviderLanes', teamId, provider.id) : [],
        apiKeys: teamId ? await call(store, 'listCapacityProviderApiKeys', teamId, provider.id) : [],
    })));
    const bundles = await Promise.all(safeArray(input.projects).map((project) => loadProjectBundle(input, project)));
    const projects = safeArray(input.projects).map(projectItem);
    const repositories = bundles.flatMap(repositoryItems);
    const deployments = bundles.flatMap(deploymentItems).sort(compareItemDesc);
    const capacity = [
        ...safeArray(capacityProviders).map(providerItem),
        ...safeArray(capacityGrants).map(grantItem),
        ...providerDetails.flatMap(providerDetailItems),
        ...bundles.flatMap(capacityOperationItems),
    ].sort(compareItemDesc);
    const workers = bundles.flatMap(workerItems).sort(compareItemDesc);
    const hosts = [...safeArray(webHosts), ...safeArray(repositoryHosts)].map(hostItem);
    const integrations = [
        ...hosts,
        ...bundles.flatMap((bundle) => safeArray(bundle.details?.resources).map((resource) => projectResourceItem(bundle, resource))),
    ].sort(compareItemDesc);
    const resources = [
        ...safeArray(products).map(productItem),
        ...bundles.flatMap((bundle) => safeArray(bundle.details?.resources).map((resource) => projectResourceItem(bundle, resource))),
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
async function loadProjectBundle(input, project) {
    const store = input.store;
    const [summary, details, agents, releases, capacityOperations] = await Promise.all([
        call(store, 'getProjectSummary', project.id, input.principal),
        call(store, 'getProjectDetails', project.id),
        call(store, 'getProjectAgentsSummary', project.id, input.principal),
        call(store, 'getProjectReleasesSummary', project.id, input.principal),
        call(store, 'getProjectCapacityOperations', project.id, 'staging'),
    ]);
    return { project, summary, details, agents, releases, capacityOperations };
}
function projectItem(project) {
    return {
        id: `project-${compact(project?.id, compact(project?.slug, 'project'))}`,
        title: compact(project?.name, compact(project?.slug, 'Project')),
        description: compact(project?.description, 'Operational project context.'),
        category: 'infrastructure',
        state: compact(project?.status, 'active'),
        tone: toneForState(project?.status ?? 'active'),
        href: `/app/projects/${encodeURIComponent(anchorPart(project?.id ?? project?.slug))}/settings`,
        meta: compact(project?.slug, 'project'),
        projectId: compact(project?.id, '') || null,
        projectName: compact(project?.name, compact(project?.slug, 'Project')),
    };
}
function repositoryItems(bundle) {
    const summaryRepos = safeArray(bundle.summary?.repositories);
    const detailRepos = safeArray(bundle.details?.repositories);
    return dedupeBy([...summaryRepos, ...detailRepos], (repository) => compact(repository?.id, repositoryLabel(repository)))
        .map((repository) => ({
        id: `repository-${anchorPart(repository?.id ?? repositoryLabel(repository))}`,
        title: repositoryLabel(repository) || 'Repository',
        description: `${projectName(bundle)} - ${describeState(repository?.status ?? repository?.state, 'connected')}`,
        category: 'infrastructure',
        state: compact(repository?.status, compact(repository?.state, 'connected')),
        tone: toneForState(repository?.status ?? repository?.state ?? 'active'),
        href: '/app/hosts',
        meta: compact(repository?.role, compact(repository?.provider, 'repository')),
        projectId: compact(bundle.project?.id, '') || null,
        projectName: projectName(bundle),
    }));
}
function deploymentItems(bundle) {
    const deployments = [
        ...safeArray(bundle.releases?.history),
        ...safeArray(bundle.details?.deployments),
        bundle.summary?.latestProdDeployment,
        bundle.summary?.latestStagingDeployment,
    ].filter(Boolean);
    return dedupeBy(deployments, (deployment) => compact(deployment?.id, `${deployment?.environment ?? 'deployment'}-${deployment?.releaseTag ?? deployment?.sourceRef ?? ''}`))
        .map((deployment) => ({
        id: `deployment-${anchorPart(bundle.project?.id)}-${anchorPart(deployment?.id ?? deployment?.releaseTag ?? deployment?.environment)}`,
        title: `${projectName(bundle)} ${compact(deployment?.environment, 'deployment')}`,
        description: compact(deployment?.releaseTag, compact(deployment?.sourceRef, describeState(deployment?.status, 'deployment recorded'))),
        category: 'infrastructure',
        state: compact(deployment?.status, 'recorded'),
        tone: toneForState(deployment?.status),
        timestamp: latestDate(deployment?.finishedAt, deployment?.completedAt, deployment?.startedAt, deployment?.createdAt),
        href: bundle.project?.id ? `/app/projects/${encodeURIComponent(bundle.project.id)}/hosts` : '/app/projects',
        meta: compact(deployment?.deploymentKind, compact(deployment?.environment, 'deployment')),
        projectId: compact(bundle.project?.id, '') || null,
        projectName: projectName(bundle),
    }));
}
function providerItem(provider) {
    return {
        id: `provider-${anchorPart(provider?.id ?? provider?.name)}`,
        title: compact(provider?.name, compact(provider?.provider, 'Capacity provider')),
        description: `${describeState(provider?.status, 'configured')} - ${describeState(provider?.billingScope, 'team')}`,
        category: 'infrastructure',
        state: compact(provider?.status, 'configured'),
        tone: toneForState(provider?.status ?? 'active'),
        href: provider?.id ? `/app/capacity/providers/${encodeURIComponent(provider.id)}/edit` : '/app/capacity/providers',
        meta: compact(provider?.provider, compact(provider?.kind, 'capacity')),
        details: {
            billingScope: compact(provider?.billingScope, 'team'),
            defaultEnvironment: compact(provider?.defaultEnvironment, ''),
        },
    };
}
function grantItem(grant) {
    return {
        id: `grant-${anchorPart(grant?.id ?? grant?.projectId ?? grant?.grantScope)}`,
        title: `Grant ${compact(grant?.environment, compact(grant?.grantScope, 'team'))}`,
        description: describeState(grant?.state, 'active'),
        category: 'governance',
        state: compact(grant?.state, 'active'),
        tone: toneForState(grant?.state ?? 'active'),
        href: '/app/capacity/providers',
        meta: grant?.projectId ? 'project grant' : 'team grant',
        projectId: compact(grant?.projectId, '') || null,
    };
}
function providerDetailItems(detail) {
    const providerId = compact(detail.provider?.id, compact(detail.provider?.name, 'provider'));
    return [
        ...safeArray(detail.hosts).map((host) => ({
            id: `provider-host-${anchorPart(providerId)}-${anchorPart(host?.id ?? host?.hostId ?? host?.role)}`,
            title: `${compact(detail.provider?.name, 'Capacity')} host binding`,
            description: describeState(host?.state ?? host?.status, 'configured'),
            category: 'infrastructure',
            state: compact(host?.state, compact(host?.status, 'configured')),
            tone: toneForState(host?.state ?? host?.status ?? 'active'),
            href: `/app#host-${anchorPart(host?.hostId ?? host?.id)}`,
            meta: compact(host?.role, 'host'),
        })),
        ...safeArray(detail.lanes).map((lane) => ({
            id: `provider-lane-${anchorPart(providerId)}-${anchorPart(lane?.id ?? lane?.name)}`,
            title: compact(lane?.name, 'Capacity lane'),
            description: describeState(lane?.state ?? lane?.status, 'available'),
            category: 'infrastructure',
            state: compact(lane?.state, compact(lane?.status, 'available')),
            tone: toneForState(lane?.state ?? lane?.status ?? 'active'),
            href: `/app/capacity/providers/${encodeURIComponent(anchorPart(providerId))}/edit`,
            meta: 'capacity lane',
        })),
        {
            id: `provider-keys-${anchorPart(providerId)}`,
            title: `${compact(detail.provider?.name, 'Capacity provider')} API keys`,
            description: `${safeArray(detail.apiKeys).length} configured key${safeArray(detail.apiKeys).length === 1 ? '' : 's'}`,
            category: 'infrastructure',
            state: safeArray(detail.apiKeys).length ? 'configured' : 'missing',
            tone: safeArray(detail.apiKeys).length ? 'success' : 'warning',
            href: `/app/capacity/providers/${encodeURIComponent(anchorPart(providerId))}/edit`,
            meta: 'credentials',
        },
    ];
}
function capacityOperationItems(bundle) {
    const operations = bundle.capacityOperations;
    if (!operations)
        return [];
    const summary = operations.summary;
    return [
        summary ? {
            id: `capacity-summary-${anchorPart(bundle.project?.id)}`,
            title: `${projectName(bundle)} capacity readiness`,
            description: safeArray(summary.reasons).join(', ') || describeState(summary.readiness, 'ready'),
            category: 'infrastructure',
            state: compact(summary.readiness, 'ready'),
            tone: toneForState(summary.readiness),
            href: bundle.project?.id ? `/app/projects/${encodeURIComponent(bundle.project.id)}/settings` : '/app/projects',
            meta: 'readiness',
            projectId: compact(bundle.project?.id, '') || null,
            projectName: projectName(bundle),
        } : null,
        ...safeArray(operations.blockedRoutingDecisions).map((decision) => routingDecisionItem(bundle, decision)),
        ...safeArray(operations.interruptionReservations).map((reservation) => ({
            id: `capacity-reservation-${anchorPart(reservation?.id ?? reservation?.taskId)}`,
            title: `${projectName(bundle)} continuation required`,
            description: describeState(reservation?.state, 'reserved capacity'),
            category: 'execution',
            state: compact(reservation?.state, 'reserved'),
            tone: toneForState(reservation?.state ?? 'warning'),
            href: bundle.project?.id ? `/app/projects/${encodeURIComponent(bundle.project.id)}/settings` : '/app/projects',
            meta: 'reservation',
            projectId: compact(bundle.project?.id, '') || null,
            projectName: projectName(bundle),
        })),
    ].filter(Boolean);
}
function routingDecisionItem(bundle, decision) {
    return {
        id: `routing-${anchorPart(decision?.id ?? decision?.taskId ?? decision?.workDayId)}`,
        title: `${projectName(bundle)} routing decision`,
        description: compact(decision?.reason, describeState(decision?.decision, 'routing recorded')),
        category: 'execution',
        state: compact(decision?.decision, 'recorded'),
        tone: toneForState(decision?.decision === 'selected' ? 'active' : decision?.decision),
        href: '/app/work/objectives',
        meta: compact(decision?.environment, 'routing'),
        timestamp: latestDate(decision?.createdAt, decision?.updatedAt),
        projectId: compact(bundle.project?.id, '') || null,
        projectName: projectName(bundle),
    };
}
function workerItems(bundle) {
    const runners = safeArray(bundle.agents?.workerRunners).map((runner) => ({
        id: `worker-${anchorPart(runner?.id ?? runner?.runnerId ?? runner?.runnerServiceName)}`,
        title: compact(runner?.runnerServiceName, compact(runner?.runnerId, 'Worker runner')),
        description: `${projectName(bundle)} - ${describeState(runner?.state, 'unknown')}`,
        category: 'execution',
        state: compact(runner?.state, 'unknown'),
        tone: toneForState(runner?.state),
        href: '/app/capacity/providers',
        meta: `${Number(runner?.activeLocalWorkers ?? 0)} / ${Number(runner?.maxLocalWorkers ?? 0)} workers`,
        projectId: compact(bundle.project?.id, '') || null,
        projectName: projectName(bundle),
    }));
    const tasks = safeArray(bundle.agents?.taskHealth?.activeTasks).map((task) => ({
        id: `queue-${anchorPart(task?.id ?? task?.workDayId ?? task?.type)}`,
        title: `${projectName(bundle)} ${describeState(task?.type, 'task')}`,
        description: describeState(task?.state, 'queued'),
        category: 'execution',
        state: compact(task?.state, 'queued'),
        tone: toneForState(task?.state),
        href: task?.workDayId ? `/app/projects/${encodeURIComponent(task.workDayId)}` : '/app/projects',
        meta: describeState(task?.priority, 'task'),
        timestamp: latestDate(task?.updatedAt, task?.createdAt),
        projectId: compact(bundle.project?.id, '') || null,
        projectName: projectName(bundle),
    }));
    return [...runners, ...tasks];
}
function hostItem(host) {
    const id = compact(host?.id, compact(host?.name, compact(host?.provider, 'host')));
    return {
        id: `host-${anchorPart(id)}`,
        title: compact(host?.name, compact(host?.accountLabel, compact(host?.provider, 'Host'))),
        description: describeState(host?.status ?? host?.ownership, 'configured'),
        category: 'infrastructure',
        state: compact(host?.status, compact(host?.ownership, 'configured')),
        tone: toneForState(host?.status ?? 'active'),
        href: `/app#host-${anchorPart(id)}`,
        meta: compact(host?.provider, compact(host?.ownership, 'host')),
    };
}
function projectResourceItem(bundle, resource) {
    const id = compact(resource?.id, compact(resource?.logicalName, compact(resource?.name, 'resource')));
    return {
        id: `resource-${anchorPart(id)}`,
        title: compact(resource?.logicalName, compact(resource?.name, compact(resource?.resourceKind, 'Infrastructure resource'))),
        description: `${projectName(bundle)} - ${describeState(resource?.status, 'configured')}`,
        category: 'infrastructure',
        state: compact(resource?.status, 'configured'),
        tone: toneForState(resource?.status ?? 'active'),
        href: `/app/knowledge/artifacts#resource-${anchorPart(id)}`,
        meta: compact(resource?.provider, compact(resource?.resourceKind, 'resource')),
        projectId: compact(bundle.project?.id, '') || null,
        projectName: projectName(bundle),
    };
}
function productItem(product) {
    const id = compact(product?.id, compact(product?.slug, compact(product?.title, 'resource')));
    return {
        id: `resource-${anchorPart(id)}`,
        title: compact(product?.title, compact(product?.name, compact(product?.slug, 'Operational resource'))),
        description: compact(product?.summary, describeState(product?.kind, 'Reusable operational asset')),
        category: 'knowledge',
        state: compact(product?.visibility, compact(product?.status, 'available')),
        tone: toneForState(product?.visibility === 'public' ? 'active' : product?.status),
        href: `/app/knowledge/artifacts#resource-${anchorPart(id)}`,
        meta: compact(product?.kind, 'resource'),
    };
}
function policyItems(bundle) {
    return [
        ...safeArray(bundle.summary?.capabilityGrants).map((grant) => ({
            id: `policy-${anchorPart(grant?.id ?? grant?.operation)}`,
            title: compact(grant?.label, `${compact(grant?.namespace, 'operation')}.${compact(grant?.operation, 'policy')}`),
            description: compact(grant?.approvalPolicy?.reason, describeState(grant?.defaultDispatchMode, 'operational policy')),
            category: 'governance',
            state: grant?.enabled === false ? 'paused' : 'active',
            tone: grant?.enabled === false ? 'warning' : 'success',
            href: `/app/work/decisions#policy-${anchorPart(grant?.id ?? grant?.operation)}`,
            meta: projectName(bundle),
            projectId: compact(bundle.project?.id, '') || null,
            projectName: projectName(bundle),
        })),
        ...(bundle.capacityOperations?.summary?.workPolicy ? [{
                id: `policy-work-${anchorPart(bundle.project?.id)}`,
                title: `${projectName(bundle)} work policy`,
                description: describeState(bundle.capacityOperations.summary.workPolicy.enabled === false ? 'paused' : 'active', 'work policy'),
                category: 'governance',
                state: bundle.capacityOperations.summary.workPolicy.enabled === false ? 'paused' : 'active',
                tone: bundle.capacityOperations.summary.workPolicy.enabled === false ? 'warning' : 'success',
                href: `/app/work/decisions#policy-work-${anchorPart(bundle.project?.id)}`,
                meta: compact(bundle.capacityOperations.summary.workPolicy.environment, 'staging'),
                projectId: compact(bundle.project?.id, '') || null,
                projectName: projectName(bundle),
            }] : []),
    ];
}
function seedItems(seedState) {
    if (!seedState)
        return [];
    return [
        {
            id: 'seed-plan',
            title: `Seed ${compact(seedState.selectedSeed, 'treeseed')}`,
            description: seedState.error ?? seedSummary(seedState.plan),
            category: 'infrastructure',
            state: seedState.error ? 'blocked' : safeArray(seedState.diagnostics).some((diagnostic) => diagnostic.severity === 'error') ? 'needs_review' : 'planned',
            tone: seedState.error ? 'danger' : safeArray(seedState.diagnostics).length ? 'warning' : 'success',
            href: '/app#seed-plan',
            meta: compact(seedState.selectedEnvironments, 'environment'),
        },
        ...safeArray(seedState.runs).map((run) => ({
            id: `seed-run-${anchorPart(run?.id ?? run?.manifestHash)}`,
            title: `Seed run ${compact(run?.id, compact(run?.manifestHash, 'record'))}`,
            description: describeState(run?.status ?? run?.state, 'recorded'),
            category: 'infrastructure',
            state: compact(run?.status, compact(run?.state, 'recorded')),
            tone: toneForState(run?.status ?? run?.state),
            timestamp: latestDate(run?.updatedAt, run?.createdAt),
            href: `/app#seed-run-${anchorPart(run?.id ?? run?.manifestHash)}`,
            meta: 'seed run',
        })),
        ...safeArray(seedState.approvals).map((approval) => ({
            id: `seed-approval-${anchorPart(approval?.id)}`,
            title: compact(approval?.title, 'Seed approval'),
            description: compact(approval?.summary, 'Approval required for seed operation.'),
            category: 'governance',
            state: compact(approval?.state, 'pending'),
            tone: toneForState(approval?.state ?? approval?.severity),
            timestamp: latestDate(approval?.createdAt, approval?.updatedAt),
            href: approval?.id ? `/app/work/decisions/${encodeURIComponent(approval.id)}` : '/app/work/decisions',
            meta: describeState(approval?.severity, 'review'),
        })),
    ];
}
function diagnosticsFromCapacity(teamCapacitySummary, bundles) {
    const teamDiagnostic = teamCapacitySummary && !['ready', 'active'].includes(compact(teamCapacitySummary.readiness, '').toLowerCase())
        ? [{
                id: 'diagnostic-team-capacity',
                title: 'Team capacity requires attention',
                description: safeArray(teamCapacitySummary.reasons).join(', ') || describeState(teamCapacitySummary.readiness, 'capacity state'),
                category: 'infrastructure',
                state: compact(teamCapacitySummary.readiness, 'review'),
                tone: toneForState(teamCapacitySummary.readiness),
                href: '/app/projects',
                meta: 'capacity',
            }]
        : [];
    const projectDiagnostics = bundles.flatMap((bundle) => safeArray(bundle.capacityOperations?.blockedRoutingDecisions).map((decision) => ({
        ...routingDecisionItem(bundle, decision),
        id: `diagnostic-${anchorPart(decision?.id ?? decision?.taskId)}`,
        title: `${projectName(bundle)} routing blocked`,
    })));
    return [...teamDiagnostic, ...projectDiagnostics];
}
function diagnosticsFromDeployments(deployments) {
    return deployments.filter((deployment) => ['failed', 'blocked'].includes(compact(deployment.state, '').toLowerCase()))
        .map((deployment) => ({
        ...deployment,
        id: `diagnostic-${deployment.id}`,
        title: `${deployment.title} needs attention`,
        href: '/app/projects',
    }));
}
function diagnosticsFromHosts(hosts) {
    return hosts.filter((host) => ['failed', 'inactive', 'missing', 'blocked'].includes(compact(host.state, '').toLowerCase()))
        .map((host) => ({
        ...host,
        id: `diagnostic-${host.id}`,
        title: `${host.title} host issue`,
        href: '/app',
    }));
}
function diagnosticsFromSeeds(seedState) {
    return safeArray(seedState?.diagnostics).map((diagnostic, index) => ({
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
function auditDiagnosticItem(event) {
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
function emptyProjection() {
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
async function call(store, method, ...args) {
    return typeof store?.[method] === 'function' ? store[method](...args).catch(() => null) : null;
}
function latestDate(...values) {
    return values.map((value) => compact(value, '')).find(Boolean) ?? null;
}
function compareItemDesc(left, right) {
    return compareDatesDesc(left.timestamp, right.timestamp);
}
function repositoryLabel(repository) {
    if (typeof repository === 'string')
        return repository;
    return [repository?.owner, repository?.name ?? repository?.repo ?? repository?.role].filter(Boolean).join('/');
}
function projectName(bundle) {
    return compact(bundle.project?.name, compact(bundle.project?.slug, 'Project'));
}
function seedSummary(plan) {
    const summary = plan?.summary;
    if (!summary)
        return 'Seed plan available for operator review.';
    const creates = Number(summary.create ?? summary.created ?? 0);
    const updates = Number(summary.update ?? summary.updated ?? 0);
    const skips = Number(summary.skip ?? summary.skipped ?? 0);
    return `${creates} create, ${updates} update, ${skips} skip actions planned.`;
}
function titleFromEvent(value) {
    return compact(value, 'Audit event')
        .replace(/([a-z])([A-Z])/gu, '$1 $2')
        .replace(/[_-]+/gu, ' ')
        .replace(/\b\w/gu, (match) => match.toUpperCase());
}
function dedupeBy(items, key) {
    const seen = new Set();
    const result = [];
    for (const item of items) {
        const id = key(item);
        if (!id || seen.has(id))
            continue;
        seen.add(id);
        result.push(item);
    }
    return result;
}
