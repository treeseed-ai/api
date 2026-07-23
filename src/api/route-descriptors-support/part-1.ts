import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { authClass, mutability, fixtureRequirements, API_ENDPOINT_GUARANTEE_FAMILIES, endpointGuaranteeFamily, endpointGuaranteeCoverage, endpointGuarantee, safeProduction, routeNeedsManagement, successActorsFor, productionSafeStrategy, bodyFactoryFor, acceptancePolicy, extractActiveApiRoutes, API_ROUTE_DESCRIPTORS, descriptorById, descriptorsForSdkMethods } from './index.js';

export const here = dirname(fileURLToPath(import.meta.url));

export function findPackageRoot(start) {
    let current = start;
    while (current !== dirname(current)) {
        if (existsSync(resolve(current, 'package.json')) && existsSync(resolve(current, 'src/api'))) {
            return current;
        }
        current = dirname(current);
    }
    return start;
}

export const packageRoot = findPackageRoot(here);

export function sourcePathFor(baseName) {
    const tsPath = resolve(here, `${baseName}.ts`);
    if (existsSync(tsPath))
        return tsPath;
    const packageTsPath = resolve(packageRoot, 'src/api', `${baseName}.ts`);
    if (existsSync(packageTsPath))
        return packageTsPath;
    const jsPath = resolve(here, `${baseName}.js`);
    if (existsSync(jsPath))
        return jsPath;
    return resolve(packageRoot, 'src/api', `${baseName}.js`);
}

export const appSourcePath = sourcePathFor('app');

export const projectDeploymentRoutesSourcePath = sourcePathFor('project-deployment-routes');

export function capacityRouteSourcePaths() {
    const sourceDirectory = resolve(packageRoot, 'src/api/capacity/routes');
    const directory = existsSync(sourceDirectory)
        ? sourceDirectory
        : resolve(packageRoot, 'dist/api/capacity/routes');
    const entries = readdirSync(directory);
    // Keep TypeScript suffixes out of a single string literal because the package
    // build's runtime-specifier rewrite intentionally converts quoted `.ts` suffixes.
    const tsExtension = ['.', 't', 's'].join('');
    const declarationExtension = ['.', 'd', '.', 't', 's'].join('');
    const extension = entries.some((name) => name.endsWith(tsExtension) && !name.endsWith(declarationExtension))
        ? tsExtension
        : '.js';
    return entries
        .filter((name) => name.endsWith(extension) && !name.endsWith('.d.js'))
        .map((name) => resolve(directory, name))
        .sort();
}

export function applicationRouteSourcePaths() {
    const sourceDirectory = resolve(packageRoot, 'src/api/routes');
    const directory = existsSync(sourceDirectory)
        ? sourceDirectory
        : resolve(packageRoot, 'dist/api/routes');
    const entries = readdirSync(directory);
    const extension = entries.some((name) => name.endsWith('.ts')) ? '.ts' : '.js';
    return entries
        .filter((name) => name.endsWith(extension) && !name.endsWith('.d.ts') && !name.endsWith('.d.js'))
        .map((name) => resolve(directory, name))
        .sort();
}

