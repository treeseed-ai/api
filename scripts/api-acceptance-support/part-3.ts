import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import { ACCEPTANCE_ACTORS, API_ROUTE_DESCRIPTORS, SDK_METHOD_ROUTE_MAP } from '../../src/api/route-descriptors.ts';
import { parseArgs, isLoopbackAcceptanceUrl, assertAcceptanceTarget, matchesCaseFilter, loadExpectedStatuses, deepMerge, loadSpec, interpolate, equalJsonValue, actorHeaders, loadMarketClient, serviceHeaders, optionalAcceptanceServiceHeaders, addOptionalAcceptanceServiceHeaders, usesHostedAcceptanceEmailBypass, acceptanceRequestTimeoutMs, acceptanceRequestAttempts, retryDelayMs, isRetryableFetchError, isRetryableResponse, sanitizeDiagnosticValue, fetchWithTimeout, getPath, mailpitMessages, mailpitMessageSubject, mailpitMessageRecipients, assertMailpitExpectation, assertCase, expandRoleMatrices, fixtureValue, descriptorPath, bodyForFactory, expectedForDescriptor, actorForCase, main } from './index.js';

export function expandDescriptorMatrices(spec, expectedStatuses = loadExpectedStatuses(spec.expectedStatuses), caseId = '') {
    const matrices = Array.isArray(spec.descriptorMatrices) ? spec.descriptorMatrices : [];
    const expanded = [];
    for (const matrix of matrices) {
        const actors = Array.isArray(matrix.actors) ? matrix.actors : [];
        const methods = new Set(Array.isArray(matrix.methods) ? matrix.methods.map((entry) => String(entry).toUpperCase()) : ['GET']);
        const domains = new Set(Array.isArray(matrix.ownerDomains) ? matrix.ownerDomains : []);
        const authClasses = new Set(Array.isArray(matrix.authClasses) ? matrix.authClasses : []);
        const ids = new Set(Array.isArray(matrix.ids) ? matrix.ids : []);
        for (const descriptor of API_ROUTE_DESCRIPTORS) {
            if (ids.size > 0 && !ids.has(descriptor.id))
                continue;
            if (ids.size === 0 && !methods.has(descriptor.method))
                continue;
            if (domains.size > 0 && !domains.has(descriptor.ownerDomain))
                continue;
            if (authClasses.size > 0 && !authClasses.has(descriptor.authClass))
                continue;
            if (matrix.excludeProviderIngress !== false && descriptor.providerIngress)
                continue;
            if (matrix.excludeInternalRunner !== false && descriptor.internalRunner)
                continue;
            for (const actor of actors) {
                const id = `${matrix.id}.${descriptor.id}.${actor}`;
                if (!matchesCaseFilter(caseId, id))
                    continue;
                const expected = {
                    ...(matrix.expect ?? {}),
                    ...expectedForDescriptor(descriptor, actor, expectedStatuses),
                    ...(matrix.expectByDescriptor?.[descriptor.id]?.[actor] ?? matrix.expectByDescriptor?.[descriptor.id] ?? {}),
                };
                const body = bodyForFactory(descriptor.acceptance?.bodyFactory, descriptor, actor);
                expanded.push({
                    id,
                    actor,
                    method: descriptor.method,
                    path: descriptorPath(descriptor),
                    body,
                    expect: expected,
                    descriptorId: descriptor.id,
                    coverageOnly: matrix.coverageOnly === true,
                    environments: matrix.environments,
                });
            }
        }
    }
    return expanded;
}

