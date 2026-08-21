

export function bodyForFactory(factory, descriptor, actor) {
    if (!factory || factory === 'empty')
        return undefined;
    const stamp = 'acc-${runNonce}';
    const actorEmail = `treeseed+\${seed.namespace}-${String(actor).replace(/[^a-z0-9-]+/giu, '-').replace(/^-+|-+$/gu, '').toLowerCase() || 'actor'}@treeseed.ai`;
    const byFactory = {
		operatorRead: {
			schemaVersion: 'treeseed.operator-command-request/v1',
			commandPath: ['capacity', 'status'],
			arguments: [], options: {}, mode: 'execute',
			context: { team: '${fixtures.team.id}' },
		},
		operatorMutation: {
			schemaVersion: 'treeseed.operator-command-request/v1',
			commandPath: ['workdays', 'cancel'],
			arguments: ['acceptance-workday'], options: {}, mode: 'plan',
			context: { team: '${fixtures.team.id}' },
		},
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
        accountPreferences: { timeZone: 'UTC' },
        webEmail: { email: actorEmail },
        feedback: {
            type: 'bug',
            message: `Acceptance ${actor} feedback.`,
			allowContact: false,
            context: {
				canonicalPath: '/app/',
				capabilityId: 'admin.feedback.submit',
				source: 'page',
            },
            client: {
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
        approvalDecision: { state: 'approved', decision: { acceptance: true } },
        runnerProjectBody: { enabled: true },
        workPolicy: { environment: 'local', enabled: true, dailyCreditBudget: 1 },
        priorityOverride: { priority: 1, reason: 'Acceptance fixture.' },
        agentTask: { agentId: 'acceptance-agent', type: 'plan', payload: { planOnly: true } },
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