export const SDK_METHOD_ROUTE_MAP = {
    startDeviceLogin: 'post.v1.auth.device.start',
    pollDeviceLogin: 'post.v1.auth.device.poll',
    refreshToken: 'post.v1.auth.token.refresh',
    logout: 'post.v1.auth.logout',
    webSignUp: 'post.v1.auth.web.sign-up',
    confirmWebEmail: 'post.v1.auth.web.confirm-email',
    webSignIn: 'post.v1.auth.web.sign-in',
    checkWebUsername: 'get.v1.auth.availability.username',
    checkWebEmail: 'get.v1.auth.availability.email',
    authProviders: 'get.v1.auth.providers',
    accountIdentity: 'get.v1.auth.web.account.identity',
    webEmails: 'get.v1.auth.web.emails',
    addWebEmail: 'post.v1.auth.web.emails',
    verifyWebEmail: 'post.v1.auth.web.emails.emailId.verify',
    setPrimaryWebEmail: 'post.v1.auth.web.emails.emailId.primary',
    deleteWebEmail: 'delete.v1.auth.web.emails.emailId',
    webSessions: 'get.v1.auth.web.sessions',
    revokeWebSession: 'post.v1.auth.web.sessions.sessionId.revoke',
    updateWebProfile: 'patch.v1.auth.web.profile',
    webAppearance: 'get.v1.auth.web.appearance',
    updateWebAppearance: 'patch.v1.auth.web.appearance',
    updateWebPassword: 'patch.v1.auth.web.password',
    requestWebPasswordReset: 'post.v1.auth.web.password-reset.request',
    completeWebPasswordReset: 'post.v1.auth.web.password-reset.complete',
    accountDeletionBlockers: 'get.v1.auth.web.account.deletion-blockers',
    deleteAccount: 'delete.v1.auth.web.account',
    webNotificationPreferences: 'get.v1.auth.web.notifications.preferences',
    updateWebNotificationPreferences: 'put.v1.auth.web.notifications.preferences',
    webNotifications: 'get.v1.auth.web.notifications',
    markWebNotificationRead: 'post.v1.auth.web.notifications.notificationId.read',
    personalThemes: 'get.v1.auth.web.themes',
    createPersonalTheme: 'post.v1.auth.web.themes',
    updatePersonalTheme: 'patch.v1.auth.web.themes.themeId',
    deletePersonalTheme: 'delete.v1.auth.web.themes.themeId',
    me: 'get.v1.me',
    markets: 'get.v1.me.markets',
    currentMarket: 'get.v1.markets.current',
    teams: 'get.v1.teams',
    createTeam: 'post.v1.teams',
    deleteTeam: 'delete.v1.teams.teamId',
    teamDeletionBlockers: 'get.v1.teams.teamId.deletion-blockers',
    teamMembers: 'get.v1.teams.teamId.members',
    teamPermissions: 'get.v1.teams.teamId.permissions',
    importProjectRepository: 'post.v1.teams.teamId.projects.import',
    projects: 'get.v1.projects',
    createProject: 'post.v1.teams.teamId.projects',
    deleteProject: 'delete.v1.projects.projectId',
    projectDeletionBlockers: 'get.v1.projects.projectId.deletion-blockers',
    projectAccess: 'get.v1.projects.projectId.access',
    upsertProjectConnection: 'post.v1.projects.projectId.connection',
    projectDeploymentState: 'get.v1.projects.projectId.deployment-state',
    projectHosts: 'get.v1.projects.projectId.hosts',
    projectSecretEscrowRecords: 'get.v1.projects.projectId.secrets.escrow',
    createProjectSecretEscrow: 'post.v1.projects.projectId.secrets.escrow',
    projectSecretEscrow: 'get.v1.projects.projectId.secrets.escrow.escrowId',
    updateProjectSecretEscrow: 'patch.v1.projects.projectId.secrets.escrow.escrowId',
    migrateProjectSecretEscrow: 'post.v1.projects.projectId.secrets.escrow.escrowId.migrate',
    tombstoneProjectSecretEscrow: 'delete.v1.projects.projectId.secrets.escrow.escrowId',
    projectGitHubActionsSecretPublicKey: 'get.v1.projects.projectId.secrets.github-actions.public-key',
    deployProjectGitHubActionsSecret: 'post.v1.projects.projectId.secrets.github-actions.deploy',
    dispatchProjectWorkflowOperation: 'post.v1.projects.projectId.workflow-operations.operationId.dispatch',
    initializeProjectRepository: 'post.v1.projects.projectId.repositories.role.initialize',
    auditProjectHosts: 'post.v1.projects.projectId.hosts.audit',
    replaceProjectHost: 'post.v1.projects.projectId.hosts.requirementKey.replace',
    resyncProjectHost: 'post.v1.projects.projectId.hosts.requirementKey.resync',
    rotateProjectHost: 'post.v1.projects.projectId.hosts.requirementKey.rotate',
    projectDeploymentById: 'get.v1.project-deployments.deploymentId',
    projectDeployments: 'get.v1.projects.projectId.deployments',
    projectDeployment: 'get.v1.projects.projectId.deployments.deploymentId',
    projectDeploymentEvents: 'get.v1.projects.projectId.deployments.deploymentId.events',
    createProjectWebDeployment: 'post.v1.projects.projectId.deployments.web',
    retryProjectDeployment: 'post.v1.projects.projectId.deployments.deploymentId.retry',
    resumeProjectDeployment: 'post.v1.projects.projectId.deployments.deploymentId.resume',
    cancelProjectDeployment: 'post.v1.projects.projectId.deployments.deploymentId.cancel',
    teamCapacityRegistrationKey: 'get.v1.teams.teamId.capacity-registration-key',
    revealTeamCapacityRegistrationKey: 'get.v1.teams.teamId.capacity-registration-key.reveal',
    rotateTeamCapacityRegistrationKey: 'post.v1.teams.teamId.capacity-registration-key.rotate',
    enableTeamCapacityRegistrationKey: 'post.v1.teams.teamId.capacity-registration-key.enable',
    disableTeamCapacityRegistrationKey: 'post.v1.teams.teamId.capacity-registration-key.disable',
    capacityProviderRegistrationRequests: 'get.v1.teams.teamId.capacity-provider-requests',
    capacityProviderRegistrationRequest: 'get.v1.teams.teamId.capacity-provider-requests.requestId',
    reviewCapacityProviderRegistration: 'post.v1.teams.teamId.capacity-provider-requests.requestId.approve',
    capacityProviderMemberships: 'get.v1.teams.teamId.capacity-provider-memberships',
    capacityProviderMembership: 'get.v1.teams.teamId.capacity-provider-memberships.membershipId',
    capacityAuditEvents: 'get.v1.teams.teamId.capacity-audit-events',
    capacityProviderCredentials: 'get.v1.teams.teamId.capacity-provider-memberships.membershipId.credentials',
    authorizeCapacityProviderCredentialRotation: 'post.v1.teams.teamId.capacity-provider-memberships.membershipId.credentials.rotate',
    revokeCapacityProviderCredential: 'post.v1.teams.teamId.capacity-provider-memberships.membershipId.credentials.credentialId.revoke',
    suspendCapacityProviderMembership: 'post.v1.teams.teamId.capacity-provider-memberships.membershipId.suspend',
    resumeCapacityProviderMembership: 'post.v1.teams.teamId.capacity-provider-memberships.membershipId.resume',
    revokeCapacityProviderMembership: 'post.v1.teams.teamId.capacity-provider-memberships.membershipId.revoke',
    capacityGrants: 'get.v1.teams.teamId.capacity-grants',
    capacityGrant: 'get.v1.teams.teamId.capacity-grants.grantId',
    planCapacityGrant: 'post.v1.teams.teamId.capacity-grants.plan',
    createCapacityGrant: 'post.v1.teams.teamId.capacity-grants',
    transitionCapacityGrant: 'post.v1.teams.teamId.capacity-grants.grantId.activate',
    capacityAllocationSets: 'get.v1.teams.teamId.capacity.allocation-sets',
    planCapacityAllocationSet: 'post.v1.teams.teamId.capacity.allocation-sets.plan',
    createCapacityAllocationSet: 'post.v1.teams.teamId.capacity.allocation-sets',
    capacityAllocationSet: 'get.v1.teams.teamId.capacity.allocation-sets.allocationSetId',
    activateCapacityAllocationSet: 'post.v1.teams.teamId.capacity.allocation-sets.allocationSetId.activate',
    supersedeCapacityAllocationSet: 'post.v1.teams.teamId.capacity.allocation-sets.allocationSetId.supersede',
    archiveCapacityAllocationSet: 'post.v1.teams.teamId.capacity.allocation-sets.allocationSetId.archive',
    explainCapacityAllocationSet: 'post.v1.teams.teamId.capacity.allocation-sets.allocationSetId.explain',
    providerAvailabilitySessions: 'get.v1.teams.teamId.capacity.availability-sessions',
    capacityProviderAssignments: 'get.v1.teams.teamId.capacity.assignments',
    capacityProviderAssignment: 'get.v1.teams.teamId.capacity.assignments.assignmentId',
    capacityReservations: 'get.v1.teams.teamId.capacity.reservations',
    capacityReservationExplanation: 'get.v1.teams.teamId.capacity.reservations.reservationId.explanation',
    capacityUsage: 'get.v1.teams.teamId.capacity.usage',
    capacityLedger: 'get.v1.teams.teamId.capacity.ledger',
    executionRuns: 'get.v1.teams.teamId.capacity.execution-runs',
    admitCapacityAssignment: 'post.v1.teams.teamId.capacity.admissions',
    providerAssignmentExplanation: 'get.v1.teams.teamId.capacity.assignments.assignmentId.explanation',
    projectCapacityDiagnostics: 'get.v1.projects.projectId.capacity-diagnostics',
    projectCapacityRuntimeDiagnostics: 'get.v1.projects.projectId.capacity-runtime-diagnostics',
    projectAgentClasses: 'get.v1.projects.projectId.agent-classes',
    createProjectAgentClass: 'post.v1.projects.projectId.agent-classes',
    projectAgentClass: 'get.v1.projects.projectId.agent-classes.classId',
    updateProjectAgentClass: 'patch.v1.projects.projectId.agent-classes.classId',
    projectAgentModeRuns: 'get.v1.projects.projectId.agent-mode-runs',
    projectAgentFallbackOutputs: 'get.v1.projects.projectId.agent-fallback-outputs',
    projectTreeDxProxyAudit: 'get.v1.projects.projectId.treedx-proxy-audit',
    decisionPlanningStatus: 'get.v1.decisions.decisionId.planning-status',
    createPlanningInputRequest: 'post.v1.decisions.decisionId.planning-input-requests',
    decisionStructuredEstimates: 'get.v1.decisions.decisionId.estimates',
    createStructuredAgentEstimate: 'post.v1.decisions.decisionId.estimates',
    acceptStructuredAgentEstimate: 'post.v1.structured-agent-estimates.estimateId.accept',
    decisionExecutionInputs: 'get.v1.decisions.decisionId.execution-inputs',
    createDecisionExecutionInput: 'post.v1.decisions.decisionId.execution-inputs',
    acceptDecisionExecutionInput: 'post.v1.decision-execution-inputs.inputId.accept',
    requestDecisionExecutionInputRevision: 'post.v1.decision-execution-inputs.inputId.request-revision',
    decisionAssignmentGraphs: 'get.v1.decisions.decisionId.assignment-graphs',
    decisionAssignmentGraph: 'get.v1.decision-assignment-graphs.graphId',
    decisionCapacityPlans: 'get.v1.decisions.decisionId.capacity-plans',
    createDecisionCapacityPlan: 'post.v1.decisions.decisionId.capacity-plans',
    capacityPlan: 'get.v1.capacity-plans.capacityPlanId',
    acceptCapacityPlan: 'post.v1.capacity-plans.capacityPlanId.accept',
    requestCapacityPlanRevision: 'post.v1.capacity-plans.capacityPlanId.request-revision',
    scheduleCapacityPlan: 'post.v1.capacity-plans.capacityPlanId.schedule',
    supersedeCapacityPlan: 'post.v1.capacity-plans.capacityPlanId.supersede',
    createWorkday: 'post.v1.workdays',
    workday: 'get.v1.workdays.workdayId',
    startWorkday: 'post.v1.workdays.workdayId.start',
    pauseWorkday: 'post.v1.workdays.workdayId.pause',
    resumeWorkday: 'post.v1.workdays.workdayId.resume',
    cancelWorkday: 'post.v1.workdays.workdayId.cancel',
    completeWorkday: 'post.v1.workdays.workdayId.complete',
    workdaySummary: 'get.v1.workdays.workdayId.summary',
    workdayRuns: 'get.v1.teams.teamId.workday-runs',
    createWorkdayRun: 'post.v1.teams.teamId.workday-runs',
    workdayRun: 'get.v1.teams.teamId.workday-runs.runId',
    updateWorkdayRun: 'patch.v1.teams.teamId.workday-runs.runId',
    tickWorkdayRun: 'post.v1.teams.teamId.workday-runs.runId.tick',
    createResearchWorkflow: 'post.v1.projects.projectId.research-workflows',
    researchWorkflow: 'get.v1.research-workflows.workflowId',
    workdayEvents: 'get.v1.teams.teamId.workday-runs.runId.events',
    createWorkdayEvent: 'post.v1.teams.teamId.workday-runs.runId.events',
    cancelCapacityAssignment: 'post.v1.teams.teamId.capacity.assignments.assignmentId.cancel',
    requeueCapacityAssignment: 'post.v1.teams.teamId.capacity.assignments.assignmentId.requeue',
    decideCapacityOverrun: 'post.v1.teams.teamId.capacity.reservations.reservationId.overrun.approve',
    teamTreeDx: 'get.v1.teams.teamId.treedx',
    updateTeamTreeDx: 'put.v1.teams.teamId.treedx',
    provisionTeamTreeDx: 'post.v1.teams.teamId.treedx.provision',
    treeDxMirrors: 'get.v1.teams.teamId.treedx.mirrors',
    createTreeDxMirror: 'post.v1.teams.teamId.treedx.mirrors',
    syncTreeDxMirror: 'post.v1.teams.teamId.treedx.mirrors.mirrorId.sync',
    treeDxShares: 'get.v1.teams.teamId.treedx.shares',
    createTreeDxShare: 'post.v1.teams.teamId.treedx.shares',
    projectTreeDxLibrary: 'get.v1.projects.projectId.treedx-library',
    upsertProjectTreeDxLibrary: 'post.v1.projects.projectId.treedx-library',
    projectRepositoryTopology: 'get.v1.projects.projectId.repository-topology',
    updateProjectRepositoryTopology: 'put.v1.projects.projectId.repository-topology',
    deliverableManifest: 'get.v1.deliverable-manifests.manifestId',
    treeDxBuildContext: 'post.v1.dx.projects.projectId.repos.repoId.context.build',
    treeDxReadRepositoryFiles: 'post.v1.dx.projects.projectId.repos.repoId.files.read',
    createTreeDxWorkspace: 'post.v1.dx.projects.projectId.repos.repoId.workspaces',
    planSeed: 'post.v1.seeds.name.plan',
    applySeed: 'post.v1.seeds.name.apply',
    listSeedRuns: 'get.v1.seeds.runs',
    exportSeed: 'post.v1.teams.teamId.seeds.export',
    catalog: 'get.v1.catalog',
    artifactDownload: 'get.v1.catalog.itemId.artifacts.version.download',
};