export function sdkArgsForMethod(method) {
    const stamp = 'acc-${runNonce}';
    const args = {
        startDeviceLogin: [{ clientId: 'treeseed-acceptance', scopes: ['auth:me'] }],
        pollDeviceLogin: [{ deviceCode: `acceptance-device-${stamp}` }],
        refreshToken: [{ refreshToken: `acceptance-refresh-${stamp}` }],
        logout: [],
        webSignUp: [{ email: `treeseed+${stamp}-sdk-signup@treeseed.ai`, username: `${stamp}-sdk-signup`, password: '${seed.password}', name: 'Acceptance SDK' }],
        webSignIn: [{ email: '${actors.siteAdmin.email}', password: '${seed.password}' }],
        checkWebUsername: ['${actors.teamOwner.username}'],
        checkWebEmail: ['${actors.teamOwner.email}'],
        markWebNotificationRead: ['missing-notification'],
        updateWebNotificationPreferences: [{ emailCadence: 'daily', timeZone: 'UTC', globalContentTypes: [], projectOverrides: [] }],
        webNotifications: [20],
        createPersonalTheme: [{ name: 'Acceptance theme', baseScheme: 'fern', palette: { light: { canvas: '#ffffff', surface: '#f5f5f5', text: '#111111', accent: '#176b45' }, dark: { canvas: '#101510', surface: '#182018', text: '#f5fff5', accent: '#69d69a' } } }],
        updatePersonalTheme: ['missing-theme', { name: 'Acceptance theme', baseScheme: 'fern', palette: { light: { canvas: '#ffffff', surface: '#f5f5f5', text: '#111111', accent: '#176b45' }, dark: { canvas: '#101510', surface: '#182018', text: '#f5fff5', accent: '#69d69a' } } }],
        deletePersonalTheme: ['missing-theme'],
        webEmails: [],
        webSessions: [],
        addWebEmail: [{ email: '${actors.teamOwner.email}' }],
        confirmWebEmail: [{ token: '' }],
        verifyWebEmail: ['missing-email'],
        setPrimaryWebEmail: ['missing-email'],
        deleteWebEmail: ['missing-email'],
        revokeWebSession: ['missing-session'],
        updateWebProfile: [{ name: 'Acceptance SDK Profile' }],
        webAppearance: [],
        updateWebAppearance: [{ colorScheme: 'fern', themeMode: 'system' }],
        updateWebEmail: [{ email: '${actors.teamOwner.email}' }],
        updateWebPassword: [{ currentPassword: '${seed.password}', password: '${seed.password}' }],
        requestWebPasswordReset: [{ email: '${actors.teamOwner.email}' }],
        completeWebPasswordReset: [{ token: '${fixtures.passwordReset.token}', password: '${seed.password}' }],
        accountDeletionBlockers: [],
        deleteAccount: [{ confirmation: 'DELETE acceptance-owned-account' }],
        me: [],
        markets: [],
        currentMarket: [],
        teams: [],
        createTeam: [{ slug: 'acceptance-${runNonce}-sdk-team', name: 'Acceptance SDK Team' }],
        deleteTeam: ['missing-team', { confirmation: 'DELETE missing-team' }],
        teamDeletionBlockers: ['${fixtures.team.id}'],
        teamMembers: ['${fixtures.team.id}'],
        teamPermissions: ['${fixtures.team.id}'],
        projects: ['${fixtures.team.id}'],
        createProject: ['${fixtures.team.id}', { slug: 'acceptance-${runNonce}-sdk-project', name: 'Acceptance SDK Project' }],
        deleteProject: ['missing-project', { confirmation: 'DELETE missing-project' }],
        projectDeletionBlockers: ['${fixtures.project.id}'],
        upsertProjectConnection: ['${fixtures.project.id}', { mode: 'hybrid', executionOwner: 'project_runner' }],
        importProjectRepository: ['${fixtures.team.id}', {
                repository: {
                    provider: 'github',
                    owner: 'treeseed-acceptance',
                    name: 'acceptance-${runNonce}-import',
                    url: 'https://github.com/treeseed-acceptance/acceptance-${runNonce}-import',
                    defaultBranch: 'main',
                },
                project: {
                    slug: 'acceptance-${runNonce}-import',
                    name: 'Acceptance Import ${runNonce}',
                },
                architecture: {
                    topology: 'single_repository_site',
                    rootPath: '.',
                    sitePath: 'docs',
                    contentPath: 'docs/src/content',
                    contentRuntimeSource: 'treedx_snapshot',
                    localContentMaterialization: 'existing_path',
                },
            }],
        projectAccess: ['${fixtures.project.id}'],
        projectDeploymentState: ['${fixtures.project.id}'],
        projectHosts: ['${fixtures.project.id}'],
        projectSecretEscrowRecords: ['${fixtures.project.id}'],
        createProjectSecretEscrow: ['${fixtures.project.id}', {}],
        projectSecretEscrow: ['${fixtures.project.id}', 'missing-escrow'],
        updateProjectSecretEscrow: ['${fixtures.project.id}', 'missing-escrow', { status: 'active' }],
        migrateProjectSecretEscrow: ['${fixtures.project.id}', 'missing-escrow', { target: 'acceptance' }],
        tombstoneProjectSecretEscrow: ['${fixtures.project.id}', 'missing-escrow'],
        projectGitHubActionsSecretPublicKey: ['${fixtures.project.id}', {
                repository: 'treeseed-acceptance/acceptance',
                scope: 'environment',
                environment: '${environment}',
            }],
        deployProjectGitHubActionsSecret: ['${fixtures.project.id}', {
                repository: 'treeseed-acceptance/acceptance',
                scope: 'environment',
                environment: '${environment}',
                secretName: 'ACCEPTANCE_SECRET',
                encryptedValue: 'redacted-acceptance-secret',
                keyId: 'acceptance-key',
            }],
        dispatchProjectWorkflowOperation: ['${fixtures.project.id}', 'missing-operation', {}],
        initializeProjectRepository: ['${fixtures.project.id}', 'software', {}],
        auditProjectHosts: ['${fixtures.project.id}', {}],
        replaceProjectHost: ['${fixtures.project.id}', 'publicWeb', {}],
        resyncProjectHost: ['${fixtures.project.id}', 'publicWeb', {}],
        rotateProjectHost: ['${fixtures.project.id}', 'publicWeb', {}],
        projectDeployments: ['${fixtures.project.id}'],
        projectDeploymentById: ['${fixtures.deployment.id}'],
        projectDeployment: ['${fixtures.project.id}', '${fixtures.deployment.id}'],
        projectDeploymentEvents: ['${fixtures.project.id}', '${fixtures.deployment.id}'],
        createProjectWebDeployment: ['${fixtures.project.id}'],
        retryProjectDeployment: ['${fixtures.project.id}', '${fixtures.deployment.id}'],
        resumeProjectDeployment: ['${fixtures.project.id}', '${fixtures.deployment.id}'],
        cancelProjectDeployment: ['${fixtures.project.id}', '${fixtures.deployment.id}'],
        teamCapacityRegistrationKey: ['${fixtures.team.id}'],
        revealTeamCapacityRegistrationKey: ['${fixtures.team.id}'],
        rotateTeamCapacityRegistrationKey: ['${fixtures.team.id}', 'acceptance-${runNonce}-registration-rotate'],
        enableTeamCapacityRegistrationKey: ['${fixtures.team.id}', 'acceptance-${runNonce}-registration-enable'],
        disableTeamCapacityRegistrationKey: ['${fixtures.team.id}', 'acceptance-${runNonce}-registration-disable'],
        capacityProviderRegistrationRequests: ['${fixtures.team.id}'],
        capacityProviderRegistrationRequest: ['${fixtures.team.id}', 'missing-registration-request'],
        reviewCapacityProviderRegistration: ['${fixtures.team.id}', 'missing-registration-request', 'approve', 'acceptance-${runNonce}-review-registration', {}],
        capacityProviderMemberships: ['${fixtures.team.id}'],
        capacityProviderMembership: ['${fixtures.team.id}', 'missing-membership'],
        capacityAuditEvents: ['${fixtures.team.id}', { limit: 25 }],
        capacityProviderCredentials: ['${fixtures.team.id}', 'missing-membership'],
        authorizeCapacityProviderCredentialRotation: ['${fixtures.team.id}', 'missing-membership', 'acceptance-${runNonce}-credential-rotate'],
        revokeCapacityProviderCredential: ['${fixtures.team.id}', 'missing-membership', 'missing-credential', 'acceptance-${runNonce}-credential-revoke'],
        suspendCapacityProviderMembership: ['${fixtures.team.id}', 'missing-membership', 'acceptance-${runNonce}-membership-suspend'],
        resumeCapacityProviderMembership: ['${fixtures.team.id}', 'missing-membership', 'acceptance-${runNonce}-membership-resume'],
        revokeCapacityProviderMembership: ['${fixtures.team.id}', 'missing-membership', 'acceptance-${runNonce}-membership-revoke'],
        capacityGrants: ['${fixtures.team.id}'],
        capacityGrant: ['${fixtures.team.id}', 'missing-grant'],
        planCapacityGrant: ['${fixtures.team.id}', { membershipId: 'missing-membership', providerId: 'missing-provider', projectId: '${fixtures.project.id}', environment: 'local', executionProviderIds: ['missing-execution-provider'], capabilities: ['engineering'], allowedModes: ['planning'], dailyCreditLimit: 1, monthlyCreditLimit: 1, maxConcurrentAssignments: 1, unmetered: false }],
        createCapacityGrant: ['${fixtures.team.id}', { membershipId: 'missing-membership', providerId: 'missing-provider', projectId: '${fixtures.project.id}', environment: 'local', executionProviderIds: ['missing-execution-provider'], capabilities: ['engineering'], allowedModes: ['planning'], dailyCreditLimit: 1, monthlyCreditLimit: 1, maxConcurrentAssignments: 1, unmetered: false }, 'acceptance-${runNonce}-grant-create'],
        capacityAllocationSets: ['${fixtures.team.id}'],
        createCapacityAllocationSet: ['${fixtures.team.id}', { id: 'acceptance-${runNonce}-allocation', reservePolicy: { percent: 0, overflow: 'deny' }, slices: [{ id: 'project:${fixtures.project.id}', scope: 'project', targetId: '${fixtures.project.id}', policy: { minPercent: 0, targetPercent: 100, maxPercent: 100, hardCapPercent: 100 } }], borrowingRules: [], metadata: { acceptance: true } }, 'acceptance-${runNonce}-allocation-create'],
        planCapacityAllocationSet: ['${fixtures.team.id}', { id: 'acceptance-${runNonce}-allocation-plan', reservePolicy: { percent: 0, overflow: 'deny' }, slices: [{ id: 'project:${fixtures.project.id}', scope: 'project', targetId: '${fixtures.project.id}', policy: { minPercent: 0, targetPercent: 100, maxPercent: 100, hardCapPercent: 100 } }], borrowingRules: [], metadata: { acceptance: true } }],
        capacityAllocationSet: ['${fixtures.team.id}', 'missing-allocation-set'],
        activateCapacityAllocationSet: ['${fixtures.team.id}', 'missing-allocation-set'],
        supersedeCapacityAllocationSet: ['${fixtures.team.id}', 'missing-allocation-set', { expectedActiveAllocationSetId: 'missing-active-allocation' }, 'acceptance-${runNonce}-allocation-supersede'],
        archiveCapacityAllocationSet: ['${fixtures.team.id}', 'missing-allocation-set', 'acceptance-${runNonce}-allocation-archive'],
        explainCapacityAllocationSet: ['${fixtures.team.id}', 'missing-allocation-set', {}],
        providerAvailabilitySessions: ['${fixtures.team.id}', { providerId: '${fixtures.provider.id}' }],
        capacityProviderAssignments: ['${fixtures.team.id}', { providerId: '${fixtures.provider.id}', projectId: '${fixtures.project.id}' }],
        capacityProviderAssignment: ['${fixtures.team.id}', 'missing-assignment'],
        capacityReservations: ['${fixtures.team.id}', { projectId: '${fixtures.project.id}' }],
        capacityReservationExplanation: ['${fixtures.team.id}', 'missing-reservation'],
        capacityUsage: ['${fixtures.team.id}', { projectId: '${fixtures.project.id}' }],
        capacityLedger: ['${fixtures.team.id}', { projectId: '${fixtures.project.id}' }],
        executionRuns: ['${fixtures.team.id}', { projectId: '${fixtures.project.id}' }],
        admitCapacityAssignment: ['${fixtures.team.id}', { providerId: 'missing-provider', membershipId: 'missing-membership', projectId: '${fixtures.project.id}', projectAgentClassId: 'missing-agent-class', agentId: 'acceptance-agent', mode: 'planning', environment: 'local', requestedCredits: 1 }, 'acceptance-${runNonce}-admission'],
        createProviderAssignment: ['${fixtures.team.id}', {
                projectId: '${fixtures.project.id}',
                capacityProviderId: '${fixtures.provider.id}',
                projectAgentClassId: 'missing-agent-class',
                agentId: 'acceptance-agent',
                mode: 'planning',
                environment: 'local',
            }],
        providerAssignmentExplanation: ['${fixtures.team.id}', 'missing-assignment'],
        projectCapacityDiagnostics: ['${fixtures.project.id}', 'staging'],
        projectCapacityRuntimeDiagnostics: ['${fixtures.project.id}', '${fixtures.team.id}'],
        projectAgentClasses: ['${fixtures.project.id}'],
        createProjectAgentClass: ['${fixtures.project.id}', {
                id: 'acceptance-${runNonce}-class',
                name: 'Acceptance Planning Class',
                mode: 'planning',
                handler: 'planner',
                metadata: { acceptance: true, runNonce: '${runNonce}' },
            }],
        projectAgentClass: ['${fixtures.project.id}', 'missing-agent-class'],
        updateProjectAgentClass: ['${fixtures.project.id}', 'missing-agent-class', { name: 'Missing Agent Class' }],
        projectAgentModeRuns: ['${fixtures.project.id}'],
        projectAgentFallbackOutputs: ['${fixtures.project.id}'],
        projectTreeDxProxyAudit: ['${fixtures.project.id}'],
        decisionPlanningStatus: ['missing-decision'],
        createPlanningInputRequest: ['${fixtures.decision.id}', {
                projectId: '${fixtures.project.id}',
                projectAgentClassId: 'acceptance-${runNonce}-class',
                mode: 'planning',
                reason: 'acceptance',
                context: { acceptance: true, runNonce: '${runNonce}' },
            }],
        decisionExecutionInputs: ['missing-decision'],
        createDecisionExecutionInput: ['${fixtures.decision.id}', {
                projectId: '${fixtures.project.id}',
                projectAgentClassId: 'acceptance-${runNonce}-class',
                mode: 'acting',
                sourceKind: 'acceptance',
                sourceId: 'acceptance-${runNonce}',
                summary: 'Acceptance decision execution input.',
                payload: { acceptance: true, runNonce: '${runNonce}' },
                metadata: { acceptance: true, runNonce: '${runNonce}' },
            }],
        acceptDecisionExecutionInput: ['missing-input', {}],
        requestDecisionExecutionInputRevision: ['missing-input', { reason: 'acceptance revision fixture' }],
        deliverableManifest: ['missing-deliverable-manifest'],
        decisionCapacityPlans: ['${fixtures.decision.id}'],
        createDecisionCapacityPlan: ['${fixtures.decision.id}', {
                projectId: '${fixtures.project.id}',
                estimatedCreditsP50: 1,
                estimatedCreditsP90: 2,
                summary: 'Acceptance capacity plan.',
            }],
        capacityPlan: ['missing-capacity-plan'],
        acceptCapacityPlan: ['missing-capacity-plan', {}],
        requestCapacityPlanRevision: ['missing-capacity-plan', { reason: 'acceptance revision fixture' }],
        scheduleCapacityPlan: ['missing-capacity-plan', {}],
        supersedeCapacityPlan: ['missing-capacity-plan', { reason: 'acceptance supersede fixture' }],
        createWorkday: [{
                projectId: '${fixtures.project.id}',
                capacityProviderId: '${fixtures.provider.id}',
                environment: 'local',
                state: 'active',
                summary: { acceptance: true, runNonce: '${runNonce}' },
            }, 'acceptance-${runNonce}-workday-create'],
        workday: ['missing-workday'],
        startWorkday: ['missing-workday'],
        pauseWorkday: ['missing-workday'],
        completeWorkday: ['missing-workday'],
        workdaySummary: ['missing-workday'],
        workdayRuns: ['${fixtures.team.id}'],
        createWorkdayRun: ['${fixtures.team.id}', {
                scenarioId: 'acceptance',
                status: 'queued',
                environment: 'local',
                parameters: { acceptance: true, runNonce: '${runNonce}' },
            }],
        workdayRun: ['${fixtures.team.id}', 'missing-workday-run'],
        updateWorkdayRun: ['${fixtures.team.id}', 'missing-workday-run', {
                status: 'running',
                summary: { acceptance: true, runNonce: '${runNonce}' },
            }],
        tickWorkdayRun: ['${fixtures.team.id}', 'missing-workday-run', { idempotencyKey: 'acceptance-${runNonce}-workday-tick' }],
        createResearchWorkflow: ['${fixtures.project.id}', {}],
        workdayEvents: ['${fixtures.team.id}', 'missing-workday-run'],
        createWorkdayEvent: ['${fixtures.team.id}', 'missing-workday-run', {
                eventType: 'acceptance',
                status: 'recorded',
                title: 'Acceptance event',
                message: 'Acceptance workday event.',
                parameters: { runNonce: '${runNonce}' },
            }],
        cancelCapacityAssignment: ['${fixtures.team.id}', 'missing-assignment', { idempotencyKey: 'acceptance-${runNonce}-assignment-cancel' }],
        requeueCapacityAssignment: ['${fixtures.team.id}', 'missing-assignment', { idempotencyKey: 'acceptance-${runNonce}-assignment-requeue' }],
        decideCapacityOverrun: ['${fixtures.team.id}', 'missing-reservation', 'approve', { idempotencyKey: 'acceptance-${runNonce}-overrun' }],
        teamTreeDx: ['${fixtures.team.id}'],
        updateTeamTreeDx: ['${fixtures.team.id}', {
                name: 'Acceptance SDK TreeDX',
                kind: 'self_hosted',
                provider: 'self_hosted',
                baseUrl: 'https://treedx.acceptance.example',
                status: 'active',
            }],
        provisionTeamTreeDx: ['${fixtures.team.id}', { publicRead: true, idempotencyKey: 'acceptance-${runNonce}-treedx-provision' }],
        treeDxMirrors: ['${fixtures.team.id}'],
        createTreeDxMirror: ['${fixtures.team.id}', {
                id: 'acceptance-${runNonce}-treedx-mirror',
                name: 'Acceptance SDK Mirror',
                targetKind: 'git',
                targetUrl: 'https://github.com/treeseed-acceptance/treedx-mirror',
            }],
        syncTreeDxMirror: ['${fixtures.team.id}', 'acceptance-${runNonce}-treedx-mirror', { status: 'syncing', lastSyncStatus: 'queued' }],
        treeDxShares: ['${fixtures.team.id}'],
        createTreeDxShare: ['${fixtures.team.id}', {
                id: 'acceptance-${runNonce}-treedx-share',
                projectId: '${fixtures.project.id}',
                libraryId: 'acceptance/${runNonce}',
                scope: 'team',
            }],
        projectTreeDxLibrary: ['${fixtures.project.id}'],
        upsertProjectTreeDxLibrary: ['${fixtures.project.id}', {
                libraryId: 'acceptance/${runNonce}',
                repositoryId: 'acceptance-${runNonce}-repository',
            }],
        projectRepositoryTopology: ['${fixtures.project.id}'],
        updateProjectRepositoryTopology: ['${fixtures.project.id}', {
                topology: 'single_repository_site',
                rootPath: '.',
                sitePath: 'docs',
                contentPath: 'docs/src/content',
                contentRuntimeSource: 'treedx_snapshot',
                localContentMaterialization: 'existing_path',
                metadata: { acceptance: true, runNonce: '${runNonce}' },
            }],
        treeDxBuildContext: ['missing-project', 'acceptance-${runNonce}-repository', { query: 'acceptance', limit: 3 }],
        treeDxReadRepositoryFiles: ['missing-project', 'acceptance-${runNonce}-repository', { paths: ['README.md'] }],
        planSeed: ['acceptance', { environment: '${environment}', planOnly: true }],
        applySeed: ['acceptance', { environment: '${environment}', planOnly: true }],
        listSeedRuns: [25],
        exportSeed: ['${fixtures.team.id}', { includeSecrets: false }],
        enqueueAgentTask: ['${fixtures.project.id}', { agentId: 'acceptance-agent', type: 'plan', taskSignature: 'proposal.draft', estimatedCreditsP50: 1, estimatedCreditsP90: 1, idempotencyKey: 'acceptance-${runNonce}-agent-task', payload: { planOnly: true, runNonce: '${runNonce}' } }],
        catalog: ['template'],
        artifactDownload: ['${fixtures.catalogItem.id}', '${fixtures.catalogArtifact.version}'],
    };
    return args[method] ?? [];
}

