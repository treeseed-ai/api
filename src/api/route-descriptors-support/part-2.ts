import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { here, findPackageRoot, packageRoot, sourcePathFor, appSourcePath, projectDeploymentRoutesSourcePath, capacityRouteSourcePaths, SDK_METHOD_ROUTE_MAP, ACCEPTANCE_ACTORS, TEAM_MEMBER_ACTORS, TEAM_MANAGER_ACTORS, PROJECT_MEMBER_ACTORS, PROJECT_MANAGER_ACTORS, PLATFORM_ADMIN_ACTORS, routeId, isTreeDxCredentialBridgePath, ownerDomain, bodyFactoryFor, acceptancePolicy, extractActiveApiRoutes, API_ROUTE_DESCRIPTORS, descriptorById, descriptorsForSdkMethods } from './index.js';

export function authClass(path, method = 'get') {
    if (path === '/v1/internal/github/app/webhook')
        return 'github-webhook';
    if (isTreeDxCredentialBridgePath(path))
        return 'service';
    if (path.startsWith('/v1/provider-registrations') || path === '/v1/provider/access-tokens')
        return 'provider-proof';
    if (path.startsWith('/v1/provider/'))
        return 'provider-access-token';
    if (path.startsWith('/v1/platform/runners/'))
        return 'platform-runner';
    if (path.startsWith('/v1/acceptance/'))
        return 'acceptance-service';
    if (path === '/v1/feedback')
        return 'public';
    if (path === '/v1/markets/current' || path.startsWith('/v1/auth/web/sign-') || path.startsWith('/v1/auth/availability/') || path === '/v1/auth/providers' || path.startsWith('/v1/auth/oauth/') || path.includes('/password-reset/') || path.includes('/auth/device/')) {
        return 'public';
    }
    if (path.startsWith('/v1/platform/operations'))
        return 'platform-admin';
    if (path === '/v1/commons/summary')
        return 'public';
    if (path.startsWith('/v1/commons/questions') && method === 'get')
        return 'public';
    if (path.startsWith('/v1/commons/proposals') && method === 'get')
        return 'public';
    if (path.startsWith('/v1/commons/decisions') && method === 'get')
        return 'public';
    if (path.startsWith('/v1/commons/events') && method === 'get')
        return 'public';
    if (path.startsWith('/v1/commons/participants') && !path.endsWith('/me'))
        return 'team-member';
    if (path.startsWith('/v1/commons/proposals/') && (path.endsWith('/review') || path.endsWith('/start-voting') || path.endsWith('/evaluate') || path.endsWith('/steward-decision') || path.endsWith('/archive')))
        return 'team-member';
    if (path.startsWith('/v1/commons/questions/') && path.endsWith('/answer'))
        return 'team-member';
    if (path.startsWith('/v1/commons/'))
        return 'user';
    if (path.startsWith('/v1/commerce/products') && path.includes(':productId') && method === 'get')
        return 'public';
    if (path === '/v1/commerce/products' && method === 'get')
        return 'public';
    if (path === '/v1/commerce/webhooks/stripe')
        return 'service-webhook';
    if (path.startsWith('/v1/commerce/marketplace'))
        return 'public';
    if (path.startsWith('/v1/commerce/capacity-listings/') && (path.endsWith('/approve') || path.endsWith('/reject') || path.endsWith('/suspend')))
        return 'platform-admin';
    if (path.startsWith('/v1/commerce/capacity-listings') && method === 'get')
        return 'public';
    if (path.startsWith('/v1/commerce/capacity-listings/'))
        return 'team-member';
    if (path.startsWith('/v1/commerce/capacity-listing-inquiries'))
        return 'team-member';
    if (path.startsWith('/v1/commerce/'))
        return path.includes('/approve') ? 'platform-admin' : 'team-member';
    if (path.startsWith('/v1/ui/'))
        return 'user';
    if (path.startsWith('/v1/teams/:teamId'))
        return 'team-member';
    if (path.startsWith('/v1/projects/:projectId'))
        return 'project-member';
    return 'user';
}