export const ACCEPTANCE_ACTORS = [
    'anonymous',
    'siteAdmin',
    'marketSteward',
    'teamOwner',
    'teamOperator',
    'teamViewer',
    'nonMember',
    'providerOperator',
    'providerAccessToken',
    'platformRunner',
];

export const TEAM_MEMBER_ACTORS = ['siteAdmin', 'marketSteward', 'teamOwner', 'teamOperator', 'teamViewer', 'providerOperator'];

export const TEAM_MANAGER_ACTORS = ['siteAdmin', 'marketSteward', 'teamOwner'];

export const PROJECT_MEMBER_ACTORS = ['siteAdmin', 'marketSteward', 'teamOwner', 'teamOperator', 'teamViewer', 'providerOperator'];

export const PROJECT_MANAGER_ACTORS = ['siteAdmin', 'marketSteward', 'teamOwner', 'teamOperator', 'teamViewer'];

export const PLATFORM_ADMIN_ACTORS = ['siteAdmin', 'marketSteward'];

export function routeId(method, path) {
    return [
        method.toLowerCase(),
        ...path
            .replace(/^\/+/u, '')
            .split('/')
            .filter(Boolean)
            .map((part) => part.startsWith(':') ? part.slice(1) : part)
            .map((part) => part.replace(/[^a-zA-Z0-9]+/gu, '-').replace(/^-+|-+$/gu, ''))
            .filter(Boolean),
    ].join('.');
}