export function actorForSdkMethod(method, descriptor) {
    if (method.startsWith('webSign') || method === 'startDeviceLogin' || method === 'pollDeviceLogin' || method === 'refreshToken' || method === 'checkWebUsername' || method === 'checkWebEmail' || method === 'authProviders' || method === 'requestWebPasswordReset' || method === 'completeWebPasswordReset' || method === 'currentMarket') {
        return 'anonymous';
    }
    if (descriptor?.authClass === 'platform-admin' || method.includes('Seed'))
        return 'siteAdmin';
    if (method.includes('Capacity') || method.includes('Provider') || method.includes('Grant'))
        return 'teamOwner';
    return 'teamOwner';
}

export function expandSdkMethodMatrices(spec, expectedStatuses = loadExpectedStatuses(spec.expectedStatuses), caseId = '') {
    if (spec.coverage?.requireAllSdkMethods !== true && !spec.sdkMethodMatrices)
        return [];
    const explicit = Array.isArray(spec.sdkMethodMatrices) ? spec.sdkMethodMatrices : [];
    const expanded = [];
    for (const [method, descriptorId] of Object.entries(SDK_METHOD_ROUTE_MAP)) {
        if ((spec.coverage?.exemptSdkMethods ?? []).includes(method))
            continue;
        const descriptor = API_ROUTE_DESCRIPTORS.find((entry) => entry.id === descriptorId);
        const matrixOverride = explicit.find((entry) => entry.method === method || entry.sdkMethod === method) ?? {};
        const actor = matrixOverride.actor ?? actorForSdkMethod(method, descriptor);
        const id = matrixOverride.id ?? `sdk.${method}.${actor}`;
        if (!matchesCaseFilter(caseId, id))
            continue;
        const expected = matrixOverride.expect ?? expectedForDescriptor(descriptor ?? { acceptance: { successActors: [actor] } }, actor, expectedStatuses);
        expanded.push({
            id,
            actor,
            sdkMethod: method,
            sdkArgs: matrixOverride.sdkArgs ?? sdkArgsForMethod(method),
            expect: expected,
            descriptorId,
            environments: matrixOverride.environments,
        });
    }
    return expanded;
}

