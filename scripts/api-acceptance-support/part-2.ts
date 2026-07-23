import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import { ACCEPTANCE_ACTORS, API_ROUTE_DESCRIPTORS, SDK_METHOD_ROUTE_MAP } from '../../src/api/route-descriptors.ts';
import { parseArgs, isLoopbackAcceptanceUrl, assertAcceptanceTarget, matchesCaseFilter, loadExpectedStatuses, deepMerge, loadSpec, interpolate, equalJsonValue, actorHeaders, loadMarketClient, serviceHeaders, optionalAcceptanceServiceHeaders, addOptionalAcceptanceServiceHeaders, usesHostedAcceptanceEmailBypass, acceptanceRequestTimeoutMs, acceptanceRequestAttempts, retryDelayMs, isRetryableFetchError, isRetryableResponse, sanitizeDiagnosticValue, fetchWithTimeout, getPath, mailpitMessages, mailpitMessageSubject, mailpitMessageRecipients, assertMailpitExpectation, assertCase, expandRoleMatrices, expandDescriptorMatrices, sdkArgsForMethod, actorForSdkMethod, expandSdkMethodMatrices, assertCoverage, junit, caseNeedsIsolatedSession, actorForCase, main } from './index.js';

export function fixtureValue(name) {
    const map = {
        teamId: '${fixtures.team.id}',
        projectId: '${fixtures.project.id}',
        providerId: '${fixtures.provider.id}',
        operationId: '${fixtures.platformOperation.id}',
        itemId: '${fixtures.catalogItem.id}',
        artifactId: '${fixtures.catalogArtifact.id}',
        runId: '${fixtures.seedRun.id}',
        sessionId: '${fixtures.session.id}',
        membershipId: '${fixtures.membership.id}',
        inviteId: '${fixtures.invite.id}',
        hostId: 'acceptance-hostId',
        environmentId: '${fixtures.environment.id}',
        requestId: '${fixtures.approvalRequest.id}',
        vendorId: 'acceptance-vendorId',
        productId: 'acceptance-productId',
        offerId: 'acceptance-offerId',
        priceId: 'acceptance-priceId',
        taskId: '${fixtures.task.id}',
        jobId: '${fixtures.job.id}',
        executionProviderId: '${fixtures.provider.id}:codex-subscription:acceptance-native-capacity',
        collection: 'decisions',
        version: '${fixtures.catalogArtifact.version}',
        username: '${actors.teamOwner.username}',
        name: 'acceptance',
    };
    return map[name] ?? `acceptance-${name}`;
}

export function descriptorPath(descriptor) {
    return descriptor.path.replace(/:([A-Za-z0-9_]+)/gu, (_, name) => fixtureValue(name));
}