export function isTreeDxCredentialBridgePath(path) {
    return path === '/v1/internal/treedx/credentials/github';
}

export function ownerDomain(path) {
    if (path === '/v1/internal/github/app/webhook')
        return 'secrets-capability';
    if (isTreeDxCredentialBridgePath(path))
        return 'secrets-capability';
    if (path.startsWith('/v1/provider/') || path.startsWith('/v1/provider-registrations'))
        return 'provider-ingress';
    if (path.startsWith('/v1/platform/runners/'))
        return 'platform-runner';
    if (path.startsWith('/v1/platform/operations'))
        return 'platform-operation';
    if (path.startsWith('/v1/ui/'))
        return 'market-ui';
    if (path.startsWith('/v1/auth/'))
        return 'auth';
    if (path.startsWith('/v1/commons/'))
        return 'commons';
    if (path.startsWith('/v1/teams/'))
        return 'team';
    if (path.startsWith('/v1/projects/'))
        return 'project';
    if (path.startsWith('/v1/commerce/'))
        return 'commerce';
    if (path.startsWith('/v1/capacity/') || path.includes('/capacity-'))
        return 'capacity';
    if (path.startsWith('/v1/catalog'))
        return 'catalog';
    if (path.startsWith('/v1/seeds/'))
        return 'seed';
    if (path.startsWith('/v1/acceptance/'))
        return 'acceptance';
    if (path.startsWith('/v1/me') || path.startsWith('/v1/markets/'))
        return 'identity';
    return 'market';
}
