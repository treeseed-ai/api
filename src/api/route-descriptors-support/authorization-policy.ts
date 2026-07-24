import { ACCEPTANCE_ACTORS, TEAM_MEMBER_ACTORS, TEAM_MANAGER_ACTORS, PROJECT_MEMBER_ACTORS, PROJECT_MANAGER_ACTORS, PLATFORM_ADMIN_ACTORS, isTreeDxCredentialBridgePath } from './index.js';

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