export function assertCoverage(spec, cases) {
    const required = Array.isArray(spec.coverage?.requiredCaseIds) ? spec.coverage.requiredCaseIds : [];
    const ids = new Set(cases.map((entry) => entry.id));
    const missing = required.filter((id) => !ids.has(id));
    if (missing.length > 0) {
        throw new Error(`Acceptance spec is missing required case ids: ${missing.join(', ')}`);
    }
    if (spec.coverage?.requireAllDescriptors) {
        const coveredDescriptors = new Set(cases.map((entry) => entry.descriptorId).filter(Boolean));
        const missingDescriptors = API_ROUTE_DESCRIPTORS
            .filter((descriptor) => !coveredDescriptors.has(descriptor.id))
            .filter((descriptor) => !(spec.coverage.exemptDescriptorIds ?? []).includes(descriptor.id));
        if (missingDescriptors.length > 0) {
            throw new Error(`Acceptance spec is missing descriptor coverage for: ${missingDescriptors.map((entry) => entry.id).join(', ')}`);
        }
    }
    if (spec.coverage?.requireAllSdkMethods) {
        const mappedSdkMethods = new Set(cases.map((entry) => entry.sdkMethod).filter(Boolean));
        const missingSdkMethods = Object.keys(SDK_METHOD_ROUTE_MAP)
            .filter((method) => !mappedSdkMethods.has(method))
            .filter((method) => !(spec.coverage.exemptSdkMethods ?? []).includes(method));
        if (missingSdkMethods.length > 0) {
            throw new Error(`Acceptance spec is missing SDK method cases for: ${missingSdkMethods.join(', ')}`);
        }
    }
    const looseGenerated = cases
        .filter((entry) => entry.id?.startsWith?.('descriptor-executable-role-matrix.'))
        .filter((entry) => Array.isArray(entry.expect?.statusAny));
    if (looseGenerated.length > 0) {
        throw new Error(`Descriptor-generated acceptance cases must use exact statuses, found loose cases: ${looseGenerated.slice(0, 10).map((entry) => entry.id).join(', ')}`);
    }
}

export function junit(report) {
    const failures = report.results.filter((result) => !result.ok);
    const escape = (value) => String(value ?? '').replace(/[<>&"']/gu, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[char]));
    return [
        `<?xml version="1.0" encoding="UTF-8"?>`,
        `<testsuite name="api-acceptance" tests="${report.results.length}" failures="${failures.length}">`,
        ...report.results.map((result) => result.ok
            ? `  <testcase classname="market.acceptance" name="${escape(result.id)}" time="${result.durationMs / 1000}" />`
            : `  <testcase classname="market.acceptance" name="${escape(result.id)}" time="${result.durationMs / 1000}"><failure>${escape(result.failures.join('\\n'))}</failure></testcase>`),
        `</testsuite>`,
    ].join('\n');
}

export function caseNeedsIsolatedSession(caseSpec) {
    return caseSpec.descriptorId === 'post.v1.auth.logout'
        || caseSpec.sdkMethod === 'logout';
}
