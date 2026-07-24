

export const API_ENDPOINT_GUARANTEE_FAMILIES = [
    'health-and-markets',
    'auth-and-sessions',
    'teams-and-members',
    'projects-and-workstreams',
    'governance-and-decisions',
    'platform-operations-and-runners',
    'capacity-and-provider-control-plane',
    'agent-graphs-and-workdays',
    'treedx-and-content-proxy',
    'dx-repository-workspaces',
    'hosting-and-secrets',
    'commerce-marketplace',
    'catalog-templates-and-knowledge-packs',
    'ui-projection-endpoints',
    'internal-webhooks-and-federation',
];

export function endpointGuaranteeFamily(path) {
    if (path === '/healthz/deep' || path.startsWith('/v1/markets') || path === '/v1/me' || path.startsWith('/v1/me/'))
        return 'health-and-markets';
    if (path.startsWith('/v1/auth/') || path.startsWith('/v1/team-invites/'))
        return 'auth-and-sessions';
    if (path.startsWith('/v1/ui/'))
        return 'ui-projection-endpoints';
    if (path.startsWith('/v1/internal/') || path.startsWith('/v1/acceptance/') || path === '/v1/feedback')
        return 'internal-webhooks-and-federation';
    if (path.startsWith('/v1/platform/') || path.startsWith('/v1/jobs/') || path.startsWith('/v1/approval-requests/'))
        return 'platform-operations-and-runners';
    if (path.startsWith('/v1/provider/') || path.startsWith('/v1/capacity/') || path.includes('/capacity-') || path.includes('/capacity/'))
        return 'capacity-and-provider-control-plane';
    if (path.startsWith('/v1/decisions/') || path.startsWith('/v1/decision-execution-inputs/') || path.startsWith('/v1/decision-assignment-graphs/') || path.startsWith('/v1/deliverable-contracts/') || path.startsWith('/v1/deliverable-manifests/') || path.startsWith('/v1/capacity-plans/') || path.startsWith('/v1/workdays') || path.includes('/workday') || path.includes('/agent-mode-runs') || path.includes('/assignments/'))
        return 'agent-graphs-and-workdays';
    if (path.startsWith('/v1/dx/') || path.includes('/repos/') || path.includes('/workspaces/'))
        return 'dx-repository-workspaces';
    if (path.includes('/treedx') || path.includes('/local-content') || path.includes('/content-previews'))
        return 'treedx-and-content-proxy';
    if (path.includes('/hosts') || path.includes('/hosting') || path.includes('/secrets') || path.includes('/environments') || path.includes('/resources') || path.includes('/workflow-operations') || path.includes('/repositories/'))
        return 'hosting-and-secrets';
    if (path.startsWith('/v1/commerce/'))
        return 'commerce-marketplace';
    if (path.startsWith('/v1/catalog') || path.startsWith('/v1/templates') || path.startsWith('/v1/knowledge-packs') || path.startsWith('/v1/seeds/'))
        return 'catalog-templates-and-knowledge-packs';
    if (path.startsWith('/v1/commons/') || path.includes('/governance') || path.includes('/proposals') || path.includes('/decisions') || path.includes('/approvals'))
        return 'governance-and-decisions';
    if (path.startsWith('/v1/teams/') || path === '/v1/teams' || path.startsWith('/v1/users/'))
        return 'teams-and-members';
    if (path.startsWith('/v1/projects') || path.startsWith('/v1/project-deployments'))
        return 'projects-and-workstreams';
    return 'health-and-markets';
}

export function endpointGuaranteeCoverage(familyId) {
    if (familyId === 'agent-graphs-and-workdays' || familyId === 'capacity-and-provider-control-plane' || familyId === 'auth-and-sessions' || familyId === 'commerce-marketplace')
        return 'descriptor-and-workflow';
    return 'descriptor-matrix';
}

export function endpointGuarantee(path) {
    const familyId = endpointGuaranteeFamily(path);
    return {
        familyId,
        verifierRef: `api.endpoints.${familyId}`,
        coverage: endpointGuaranteeCoverage(familyId),
    };
}
