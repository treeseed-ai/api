import { ACCEPTANCE_ACTORS,PLATFORM_ADMIN_ACTORS,PROJECT_MANAGER_ACTORS,PROJECT_MEMBER_ACTORS,TEAM_MANAGER_ACTORS,TEAM_MEMBER_ACTORS } from '../support/actor-groups.js';

export function authClass(path, method = 'get') {
	if (path === '/v1/operator/commands/read') return 'team-member';
	if (path === '/v1/operator/commands/mutations') return 'team-manager';
    if (path.startsWith('/v1/provider-registrations') || path === '/v1/provider/access-tokens')
        return 'provider-proof';
    if (path.startsWith('/v1/provider/'))
        return 'provider-access-token';
    if (path.startsWith('/v1/platform/runners/')
        || path === '/v1/internal/treedx/authoring-journal/status'
        || path === '/v1/internal/treedx/credential-deliveries/prepare')
        return 'platform-runner';
    if (path.startsWith('/v1/acceptance/teams/'))
        return 'team-member';
    if (path.startsWith('/v1/acceptance/'))
        return 'acceptance-service';
    if (path === '/v1/service-providers')
        return 'public';
    if (path === '/v1/knowledge/library' || path === '/v1/knowledge/reader'
        || path === '/v1/knowledge/context' || path === '/v1/knowledge/search'
        || path.startsWith('/v1/knowledge/pages/'))
        return 'public';
    if (path.startsWith('/v1/admin/feedback'))
        return 'platform-admin';
    if (path === '/v1/feedback')
        return 'user';
    if (path.startsWith('/v1/auth/web/sign-') || path.startsWith('/v1/auth/availability/') || path === '/v1/auth/providers' || path.startsWith('/v1/auth/oauth/') || path.includes('/password-reset/') || path.includes('/auth/device/')) {
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
    if (path.includes('/members/') || path.includes('/invites'))
        return true;
    if (path.includes('/service-operation-leases')
        || path.includes('/credential-envelopes')
        || path.includes('/external-vault-bindings')
        || path.includes('/vault/grant-candidates'))
        return true;
    if (path.endsWith('/vault'))
        return true;
    if (method === 'get')
        return false;
    if (path.includes('/capacity-provider-requests') || path.includes('/capacity-provider-memberships')
		|| path.includes('/workday-runs') || path.includes('/workday-schedules') || path.includes('/agent-lab/')
		|| path.includes('/agent-deployments') || (path.includes('/agent-invocations/') && path.endsWith('/cancel')))
        return true;
    return /\/members\/|\/invites|\/api-keys|\/capacity\/|\/capacity-grants|\/services|\/vault|\/credential-profiles|\/operation-leases|\/external-vault|\/treedx/u.test(path);
}

export function successActorsFor(path, method) {
	if (path === '/v1/operator/commands/read') return TEAM_MEMBER_ACTORS;
	if (path === '/v1/operator/commands/mutations') return TEAM_MANAGER_ACTORS;
    if (path.startsWith('/v1/provider/'))
        return ['providerAccessToken'];
    if (path.startsWith('/v1/platform/runners/')
        || path === '/v1/internal/treedx/authoring-journal/status'
        || path === '/v1/internal/treedx/credential-deliveries/prepare')
        return ['platformRunner'];
    if (path.startsWith('/v1/acceptance/teams/'))
        return TEAM_MANAGER_ACTORS;
    if (path.startsWith('/v1/acceptance/'))
        return [];
    if (path.startsWith('/v1/platform/operations/:operationId'))
        return ['siteAdmin', 'platformSteward', 'teamOwner', 'teamOperator', 'teamViewer', 'nonMember', 'providerOperator'];
    if (path === '/v1/platform/operations' && method !== 'get')
        return ['siteAdmin', 'platformSteward', 'teamOwner', 'teamOperator', 'teamViewer', 'nonMember', 'providerOperator'];
    if (path.startsWith('/v1/platform/operations'))
        return PLATFORM_ADMIN_ACTORS;
	if (path === '/v1/discussions')
		return PROJECT_MEMBER_ACTORS;
    if (path.startsWith('/v1/admin/feedback'))
        return ['siteAdmin'];
    if (path === '/v1/feedback')
        return ['siteAdmin', 'platformSteward', 'teamOwner', 'teamOperator', 'teamViewer', 'nonMember', 'providerOperator'];
    if (path === '/v1/service-providers')
        return ACCEPTANCE_ACTORS;
    if (path === '/v1/knowledge/library' || path === '/v1/knowledge/reader'
        || path === '/v1/knowledge/context' || path === '/v1/knowledge/search'
        || path.startsWith('/v1/knowledge/pages/'))
        return ACCEPTANCE_ACTORS;
    if (path.includes('/username/check') || path.includes('/confirm-email') || path.includes('/password-reset/request') || path.includes('/password-reset/complete') || path.includes('/auth/device/')) {
        return ACCEPTANCE_ACTORS;
    }
    if (path.startsWith('/v1/auth/web/sign-up'))
        return ACCEPTANCE_ACTORS;
    if (path.startsWith('/v1/auth/web/sign-') || path.startsWith('/v1/auth/oauth/'))
        return ['anonymous'];
    if (path.startsWith('/v1/auth/'))
        return ['siteAdmin', 'platformSteward', 'teamOwner', 'teamOperator', 'teamViewer', 'nonMember', 'providerOperator'];
    if (path.startsWith('/v1/teams/:teamId')
        && (path.endsWith('/archive')
            || path.endsWith('/restore')
            || path.endsWith('/permanent-delete')
            || path.endsWith('/deletion-readiness')
            || path.endsWith('/ownership-transfer')))
        return TEAM_MANAGER_ACTORS;
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
            ? ['siteAdmin', 'platformSteward', 'teamOwner', 'teamOperator', 'teamViewer', 'nonMember', 'providerOperator']
            : ['siteAdmin', 'platformSteward', 'teamOwner', 'teamOperator', 'teamViewer', 'nonMember', 'providerOperator'];
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
        return ['siteAdmin', 'platformSteward', 'teamOwner', 'teamOperator', 'teamViewer', 'nonMember', 'providerOperator'];
    if (path.startsWith('/v1/seeds/') && method === 'get')
        return ['siteAdmin', 'platformSteward', 'teamOwner', 'teamOperator', 'teamViewer', 'nonMember', 'providerOperator'];
    if (path.startsWith('/v1/seeds/'))
        return ['siteAdmin', 'platformSteward'];
    return ['siteAdmin', 'platformSteward', 'teamOwner', 'teamOperator', 'teamViewer', 'nonMember', 'providerOperator'];
}