export function bodyForFactory(factory, descriptor, actor) {
    if (!factory || factory === 'empty')
        return undefined;
    const stamp = 'acc-${runNonce}';
    const actorEmail = `treeseed+\${seed.namespace}-${String(actor).replace(/[^a-z0-9-]+/giu, '-').replace(/^-+|-+$/gu, '').toLowerCase() || 'actor'}@treeseed.ai`;
    const byFactory = {
        deviceStart: { clientId: 'treeseed-acceptance', scopes: ['auth:me'] },
        devicePoll: { deviceCode: `acceptance-device-${stamp}` },
        deviceApprove: { deviceCode: `acceptance-device-${stamp}` },
        refreshToken: { refreshToken: `acceptance-refresh-${stamp}` },
        webSignUp: {
            email: `treeseed+${stamp}-${actor}-signup@treeseed.ai`,
            username: `${stamp}-${actor}-signup`,
            password: '${seed.password}',
            name: `Acceptance ${actor}`,
        },
        emailConfirm: { token: `acceptance-confirm-${stamp}` },
        webSignIn: { email: '${actors.siteAdmin.email}', password: '${seed.password}' },
        sessionRevoke: {},
        webProfile: { name: `Acceptance ${actor}` },
        webAppearance: { colorScheme: 'fern', themeMode: 'system' },
        webEmail: { email: actorEmail },
        feedback: {
            type: 'bug',
            message: `Acceptance ${actor} feedback.`,
            context: {
                url: 'https://market.example.com/knowledge/',
                canonicalPath: '/knowledge/',
                title: 'Acceptance feedback',
                shell: 'public',
                context: 'public',
                allowAnonymous: true,
                screenshotPolicy: 'optional',
                attachmentStoragePolicy: 'public',
            },
            client: {
                url: 'https://market.example.com/knowledge/',
                viewport: { width: 1280, height: 720, devicePixelRatio: 1 },
            },
        },
        webPassword: { currentPassword: '${seed.password}', password: '${seed.password}' },
        passwordResetRequest: { email: '${actors.teamOwner.email}' },
        passwordResetComplete: { token: '${fixtures.passwordReset.token}', password: '${seed.password}' },
        platformOperationCreate: {
            namespace: 'market',
            operation: 'noop',
            target: 'market_operations_runner',
            idempotencyKey: `acceptance-${stamp}-${actor}`,
            input: { acceptance: true, actor },
        },
        platformOperationCancel: {},
        platformOperationRetry: { inputPatch: { retriedBy: actor } },
        platformRunnerRegister: {
            runnerId: '${fixtures.platformRunner.id}',
            name: 'Acceptance Platform Runner',
            environment: '${environment}',
            capabilities: ['market:noop'],
            maxConcurrentJobs: 1,
        },
        platformRunnerHeartbeat: {
            runnerId: '${fixtures.platformRunner.id}',
            environment: '${environment}',
            status: 'online',
            activeJobCount: 0,
            maxConcurrentJobs: 1,
        },
        platformRunnerClaim: { runnerId: '${fixtures.platformRunner.id}', operationId: '${fixtures.platformOperation.id}', leaseSeconds: 30 },
        platformRunnerEvent: { runnerId: '${fixtures.platformRunner.id}', event: { kind: 'acceptance.event', data: { actor } } },
        platformRunnerCheckpoint: { runnerId: '${fixtures.platformRunner.id}', output: { acceptance: true }, event: { kind: 'acceptance.checkpoint' } },
        platformRunnerRenew: { runnerId: '${fixtures.platformRunner.id}', leaseSeconds: 30, event: { kind: 'acceptance.renew' } },
        platformRunnerCancel: { runnerId: '${fixtures.platformRunner.id}', event: { kind: 'acceptance.cancel' } },
        platformRunnerComplete: { runnerId: '${fixtures.platformRunner.id}', output: { acceptance: true }, event: { kind: 'acceptance.complete' } },
        platformRunnerFail: { runnerId: '${fixtures.platformRunner.id}', error: { message: 'Acceptance failure fixture.' }, event: { kind: 'acceptance.fail' } },
        projectCreate: { slug: `${stamp}-${actor}-project`, name: `Acceptance ${actor} Project`, description: 'Acceptance fixture project.' },
        projectLaunch: { name: `Acceptance ${actor} Launch`, slug: `${stamp}-${actor}-launch`, sourceKind: 'acceptance_unsupported' },
        teamInvite: { email: `treeseed+${stamp}-${actor}-invite@treeseed.ai`, roleKey: 'reviewer' },
        teamMemberUpdate: { roleKey: 'reviewer' },
        repositoryHost: { provider: 'github', owner: 'treeseed-acceptance', name: 'fixture', defaultBranch: 'main' },
        webHost: { provider: 'railway', name: `acceptance-${actor}`, environment: '${environment}' },
        hostValidate: { provider: 'railway', token: 'redacted-acceptance-token' },
        capacityProviderCreate: { name: `Acceptance ${actor} Provider`, launchMode: 'self_hosted' },
        capacityProviderPatch: { name: `Acceptance ${actor} Provider` },
        capacityProviderDeployment: { launchMode: 'self_hosted' },
        executionProvider: {
            name: `Acceptance ${actor} Native Capacity`,
            kind: 'codex',
            nativeUnit: 'wall_minute',
            quotaVisibility: 'opaque',
            maxConcurrentWorkers: 1,
            nativeLimits: [{ scope: 'daily', nativeUnit: 'wall_minute', limitAmount: 60, reserveBufferPercent: 20 }],
        },
        executionProviderNativeLimit: { scope: 'daily', nativeUnit: 'wall_minute', limitAmount: 60, reserveBufferPercent: 20 },
        capacityGrant: { projectId: '${fixtures.project.id}', environment: 'local', dailyCreditBudget: 1 },
        providerCredentialSession: { purpose: 'deploy_capacity_provider', hostKind: 'capacity_provider_host' },
        hostingAudit: { environment: '${environment}' },
        seedExport: { includeSecrets: false },
        teamCreate: { slug: `${stamp}-${actor}-team`, name: `Acceptance ${actor} Team` },
        commonsQuestion: {
            title: `Acceptance ${actor} Commons Question`,
            body: 'How should TreeSeed prioritize cooperative governance improvements?',
        },
        commonsQuestionAnswer: {
            answer: 'Acceptance steward answer.',
        },
        commonsProposal: {
            title: `Acceptance ${actor} Commons Proposal`,
            summary: 'Acceptance proposal summary.',
            body: 'Acceptance proposal body with evidence and expected outcomes.',
            scope: 'treeseed_commons',
            decisionType: 'advisory',
        },
        commonsBacking: { reason: 'Acceptance backing.' },
        commonsVote: { vote: 'support', reason: 'Acceptance vote.' },
        commonsDecision: { reason: 'Acceptance Commons decision.', evidence: { acceptance: true } },
        commonsStewardDecision: {
            status: 'accepted',
            reason: 'Acceptance steward decision.',
            evidence: { acceptance: true },
            capacityBudget: 'acceptance',
        },
        commonsDelegation: {
            toParticipantId: '${fixtures.commonsParticipant.id}',
            scope: 'treeseed_commons',
            reason: 'Acceptance delegation.',
        },
        commerceVendorRequest: { displayName: `Acceptance ${actor} Vendor`, slug: `${stamp}-${actor}-vendor`, reason: 'Acceptance vendor capability request.' },
        commerceVendorApproval: { trustLevel: 'verified_seller', salesEnabled: true, reason: 'Acceptance vendor approval.' },
        commerceStripeOnboarding: {
            returnUrl: 'https://market.example.com/app/teams/${fixtures.team.id}/commerce?stripe=returned',
            refreshUrl: 'https://market.example.com/app/teams/${fixtures.team.id}/commerce?stripe=refresh',
        },
        commerceProductDraft: {
            sellerTeamId: '${fixtures.team.id}',
            kind: 'template',
            slug: `${stamp}-${actor}-commerce-product`,
            title: `Acceptance ${actor} Product`,
            summary: 'Acceptance commerce product.',
            visibility: 'public',
            ownershipModel: 'cooperative_owned',
            ownership: {
                model: 'cooperative_owned',
                canonicalOwnerType: 'cooperative',
                canonicalOwnerId: `acceptance-${stamp}-cooperative`,
                publicSummary: 'Acceptance cooperative owner.',
            },
        },
        commerceOwnership: {
            model: 'cooperative_owned',
            canonicalOwnerType: 'cooperative',
            canonicalOwnerId: `acceptance-${stamp}-cooperative`,
            publicSummary: 'Acceptance cooperative ownership.',
        },
        commerceSteward: {
            role: 'governance_steward',
            assigneeType: 'team',
            assigneeId: '${fixtures.team.id}',
            responsibilities: ['acceptance governance'],
        },
        commerceContribution: {
            contributorType: 'team',
            contributorId: '${fixtures.team.id}',
            role: 'acceptance_contributor',
            summary: 'Acceptance contribution.',
            benefitWeight: 0.5,
        },
        commerceGovernancePolicy: {
            policyKind: 'cooperative',
            title: 'Acceptance Commerce Governance Policy',
            approvalRules: { acceptance: true },
            quorumRules: { acceptance: true },
            buyerVisibleSummary: 'Acceptance governance summary.',
            status: 'active',
        },
        commerceOwnershipTransfer: {
            fromOwnershipRecordId: 'acceptance-from-ownership',
            toOwnershipRecordId: 'acceptance-to-ownership',
            reason: 'Acceptance ownership transfer.',
            approvalEvidence: { acceptance: true },
        },
        commerceOwnershipUpdate: {
            publicSummary: 'Updated acceptance cooperative ownership.',
            buyerVisible: true,
            reason: 'Acceptance ownership update.',
        },
        commerceStewardUpdate: {
            displayName: 'Acceptance Governance Steward',
            responsibilities: ['updated acceptance governance'],
            visibleToBuyers: true,
            reason: 'Acceptance stewardship update.',
        },
        commerceStewardEnd: {
            reason: 'Acceptance stewardship ended.',
        },
        commerceContributionUpdate: {
            summary: 'Updated acceptance contribution.',
            attributionVisibility: 'buyer',
            benefitWeight: 0.75,
            reason: 'Acceptance contribution update.',
        },
        commerceGovernancePolicyUpdate: {
            title: 'Updated Acceptance Commerce Governance Policy',
            approvalRules: { updated: true },
            quorumRules: { updated: true },
            buyerVisibleSummary: 'Updated acceptance governance summary.',
            status: 'active',
            reason: 'Acceptance governance policy update.',
        },
        commerceOwnershipTransferDecision: {
            reason: 'Acceptance ownership transfer decision.',
            evidence: { acceptance: true },
        },
        commerceSuccessionEvent: {
            successorType: 'team',
            successorId: '${fixtures.team.id}',
            eventType: 'successor_named',
            reason: 'Acceptance succession event.',
        },
        commerceProductVersion: {
            version: `0.0.0-${stamp}`,
            artifactKey: `acceptance/${stamp}/artifact.tar`,
            manifestKey: `acceptance/${stamp}/manifest.json`,
            integrity: 'sha256:acceptance',
        },
        commerceOffer: {
            productId: 'acceptance-productId',
            mode: 'subscription_updates',
            title: `Acceptance ${actor} Offer`,
            termsSummary: 'Acceptance offer terms.',
        },
        commercePrice: {
            amount: 100,
            currency: 'usd',
            billingInterval: 'month',
        },
        commerceCart: { buyerTeamId: '${fixtures.team.id}', metadata: { acceptance: true } },
        commerceCartItem: { offerId: '${fixtures.commerceOffer.id}', priceId: '${fixtures.commercePrice.id}', quantity: 1 },
        commerceCheckout: {
            buyerTeamId: '${fixtures.team.id}',
            items: [{ offerId: '${fixtures.commerceOffer.id}', priceId: '${fixtures.commercePrice.id}', quantity: 1 }],
        },
        commerceRefund: {
            amount: 100,
            reason: 'Acceptance refund.',
            idempotencyKey: `acceptance-refund-${stamp}-${actor}`,
        },
        commerceFulfillment: {
            message: 'Acceptance artifact fulfillment.',
            artifactRefs: [{ acceptance: true }],
        },
        commerceServiceRequest: {
            buyerTeamId: '${fixtures.team.id}',
            offerId: '${fixtures.commerceOffer.id}',
            requestedScope: 'Acceptance scoped service request.',
            accessNeeds: { acceptance: true },
        },
        commerceServiceRequestUpdate: {
            approvedScope: 'Updated acceptance scoped service.',
            buyerVisibleSummary: 'Acceptance buyer-visible service summary.',
            vendorPrivateNotes: 'Acceptance private seller notes.',
        },
        commerceServiceDecision: {
            reason: 'Acceptance scoped service decision.',
            evidence: { acceptance: true },
        },
        commerceServiceQuote: {
            title: 'Acceptance scoped service quote',
            scopeSummary: 'Acceptance quote scope.',
            deliverables: [{ title: 'Acceptance deliverable' }],
            assumptions: [{ title: 'Acceptance assumption' }],
            accessRequirements: { projectAccess: 'explicit_approval_required' },
            governanceRequirements: { approval: true },
            amount: 100,
            currency: 'usd',
        },
        commerceServiceContractCheckout: {
            buyerTeamId: '${fixtures.team.id}',
        },
        commerceServiceWorkLink: {
            relatedProjectId: '${fixtures.project.id}',
            relatedWorkdayId: 'acceptance-workday',
        },
        commerceServiceFulfillment: {
            summary: 'Acceptance service fulfillment.',
            deliveryRefs: [{ type: 'manual', path: '/acceptance/service-delivery' }],
        },
        commerceCapacityListing: {
            accessLevel: 'public_summary',
            runtimeIsolationLevel: 'external_only',
            humanInvolvementLevel: 'operator_assisted',
            aiInvolvementLevel: 'assistive',
            dataAccessLevel: 'buyer_provided',
            secretAccessLevel: 'buyer_managed',
            supportedServiceTypes: ['acceptance_capacity'],
            supportedRegions: ['us'],
            runtimeRequirements: { acceptance: true },
            dataHandlingSummary: 'Acceptance capacity data handling.',
            buyerVisibleRiskSummary: 'Acceptance capacity risk summary.',
            governanceRequirements: { approval: true },
            supportPolicy: 'Acceptance support policy.',
            availabilitySummary: 'Acceptance availability.',
        },
        commerceCapacityListingUpdate: {
            accessLevel: 'public_summary',
            runtimeIsolationLevel: 'project_scoped',
            humanInvolvementLevel: 'review_only',
            aiInvolvementLevel: 'assistive',
            dataAccessLevel: 'project_scoped',
            secretAccessLevel: 'buyer_managed',
            supportedServiceTypes: ['acceptance_capacity_updated'],
            buyerVisibleRiskSummary: 'Updated acceptance capacity risk summary.',
            reason: 'Acceptance capacity listing update.',
        },
        commerceCapacityListingDecision: {
            reason: 'Acceptance capacity listing decision.',
            evidence: { acceptance: true },
        },
        commerceCapacityInquiry: {
            buyerTeamId: '${fixtures.team.id}',
            requestedServiceType: 'acceptance_capacity',
            requestedScope: 'Acceptance capacity inquiry.',
            dataAccessRequested: { classification: 'acceptance' },
            secretAccessRequested: { required: false },
            relatedProjectId: '${fixtures.project.id}',
        },
        commerceCapacityInquiryDecision: {
            reason: 'Acceptance capacity inquiry decision.',
            evidence: { acceptance: true },
        },
        commerceTransition: { reason: 'Acceptance commerce transition.', evidence: { acceptance: true } },
        localContentWrite: { slug: `${stamp}-${actor}-record`, title: `Acceptance ${actor}`, body: 'Acceptance content.' },
        localContentRelated: { parent: { collection: 'decisions', slug: 'acceptance-parent' }, child: { slug: `${stamp}-${actor}-related`, title: 'Acceptance Related' } },
        decisionFromProposals: { proposalIds: [], title: `Acceptance ${actor} Decision`, summary: 'Acceptance decision.' },
        approvalDecision: { state: 'approved', decision: { acceptance: true } },
        runnerProjectBody: { enabled: true },
        workPolicy: { environment: 'local', enabled: true, dailyCreditBudget: 1 },
        priorityOverride: { priority: 1, reason: 'Acceptance fixture.' },
        agentTask: { agentId: 'acceptance-agent', type: 'plan', payload: { planOnly: true } },
        projectDeployment: { environment: 'staging', status: 'planned' },
        projectResource: { kind: 'repository', name: 'acceptance' },
        projectEnvironment: { environment: 'staging', provider: 'railway' },
        workspaceLink: { label: 'Acceptance workspace', href: 'https://example.com/acceptance' },
        updatePlan: { sourceKind: 'acceptance', sourceRef: `plan-${stamp}-${actor}`, plan: { title: 'Acceptance update plan', steps: [] } },
        shareOperation: { visibility: 'team' },
        releaseOperation: { version: `0.0.0-${stamp}` },
        workstreamOperation: { title: 'Acceptance workstream' },
        capability: { capability: 'acceptance', enabled: true },
        projectUpdate: { name: `Acceptance ${actor} Project` },
        jobOperation: { action: 'cancel' },
        seedPlan: { environment: '${environment}', planOnly: true },
    };
    return byFactory[factory] ?? { acceptance: true, descriptorId: descriptor.id, actor };
}

export function expectedForDescriptor(descriptor, actor, expectedStatuses: any = {}) {
    const policy = descriptor.acceptance ?? {};
    const successActors = new Set(policy.successActors ?? []);
    const allowed = successActors.has(actor);
    const exactStatus = expectedStatuses?.[descriptor.id]?.[actor];
    if (exactStatus == null) {
        throw new Error(`Missing exact acceptance status for ${descriptor.id} as ${actor}`);
    }
    const expectsOk = Number(exactStatus) < 400;
    const expectsEnvelope = !expectsOk
        || (descriptor?.authClass !== 'public' && descriptor?.authClass !== 'provider-key');
    return {
        status: Number(exactStatus),
        envelope: expectsEnvelope ? { ok: expectsOk } : undefined,
        json: expectsEnvelope ? [{ path: 'ok', equals: expectsOk }] : undefined,
        acceptanceRole: allowed ? 'allowed' : 'denied',
    };
}