export function mutability(method) {
    if (method === 'get')
        return 'read';
    if (method === 'delete')
        return 'destructive';
    return 'write';
}

export function fixtureRequirements(path) {
    const required = [];
    for (const match of path.matchAll(/:([A-Za-z0-9_]+)/gu)) {
        required.push(match[1]);
    }
    return required;
}

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

export function safeProduction(path, method) {
    if (method === 'get')
        return true;
    if (path.startsWith('/v1/auth/web/appearance') || path.startsWith('/v1/auth/web/sessions'))
        return true;
    if (path.startsWith('/v1/acceptance/'))
        return true;
    return false;
}

export function routeNeedsManagement(path, method) {
    if (path.includes('/capacity-registration-key'))
        return true;
    if (path.endsWith('/explain'))
        return false;
    if (method === 'get')
        return false;
    if (path.includes('/capacity-provider-requests') || path.includes('/capacity-provider-memberships') || path.includes('/workday-runs'))
        return true;
    return /\/members\/|\/invites|\/api-keys|\/repository-hosts|\/web-hosts|\/hosts|\/capacity\/|\/capacity-grants|\/provider-credential-sessions|\/projects\/launch|\/treedx/u.test(path);
}

export function successActorsFor(path, method) {
    if (path === '/v1/internal/github/app/webhook')
        return [];
    if (isTreeDxCredentialBridgePath(path))
        return [];
    if (path.startsWith('/v1/provider/'))
        return ['providerAccessToken'];
    if (path.startsWith('/v1/platform/runners/'))
        return ['platformRunner'];
    if (path.startsWith('/v1/acceptance/'))
        return [];
    if (path.startsWith('/v1/platform/operations/:operationId'))
        return ['siteAdmin', 'marketSteward', 'teamOwner', 'teamOperator', 'teamViewer', 'nonMember', 'providerOperator'];
    if (path === '/v1/platform/operations' && method !== 'get')
        return ['siteAdmin', 'marketSteward', 'teamOwner', 'teamOperator', 'teamViewer', 'nonMember', 'providerOperator'];
    if (path.startsWith('/v1/platform/operations'))
        return PLATFORM_ADMIN_ACTORS;
    if (path === '/v1/feedback')
        return ACCEPTANCE_ACTORS;
    if (path === '/v1/markets/current' || path.includes('/username/check') || path.includes('/confirm-email') || path.includes('/password-reset/request') || path.includes('/password-reset/complete') || path.includes('/auth/device/')) {
        return ACCEPTANCE_ACTORS;
    }
    if (path.startsWith('/v1/auth/web/sign-up'))
        return ACCEPTANCE_ACTORS;
    if (path.startsWith('/v1/auth/web/sign-') || path.startsWith('/v1/auth/oauth/'))
        return ['anonymous'];
    if (path.startsWith('/v1/auth/'))
        return ['siteAdmin', 'marketSteward', 'teamOwner', 'teamOperator', 'teamViewer', 'nonMember', 'providerOperator'];
    if (path.startsWith('/v1/teams/:teamId'))
        return routeNeedsManagement(path, method) ? TEAM_MANAGER_ACTORS : TEAM_MEMBER_ACTORS;
    if (path.startsWith('/v1/decisions/') || path.startsWith('/v1/decision-execution-inputs/') || path.startsWith('/v1/capacity-plans/'))
        return method === 'get' ? PROJECT_MEMBER_ACTORS : PROJECT_MANAGER_ACTORS;
    if (path.startsWith('/v1/research-workflows/'))
        return method === 'get' ? PROJECT_MEMBER_ACTORS : PROJECT_MANAGER_ACTORS;
    if (path.startsWith('/v1/workdays'))
        return method === 'get' ? PROJECT_MEMBER_ACTORS : PROJECT_MANAGER_ACTORS;
    if (path.startsWith('/v1/projects/:projectId'))
        return method === 'get' ? PROJECT_MEMBER_ACTORS : PROJECT_MANAGER_ACTORS;
    if (path.startsWith('/v1/teams'))
        return method === 'get'
            ? ['siteAdmin', 'marketSteward', 'teamOwner', 'teamOperator', 'teamViewer', 'nonMember', 'providerOperator']
            : ['siteAdmin', 'marketSteward', 'teamOwner', 'teamOperator', 'teamViewer', 'nonMember', 'providerOperator'];
    if (path.startsWith('/v1/capacity/'))
        return method === 'get' ? TEAM_MEMBER_ACTORS : TEAM_MANAGER_ACTORS;
    if (path === '/v1/commons/summary')
        return ACCEPTANCE_ACTORS;
    if (path.startsWith('/v1/commons/questions') && method === 'get')
        return ACCEPTANCE_ACTORS;
    if (path.startsWith('/v1/commons/proposals') && method === 'get')
        return ACCEPTANCE_ACTORS;
    if (path.startsWith('/v1/commons/decisions') && method === 'get')
        return ACCEPTANCE_ACTORS;
    if (path.startsWith('/v1/commons/events') && method === 'get')
        return ACCEPTANCE_ACTORS;
    if (path.startsWith('/v1/commons/participants') && !path.endsWith('/me'))
        return TEAM_MANAGER_ACTORS;
    if (path.startsWith('/v1/commons/proposals/') && (path.endsWith('/review') || path.endsWith('/start-voting') || path.endsWith('/evaluate') || path.endsWith('/steward-decision') || path.endsWith('/archive')))
        return TEAM_MANAGER_ACTORS;
    if (path.startsWith('/v1/commons/questions/') && path.endsWith('/answer'))
        return TEAM_MANAGER_ACTORS;
    if (path.startsWith('/v1/commons/'))
        return ['siteAdmin', 'marketSteward', 'teamOwner', 'teamOperator', 'teamViewer', 'nonMember', 'providerOperator'];
    if (path.startsWith('/v1/commerce/vendors/') && path.endsWith('/approve'))
        return PLATFORM_ADMIN_ACTORS;
    if (path.startsWith('/v1/commerce/products/') && path.endsWith('/approve'))
        return PLATFORM_ADMIN_ACTORS;
    if (path.startsWith('/v1/commerce/products/') && path.includes('/versions/') && path.endsWith('/approve'))
        return PLATFORM_ADMIN_ACTORS;
    if (path.startsWith('/v1/commerce/offers/') && path.endsWith('/approve'))
        return PLATFORM_ADMIN_ACTORS;
    if (path.startsWith('/v1/commerce/offers/') && path.endsWith('/stripe/status'))
        return TEAM_MEMBER_ACTORS;
    if (path.startsWith('/v1/commerce/offers/') && path.endsWith('/stripe/reconcile'))
        return TEAM_MANAGER_ACTORS;
    if (path.startsWith('/v1/commerce/prices/') && path.endsWith('/stripe/reconcile'))
        return TEAM_MANAGER_ACTORS;
    if (path === '/v1/commerce/webhooks/stripe')
        return [];
    if (path.startsWith('/v1/commerce/vendors/') && path.includes('/sales/'))
        return method === 'get' ? TEAM_MEMBER_ACTORS : TEAM_MANAGER_ACTORS;
    if (path.startsWith('/v1/commerce/vendors/') && path.endsWith('/monitoring'))
        return TEAM_MEMBER_ACTORS;
    if (path.startsWith('/v1/commerce/marketplace'))
        return ACCEPTANCE_ACTORS;
    if (path.startsWith('/v1/commerce/orders/') && path.endsWith('/refunds'))
        return method === 'get' ? TEAM_MEMBER_ACTORS : TEAM_MANAGER_ACTORS;
    if (path.startsWith('/v1/commerce/order-items/') && path.endsWith('/fulfillment/artifact'))
        return TEAM_MANAGER_ACTORS;
    if (path.startsWith('/v1/commerce/entitlements/') && path.endsWith('/revoke'))
        return TEAM_MANAGER_ACTORS;
    if (path.startsWith('/v1/commerce/cart') || path.startsWith('/v1/commerce/checkout') || path.startsWith('/v1/commerce/payment-groups'))
        return TEAM_MEMBER_ACTORS;
    if (path.startsWith('/v1/commerce/orders') || path.startsWith('/v1/commerce/entitlements'))
        return TEAM_MEMBER_ACTORS;
    if (path === '/v1/commerce/stripe/config')
        return TEAM_MEMBER_ACTORS;
    if (path.startsWith('/v1/commerce/capacity-listings/') && (path.endsWith('/approve') || path.endsWith('/reject') || path.endsWith('/suspend')))
        return PLATFORM_ADMIN_ACTORS;
    if (path.startsWith('/v1/commerce/capacity-listings/') && path.endsWith('/inquiries'))
        return TEAM_MEMBER_ACTORS;
    if (path.startsWith('/v1/commerce/capacity-listings/') && method !== 'get')
        return TEAM_MANAGER_ACTORS;
    if (path.startsWith('/v1/commerce/capacity-listing-inquiries/') && (path.endsWith('/review') || path.endsWith('/approve-for-scoping') || path.endsWith('/decline')))
        return TEAM_MANAGER_ACTORS;
    if (path.startsWith('/v1/commerce/capacity-listing-inquiries'))
        return TEAM_MEMBER_ACTORS;
    if (path.startsWith('/v1/commerce/capacity-listings'))
        return method === 'get' ? ACCEPTANCE_ACTORS : TEAM_MANAGER_ACTORS;
    if (path.startsWith('/v1/commerce/services/contracts/') && (path.endsWith('/link-work') || path.endsWith('/fulfill')))
        return TEAM_MANAGER_ACTORS;
    if (path.startsWith('/v1/commerce/services/requests/') && (path.endsWith('/scoping') || path.endsWith('/quotes')))
        return method === 'get' ? TEAM_MEMBER_ACTORS : TEAM_MANAGER_ACTORS;
    if (path.startsWith('/v1/commerce/services/quotes/') && (path.endsWith('/submit') || path.endsWith('/vendor-approve')))
        return TEAM_MANAGER_ACTORS;
    if (path.startsWith('/v1/commerce/services/'))
        return TEAM_MEMBER_ACTORS;
    if (path.startsWith('/v1/commerce/products') && method === 'get')
        return ACCEPTANCE_ACTORS;
    if (path.startsWith('/v1/commerce/offers') && method === 'get')
        return ACCEPTANCE_ACTORS;
    if (path.startsWith('/v1/commerce/governance-events'))
        return TEAM_MEMBER_ACTORS;
    if (path.startsWith('/v1/commerce/'))
        return method === 'get' ? TEAM_MEMBER_ACTORS : TEAM_MANAGER_ACTORS;
    if (path.startsWith('/v1/catalog') || path.startsWith('/v1/templates') || path.startsWith('/v1/knowledge-packs'))
        return ACCEPTANCE_ACTORS;
    if (path.startsWith('/v1/seeds/') && method === 'get')
        return ['siteAdmin', 'marketSteward', 'teamOwner', 'teamOperator', 'teamViewer', 'nonMember', 'providerOperator'];
    if (path.startsWith('/v1/seeds/'))
        return ['siteAdmin', 'marketSteward'];
    return ['siteAdmin', 'marketSteward', 'teamOwner', 'teamOperator', 'teamViewer', 'nonMember', 'providerOperator'];
}

export function productionSafeStrategy(path, method) {
    if (method === 'get')
        return 'read';
    if (path === '/v1/internal/github/app/webhook')
        return 'signature-authenticated-callback';
    if (isTreeDxCredentialBridgePath(path))
        return 'service-credential-callback';
    if (path.startsWith('/v1/auth/web/appearance') || path.startsWith('/v1/auth/logout') || path.startsWith('/v1/auth/web/sessions/'))
        return 'acceptance-owned';
    if (path.startsWith('/v1/platform/runners/') || path.startsWith('/v1/provider/'))
        return 'acceptance-owned';
    if (path.startsWith('/v1/acceptance/'))
        return 'acceptance-service';
    return 'acceptance-owned-fixture';
}
