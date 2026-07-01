#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import { ACCEPTANCE_ACTORS, API_ROUTE_DESCRIPTORS, SDK_METHOD_ROUTE_MAP } from '../src/api/route-descriptors.ts';

function parseArgs(argv) {
	const args = {
		environment: process.env.TREESEED_ACCEPTANCE_ENVIRONMENT || process.env.TREESEED_ENVIRONMENT || 'local',
		baseUrl: process.env.TREESEED_API_BASE_URL || 'http://127.0.0.1:3000',
		spec: 'test/acceptance/api.base.yaml',
		reportJson: '',
		reportJunit: '',
		expandJson: '',
		caseId: '',
	};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === '--environment') args.environment = argv[++index];
		else if (arg === '--base-url') args.baseUrl = argv[++index];
		else if (arg === '--spec') args.spec = argv[++index];
		else if (arg === '--report-json') args.reportJson = argv[++index];
		else if (arg === '--report-junit') args.reportJunit = argv[++index];
		else if (arg === '--expand-json') args.expandJson = argv[++index];
		else if (arg === '--case') args.caseId = argv[++index];
		else if (arg === '--help' || arg === '-h') args.help = true;
	}
	return args;
}

function matchesCaseFilter(caseId, candidateId) {
	return !caseId || candidateId === caseId;
}

function loadExpectedStatuses(path = 'test/acceptance/api.expected-statuses.json') {
	if (!path || !existsSync(path)) return {};
	const parsed = JSON.parse(readFileSync(path, 'utf8'));
	return parsed.statuses ?? {};
}

function deepMerge(left, right) {
	if (Array.isArray(left) || Array.isArray(right)) return right ?? left;
	if (!left || typeof left !== 'object') return right;
	if (!right || typeof right !== 'object') return left;
	const merged = { ...left };
	for (const [key, value] of Object.entries(right)) {
		merged[key] = key in merged ? deepMerge(merged[key], value) : value;
	}
	return merged;
}

function loadSpec(path, seen = new Set()) {
	const absolute = resolve(path);
	if (seen.has(absolute)) throw new Error(`Recursive acceptance spec extends: ${absolute}`);
	seen.add(absolute);
	const doc = parse(readFileSync(absolute, 'utf8')) ?? {};
	const parentSpecs = Array.isArray(doc.extends) ? doc.extends : doc.extends ? [doc.extends] : [];
	const base = parentSpecs
		.map((entry) => loadSpec(resolve(dirname(absolute), entry), seen))
		.reduce((acc, entry) => deepMerge(acc, entry), {});
	delete doc.extends;
	return deepMerge(base, doc);
}

function interpolate(value, variables) {
	if (typeof value === 'string') {
		return value.replace(/\$\{([^}]+)\}/gu, (_, key) => {
			const parts = String(key).split('.');
			let current = variables;
			for (const part of parts) current = current?.[part];
			return current == null ? '' : String(current);
		});
	}
	if (Array.isArray(value)) return value.map((entry) => interpolate(entry, variables));
	if (value && typeof value === 'object') {
		return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, interpolate(entry, variables)]));
	}
	return value;
}

function actorHeaders(actor = {}) {
	const headers = new Headers(actor.headers ?? {});
	if (actor.token) {
		headers.set('authorization', `Bearer ${actor.token}`);
	}
	if (!actor.token && actor.tokenEnv) {
		const token = process.env[actor.tokenEnv];
		if (!token && actor.required === false) return null;
		if (!token) throw new Error(`Actor ${actor.id ?? actor.tokenEnv} requires env ${actor.tokenEnv}`);
		headers.set('authorization', `Bearer ${token}`);
	}
	return headers;
}

async function loadMarketClient() {
	try {
		return await import('../packages/sdk/dist/market-client.js');
	} catch {
		return import('@treeseed/sdk/market-client');
	}
}

function serviceHeaders(spec) {
	const environment = process.env.TREESEED_ACCEPTANCE_ENVIRONMENT || process.env.TREESEED_ENVIRONMENT || 'local';
	const serviceId = process.env[spec.seed?.serviceIdEnv ?? 'TREESEED_ACCEPTANCE_SERVICE_ID']
		?? (environment === 'local' ? process.env.TREESEED_API_WEB_SERVICE_ID ?? process.env.TREESEED_WEB_SERVICE_ID ?? 'web' : undefined);
	const serviceSecret = process.env[spec.seed?.serviceSecretEnv ?? 'TREESEED_ACCEPTANCE_SERVICE_SECRET']
		?? (environment === 'local'
			? process.env.TREESEED_API_WEB_SERVICE_SECRET ?? process.env.TREESEED_WEB_SERVICE_SECRET ?? 'treeseed-web-service-dev-secret'
			: undefined);
	if (!serviceId || !serviceSecret) {
		throw new Error('Acceptance seeding requires TREESEED_ACCEPTANCE_SERVICE_ID and TREESEED_ACCEPTANCE_SERVICE_SECRET.');
	}
	return {
		accept: 'application/json',
		'content-type': 'application/json',
		'x-treeseed-service-id': serviceId,
		'x-treeseed-service-secret': serviceSecret,
	};
}

function optionalAcceptanceServiceHeaders() {
	const serviceId = process.env.TREESEED_ACCEPTANCE_SERVICE_ID;
	const serviceSecret = process.env.TREESEED_ACCEPTANCE_SERVICE_SECRET;
	if (!serviceId || !serviceSecret) return {};
	return {
		'x-treeseed-service-id': serviceId,
		'x-treeseed-service-secret': serviceSecret,
		'x-treeseed-acceptance-email-bypass': '1',
	};
}

function acceptanceRequestTimeoutMs() {
	const value = Number.parseInt(process.env.TREESEED_ACCEPTANCE_REQUEST_TIMEOUT_MS ?? '30000', 10);
	return Number.isFinite(value) && value > 0 ? value : 30000;
}

async function fetchWithTimeout(url, init = {}, label = String(url)) {
	const timeoutMs = acceptanceRequestTimeoutMs();
	const maxAttempts = init.signal ? 1 : 2;
	let lastError = null;
	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(new Error(`Acceptance request timed out after ${timeoutMs}ms: ${label}`)), timeoutMs);
		try {
			return await fetch(url, {
				...init,
				signal: init.signal ?? controller.signal,
			});
		} catch (error) {
			if (controller.signal.aborted) {
				throw new Error(`Acceptance request timed out after ${timeoutMs}ms: ${label}`);
			}
			lastError = error;
			const code = error?.cause?.code;
			const retryable = code === 'UND_ERR_SOCKET' || code === 'ECONNRESET';
			if (!retryable || attempt >= maxAttempts) break;
			await new Promise((resolve) => setTimeout(resolve, 100));
		} finally {
			clearTimeout(timeout);
		}
	}
	const cause = lastError?.cause;
	const details = cause?.code || cause?.message
		? ` (${[cause?.code, cause?.message].filter(Boolean).join(': ')})`
		: '';
	throw new Error(`Acceptance request failed for ${label}: ${lastError?.message ?? String(lastError)}${details}`);
}

function getPath(value, path) {
	return String(path).split('.').filter(Boolean).reduce((current, part) => {
		if (current == null) return undefined;
		if (/^\d+$/u.test(part)) return current[Number(part)];
		return current[part];
	}, value);
}

function mailpitMessages(value) {
	if (!value || typeof value !== 'object') return [];
	const record = value;
	const messages = record.messages ?? record.Messages;
	return Array.isArray(messages) ? messages : [];
}

function mailpitMessageSubject(value) {
	if (!value || typeof value !== 'object') return '';
	const record = value;
	return String(record.Subject ?? record.subject ?? '');
}

function mailpitMessageRecipients(value) {
	if (!value || typeof value !== 'object') return [];
	const record = value;
	const recipients = record.To ?? record.to ?? record.Recipients ?? record.recipients;
	if (!Array.isArray(recipients)) return [];
	return recipients.map((recipient) => {
		if (typeof recipient === 'string') return recipient;
		if (!recipient || typeof recipient !== 'object') return '';
		const entry = recipient;
		return String(entry.Address ?? entry.address ?? entry.Email ?? entry.email ?? '');
	}).filter(Boolean);
}

async function assertMailpitExpectation(expectation) {
	if (!expectation) return [];
	const url = String(expectation.url ?? process.env.TREESEED_MAILPIT_URL ?? 'http://127.0.0.1:8025').replace(/\/+$/u, '');
	const to = String(expectation.to ?? '').toLowerCase();
	const subjectIncludes = expectation.subjectIncludes ? String(expectation.subjectIncludes).toLowerCase() : '';
	const timeoutMs = Number(expectation.timeoutMs ?? 5000);
	const started = Date.now();
	let lastError = '';
	while (Date.now() - started <= timeoutMs) {
		try {
			const response = await fetchWithTimeout(`${url}/api/v1/messages`, {}, 'GET Mailpit messages');
			if (!response.ok) {
				lastError = `Mailpit returned HTTP ${response.status}`;
			} else {
				const list = await response.json();
				const found = mailpitMessages(list).some((message) => {
					const recipients = mailpitMessageRecipients(message).map((entry) => entry.toLowerCase());
					const subject = mailpitMessageSubject(message).toLowerCase();
					return (!to || recipients.includes(to)) && (!subjectIncludes || subject.includes(subjectIncludes));
				});
				if (found) return [];
				lastError = `No Mailpit message found${to ? ` for ${to}` : ''}.`;
			}
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	return [`Mailpit expectation failed: ${lastError}`];
}

function assertCase(caseSpec, response, body) {
	const failures = [];
	const expectedStatus = Number(caseSpec.expect?.status ?? caseSpec.expect?.statusAny?.[0] ?? 200);
	const expectedStatuses = Array.isArray(caseSpec.expect?.statusAny)
		? caseSpec.expect.statusAny.map((entry) => Number(entry))
		: [expectedStatus];
	if (!expectedStatuses.includes(response.status)) {
		failures.push(`expected status ${expectedStatus}, got ${response.status}`);
	}
	if (caseSpec.expect?.envelope) {
		const envelope = caseSpec.expect.envelope;
		if (envelope.ok !== undefined && body?.ok !== envelope.ok) failures.push(`expected envelope ok=${envelope.ok}, got ${body?.ok}`);
	}
	for (const assertion of caseSpec.expect?.json ?? []) {
		const actual = getPath(body, assertion.path);
		if ('equals' in assertion && actual !== assertion.equals) failures.push(`${assertion.path} expected ${JSON.stringify(assertion.equals)}, got ${JSON.stringify(actual)}`);
		if ('exists' in assertion && Boolean(actual !== undefined && actual !== null) !== Boolean(assertion.exists)) failures.push(`${assertion.path} existence mismatch`);
		if ('type' in assertion && typeof actual !== assertion.type) failures.push(`${assertion.path} expected type ${assertion.type}, got ${typeof actual}`);
	}
	return failures;
}

const FORBIDDEN_DEPLOYMENT_OUTPUT = [
	'capacityProviderId',
	'laneId',
	'grantId',
	'workerPoolId',
	'runtimeHostId',
	'railwayServiceId',
	'runnerToken',
	'runner-token-secret',
	'capacity-provider-secret',
	'TREESEED_PLATFORM_RUNNER_SECRET',
	'RAILWAY_API_TOKEN',
	'TREESEED_RAILWAY_PROJECT_ID',
];

function assertNoForbiddenDeploymentOutput(value, label = 'deployment output') {
	const serialized = JSON.stringify(value);
	const failures = FORBIDDEN_DEPLOYMENT_OUTPUT
		.filter((needle) => serialized.includes(needle))
		.map((needle) => `${label} exposed forbidden field or value ${needle}`);
	return failures;
}

function expandRoleMatrices(spec, caseId = '') {
	const matrices = Array.isArray(spec.roleMatrices) ? spec.roleMatrices : [];
	const expanded = [];
	for (const matrix of matrices) {
		const actors = Array.isArray(matrix.actors) ? matrix.actors : [];
		const endpoints = Array.isArray(matrix.endpoints) ? matrix.endpoints : [];
		for (const endpoint of endpoints) {
			for (const actor of actors) {
				const id = `${matrix.id}.${endpoint.id}.${actor}`;
				if (!matchesCaseFilter(caseId, id)) continue;
				const actorOverride = endpoint.expectByActor?.[actor] ?? {};
				const expected = {
					...(matrix.expect ?? {}),
					...(endpoint.expect ?? {}),
					...actorOverride,
				};
				expanded.push({
					id,
					actor,
					method: endpoint.method ?? 'GET',
					path: endpoint.path,
					body: endpoint.body,
					expect: {
						status: expected.status ?? 200,
						envelope: expected.envelope ?? { ok: Number(expected.status ?? 200) < 400 },
						json: expected.json,
					},
					environments: endpoint.environments ?? matrix.environments,
				});
			}
		}
	}
	return expanded;
}

function expandDeploymentFlows(spec, caseId = '') {
	return (Array.isArray(spec.deploymentFlows) ? spec.deploymentFlows : [])
		.filter((flow) => matchesCaseFilter(caseId, flow.id ?? 'deployment-flow.mocked-local'))
		.map((flow) => ({
			id: flow.id ?? 'deployment-flow.mocked-local',
			actor: flow.actor ?? 'teamOwner',
			method: 'FLOW',
			path: '/v1/projects/${fixtures.project.id}/deployments/web',
			deploymentFlow: true,
			flow,
			expect: flow.expect ?? { status: 200, envelope: { ok: true } },
			environments: flow.environments,
		}));
}

function fixtureValue(name) {
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

function descriptorPath(descriptor) {
	return descriptor.path.replace(/:([A-Za-z0-9_]+)/gu, (_, name) => fixtureValue(name));
}

function bodyForFactory(factory, descriptor, actor) {
	if (!factory || factory === 'empty') return undefined;
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
		providerRegister: {
			providerId: '${fixtures.provider.id}',
			runtime: { name: '@treeseed/agent', version: 'acceptance' },
			capabilities: [{ id: 'acceptance-dry-run', kind: 'agent' }],
			budgets: { dailyCredits: 1 },
			health: { ok: true, status: 'acceptance' },
		},
		providerHeartbeat: { providerId: '${fixtures.provider.id}', ok: true, status: 'active', queueDepth: 0, activeWorkers: 0 },
		providerWorkday: { providerId: '${fixtures.provider.id}', projectId: '${fixtures.project.id}', workday: { id: '${fixtures.workday.id}', status: 'active' } },
		providerTaskClaim: { providerId: '${fixtures.provider.id}', maxTasks: 1 },
		providerTaskEvent: { providerId: '${fixtures.provider.id}', event: { kind: 'acceptance.event', data: {} } },
		providerTaskComplete: { providerId: '${fixtures.provider.id}', result: { ok: true }, usage: { credits: 0 } },
		providerTaskFail: { providerId: '${fixtures.provider.id}', error: { code: 'acceptance', message: 'Acceptance failure fixture.' } },
		providerUsage: { providerId: '${fixtures.provider.id}', records: [{ id: `usage-${stamp}`, credits: 0, unit: 'dry_run' }] },
		providerReport: { providerId: '${fixtures.provider.id}', report: { id: `report-${stamp}`, status: 'ok', summary: 'Acceptance report.' } },
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
			kind: 'codex_subscription',
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
		agentTask: { agentId: 'acceptance-agent', type: 'dry_run', payload: { dryRun: true } },
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
		seedPlan: { environment: '${environment}', dryRun: true },
	};
	return byFactory[factory] ?? { acceptance: true, descriptorId: descriptor.id, actor };
}

function expectedForDescriptor(descriptor, actor, expectedStatuses = {}) {
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

function expandDescriptorMatrices(spec, expectedStatuses = loadExpectedStatuses(spec.expectedStatuses), caseId = '') {
	const matrices = Array.isArray(spec.descriptorMatrices) ? spec.descriptorMatrices : [];
	const expanded = [];
	for (const matrix of matrices) {
		const actors = Array.isArray(matrix.actors) ? matrix.actors : [];
		const methods = new Set(Array.isArray(matrix.methods) ? matrix.methods.map((entry) => String(entry).toUpperCase()) : ['GET']);
		const domains = new Set(Array.isArray(matrix.ownerDomains) ? matrix.ownerDomains : []);
		const authClasses = new Set(Array.isArray(matrix.authClasses) ? matrix.authClasses : []);
		const ids = new Set(Array.isArray(matrix.ids) ? matrix.ids : []);
		for (const descriptor of API_ROUTE_DESCRIPTORS) {
			if (ids.size > 0 && !ids.has(descriptor.id)) continue;
			if (ids.size === 0 && !methods.has(descriptor.method)) continue;
			if (domains.size > 0 && !domains.has(descriptor.ownerDomain)) continue;
			if (authClasses.size > 0 && !authClasses.has(descriptor.authClass)) continue;
			if (matrix.excludeProviderIngress !== false && descriptor.providerIngress) continue;
			if (matrix.excludeInternalRunner !== false && descriptor.internalRunner) continue;
			for (const actor of actors) {
				const id = `${matrix.id}.${descriptor.id}.${actor}`;
				if (!matchesCaseFilter(caseId, id)) continue;
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

function sdkArgsForMethod(method) {
	const stamp = 'acc-${runNonce}';
	const args = {
		startDeviceLogin: [{ clientId: 'treeseed-acceptance', scopes: ['auth:me'] }],
		pollDeviceLogin: [{ deviceCode: `acceptance-device-${stamp}` }],
		refreshToken: [{ refreshToken: `acceptance-refresh-${stamp}` }],
		logout: [],
		webSignUp: [{ email: `treeseed+${stamp}-sdk-signup@treeseed.ai`, username: `${stamp}-sdk-signup`, password: '${seed.password}', name: 'Acceptance SDK' }],
		webSignIn: [{ email: '${actors.siteAdmin.email}', password: '${seed.password}' }],
		checkWebUsername: ['${actors.teamOwner.username}'],
		webEmails: [],
		webSessions: [],
		addWebEmail: [{ email: '${actors.teamOwner.email}' }],
		confirmWebEmail: [{ token: '' }],
		verifyWebEmail: ['missing-email'],
		setPrimaryWebEmail: ['missing-email'],
		deleteWebEmail: ['missing-email'],
		revokeWebSession: ['${fixtures.session.id}'],
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
		teamMembers: ['${fixtures.team.id}'],
		teamPermissions: ['${fixtures.team.id}'],
		projects: ['${fixtures.team.id}'],
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
		dispatchProjectWorkflowOperation: ['${fixtures.project.id}', 'missing-operation', { mockExternal: true }],
		initializeProjectRepository: ['${fixtures.project.id}', 'software', { mockExternal: true }],
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
		teamCapacity: ['${fixtures.team.id}'],
		teamCapacityProviders: ['${fixtures.team.id}'],
		updateCapacityProvider: ['${fixtures.team.id}', '${fixtures.provider.id}', { name: 'Acceptance SDK Provider' }],
		launchManagedCapacityProvider: ['${fixtures.team.id}', { name: 'Acceptance SDK Managed Provider', launchMode: 'self_hosted' }],
		capacityProvider: ['${fixtures.provider.id}'],
		rotateCapacityProviderApiKey: ['${fixtures.team.id}', '${fixtures.provider.id}'],
		capacityGrants: ['${fixtures.team.id}'],
		createCapacityGrant: ['${fixtures.team.id}', { projectId: '${fixtures.project.id}', environment: '${environment}', dailyCreditBudget: 1000 }],
		executionProviders: ['${fixtures.team.id}', '${fixtures.provider.id}'],
		createExecutionProvider: ['${fixtures.team.id}', '${fixtures.provider.id}', {
			id: '${fixtures.provider.id}:codex-subscription:acceptance-native-capacity',
			name: 'Acceptance SDK Native Capacity',
			kind: 'codex_subscription',
			nativeUnit: 'wall_minute',
			quotaVisibility: 'opaque',
			maxConcurrentWorkers: 1,
			nativeLimits: [{ scope: 'daily', nativeUnit: 'wall_minute', limitAmount: 60, reserveBufferPercent: 20 }],
		}],
		updateExecutionProvider: ['${fixtures.team.id}', '${fixtures.provider.id}', '${fixtures.provider.id}:codex-subscription:acceptance-native-capacity', {
			name: 'Acceptance SDK Native Capacity',
			kind: 'codex_subscription',
			nativeUnit: 'wall_minute',
			quotaVisibility: 'opaque',
			maxConcurrentWorkers: 1,
		}],
		createExecutionProviderNativeLimit: ['${fixtures.team.id}', '${fixtures.provider.id}', '${fixtures.provider.id}:codex-subscription:acceptance-native-capacity', {
			scope: 'daily',
			nativeUnit: 'wall_minute',
			limitAmount: 60,
			reserveBufferPercent: 20,
		}],
		capacityAllocationSets: ['${fixtures.team.id}'],
		createCapacityAllocationSet: ['${fixtures.team.id}', {
			version: 'acceptance-${runNonce}',
			status: 'draft',
			policy: { mode: 'acceptance' },
			slices: [],
			metadata: { acceptance: true, runNonce: '${runNonce}' },
		}],
		capacityAllocationSet: ['${fixtures.team.id}', 'missing-allocation-set'],
		activateCapacityAllocationSet: ['${fixtures.team.id}', 'missing-allocation-set'],
		providerAvailabilitySessions: ['${fixtures.team.id}', { providerId: '${fixtures.provider.id}' }],
		providerAssignments: ['${fixtures.team.id}', { providerId: '${fixtures.provider.id}', projectId: '${fixtures.project.id}' }],
		createProviderAssignment: ['${fixtures.team.id}', {
			projectId: '${fixtures.project.id}',
			capacityProviderId: '${fixtures.provider.id}',
			projectAgentClassId: 'missing-agent-class',
			agentId: 'acceptance-agent',
			mode: 'planning',
			environment: 'local',
		}],
		providerAssignmentExplanation: ['${fixtures.team.id}', 'missing-assignment'],
		projectCapacityPlan: ['${fixtures.project.id}', 'staging'],
		createCapacityReservation: ['${fixtures.project.id}', {}],
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
		}],
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
		workdayRun: ['${fixtures.team.id}', '${fixtures.workdayTestRun.id}'],
		updateWorkdayRun: ['${fixtures.team.id}', '${fixtures.workdayTestRun.id}', {
			status: 'running',
			summary: { acceptance: true, runNonce: '${runNonce}' },
		}],
		workdayEvents: ['${fixtures.team.id}', '${fixtures.workdayTestRun.id}'],
		createWorkdayEvent: ['${fixtures.team.id}', '${fixtures.workdayTestRun.id}', {
			eventType: 'acceptance',
			status: 'recorded',
			title: 'Acceptance event',
			message: 'Acceptance workday event.',
			parameters: { runNonce: '${runNonce}' },
		}],
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
		planSeed: ['acceptance', { environment: '${environment}', dryRun: true }],
		applySeed: ['acceptance', { environment: '${environment}', dryRun: true }],
		listSeedRuns: [25],
		exportSeed: ['${fixtures.team.id}', { includeSecrets: false }],
		enqueueAgentTask: ['${fixtures.project.id}', { agentId: 'acceptance-agent', type: 'dry_run', taskSignature: 'proposal.draft', estimatedCreditsP50: 1, estimatedCreditsP90: 1, idempotencyKey: 'acceptance-${runNonce}-agent-task', payload: { dryRun: true, runNonce: '${runNonce}' } }],
		catalog: ['template'],
		artifactDownload: ['${fixtures.catalogItem.id}', '${fixtures.catalogArtifact.version}'],
	};
	return args[method] ?? [];
}

function actorForSdkMethod(method, descriptor) {
	if (method.startsWith('webSign') || method === 'startDeviceLogin' || method === 'pollDeviceLogin' || method === 'refreshToken' || method === 'checkWebUsername' || method === 'requestWebPasswordReset' || method === 'completeWebPasswordReset' || method === 'currentMarket') {
		return 'anonymous';
	}
	if (descriptor?.authClass === 'platform-admin' || method.includes('Seed')) return 'siteAdmin';
	if (method.includes('Capacity') || method.includes('Provider') || method.includes('Grant')) return 'teamOwner';
	return 'teamOwner';
}

function expandSdkMethodMatrices(spec, expectedStatuses = loadExpectedStatuses(spec.expectedStatuses), caseId = '') {
	if (spec.coverage?.requireAllSdkMethods !== true && !spec.sdkMethodMatrices) return [];
	const explicit = Array.isArray(spec.sdkMethodMatrices) ? spec.sdkMethodMatrices : [];
	const expanded = [];
	for (const [method, descriptorId] of Object.entries(SDK_METHOD_ROUTE_MAP)) {
		if ((spec.coverage?.exemptSdkMethods ?? []).includes(method)) continue;
		const descriptor = API_ROUTE_DESCRIPTORS.find((entry) => entry.id === descriptorId);
		const matrixOverride = explicit.find((entry) => entry.method === method || entry.sdkMethod === method) ?? {};
		const actor = matrixOverride.actor ?? actorForSdkMethod(method, descriptor);
		const id = matrixOverride.id ?? `sdk.${method}.${actor}`;
		if (!matchesCaseFilter(caseId, id)) continue;
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

function assertCoverage(spec, cases) {
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

async function requestAcceptanceJson({ variables, actors, actorId, method = 'GET', path, body }) {
	const actor = actors[actorId ?? 'anonymous'] ?? {};
	const headers = actorHeaders(actor);
	if (!headers) {
		throw new Error(`Actor ${actorId} is unavailable for acceptance request ${method} ${path}.`);
	}
	headers.set('accept', 'application/json');
	if (body !== undefined) headers.set('content-type', 'application/json');
	const response = await fetchWithTimeout(`${variables.baseUrl}${path}`, {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body),
	}, `${method} ${path}`);
	const envelope = await response.json().catch(() => null);
	if (!response.ok || envelope?.ok === false) {
		throw new Error(`${method} ${path} failed with ${response.status}: ${JSON.stringify(envelope)}`);
	}
	return { response, body: envelope };
}

function runMockedDeploymentRunner({ variables, actors, flow, args, operationId = null }) {
	const runnerActor = actors[flow.runnerActor ?? 'platformRunner'] ?? {};
	const runnerSecret = runnerActor.token ?? process.env.TREESEED_PLATFORM_RUNNER_SECRET ?? 'treeseed-platform-runner-dev-secret';
	const databaseUrl = process.env.TREESEED_DATABASE_URL ?? 'postgresql://treeseed:treeseed-local-dev@127.0.0.1:54329/treeseed_api';
	const market = flow.market ?? args.environment ?? 'local';
	const runnerDataDir = variables.fixtures?.platformRunner?.metadata?.dataDir
		?? resolve(process.cwd(), '.treeseed/acceptance-runners', String(market || 'local'));
	const runnerArgs = [
		'./dist/operations-runner/entrypoint.js',
		'once',
		'--operation',
		'project:web_deployment',
		...(operationId ? ['--operation-id', operationId] : []),
		'--mock-external',
		'--mock-result',
		flow.mockResult ?? 'success',
	];
	const result = spawnSync(process.execPath, runnerArgs, {
		cwd: process.cwd(),
		encoding: 'utf8',
		env: {
			...process.env,
			TREESEED_API_BASE_URL: variables.baseUrl,
			TREESEED_DATABASE_URL: databaseUrl,
			TREESEED_URL: variables.baseUrl,
			TREESEED_MANAGER_ID: market,
				TREESEED_PLATFORM_RUNNER_API_TRANSPORT: 'http',
				TREESEED_PLATFORM_RUNNER_DATA_DIR: runnerDataDir,
				TREESEED_PLATFORM_RUNNER_SECRET: runnerSecret,
				TREESEED_PLATFORM_RUNNER_ID: variables.fixtures?.platformRunner?.id ?? `treeseed-ops-${market}-1`,
			},
	});
	if (result.status !== 0) {
		throw new Error(`Mocked deployment runner failed with ${result.status}.\n${result.stdout}\n${result.stderr}`);
	}
	return {
		status: result.status,
		stdout: result.stdout,
		stderr: result.stderr,
	};
}

async function runDeploymentAcceptanceFlow(caseSpec, variables, actors, args) {
	const flow = caseSpec.flow ?? {};
	const actorId = caseSpec.actor ?? flow.actor ?? 'teamOwner';
	const projectId = variables.fixtures?.project?.id;
	if (!projectId) throw new Error('Deployment acceptance flow requires fixtures.project.id.');
	const basePath = `${variables.apiVersionPath ?? '/v1'}/projects/${projectId}`;
	const failures = [];
	const firstState = await requestAcceptanceJson({
		variables,
		actors,
		actorId,
		path: `${basePath}/deployment-state`,
	});
	failures.push(...assertNoForbiddenDeploymentOutput(firstState.body, 'initial deployment state'));
	const initialState = firstState.body?.payload ?? firstState.body;
	if (initialState?.readiness?.ready !== true) {
		throw new Error(`Seeded project is not deployment-ready: ${JSON.stringify(initialState?.readiness?.blockers ?? [])}`);
	}
	const deploy = await requestAcceptanceJson({
		variables,
		actors,
		actorId,
		method: 'POST',
		path: `${basePath}/deployments/web`,
		body: {
			environment: flow.environment ?? 'staging',
			action: 'deploy_web',
			source: 'acceptance',
			idempotencyKey: `acceptance-${variables.runNonce}-deploy`,
		},
	});
	failures.push(...assertNoForbiddenDeploymentOutput(deploy.body, 'queued deployment'));
	const deploymentId = deploy.body?.payload?.deployment?.id ?? deploy.body?.deployment?.id;
	const deploymentOperationId = deploy.body?.payload?.deployment?.platformOperationId ?? deploy.body?.deployment?.platformOperationId;
	runMockedDeploymentRunner({ variables, actors, flow, args, operationId: deploymentOperationId });
	const deploymentDetail = await requestAcceptanceJson({
		variables,
		actors,
		actorId,
		path: `${basePath}/deployments/${deploymentId}`,
	});
	const completedDeployment = deploymentDetail.body?.payload?.deployment ?? deploymentDetail.body?.payload ?? deploymentDetail.body?.deployment;
	if (completedDeployment?.status !== 'succeeded') {
		throw new Error(`Mocked deployment did not succeed: ${JSON.stringify(deploymentDetail.body)}`);
	}
	failures.push(...assertNoForbiddenDeploymentOutput(deploymentDetail.body, 'completed deployment'));
	const monitor = await requestAcceptanceJson({
		variables,
		actors,
		actorId,
		method: 'POST',
		path: `${basePath}/deployments/web`,
		body: {
			environment: flow.environment ?? 'staging',
			action: 'monitor',
			source: 'acceptance',
			idempotencyKey: `acceptance-${variables.runNonce}-monitor`,
		},
	});
	failures.push(...assertNoForbiddenDeploymentOutput(monitor.body, 'queued monitor'));
	const monitorDeploymentId = monitor.body?.payload?.deployment?.id ?? monitor.body?.deployment?.id;
	const monitorOperationId = monitor.body?.payload?.deployment?.platformOperationId ?? monitor.body?.deployment?.platformOperationId;
	runMockedDeploymentRunner({ variables, actors, flow, args, operationId: monitorOperationId });
	const monitorDetail = await requestAcceptanceJson({
		variables,
		actors,
		actorId,
		path: `${basePath}/deployments/${monitorDeploymentId}`,
	});
	const completedMonitor = monitorDetail.body?.payload?.deployment ?? monitorDetail.body?.payload ?? monitorDetail.body?.deployment;
	const monitorPayload = completedMonitor?.monitor;
	if (!monitorPayload?.status) {
		throw new Error(`Mocked monitor result was not persisted: ${JSON.stringify(monitorDetail.body)}`);
	}
	failures.push(...assertNoForbiddenDeploymentOutput(monitorDetail.body, 'completed monitor'));
	const finalState = await requestAcceptanceJson({
		variables,
		actors,
		actorId,
		path: `${basePath}/deployment-state`,
	});
	const finalStateModel = finalState.body?.payload ?? finalState.body;
	const latestMonitor = finalStateModel?.latestMonitors?.[flow.environment ?? 'staging'];
	if (!latestMonitor?.monitor?.status && !latestMonitor?.status) {
		throw new Error(`Deployment state does not expose the latest monitor: ${JSON.stringify(finalStateModel?.latestMonitors ?? null)}`);
	}
	failures.push(...assertNoForbiddenDeploymentOutput(finalState.body, 'final deployment state'));
	return failures;
}

function junit(report) {
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

function caseNeedsIsolatedSession(caseSpec) {
	return caseSpec.descriptorId === 'post.v1.auth.logout'
		|| caseSpec.sdkMethod === 'logout';
}

async function actorForCase(caseSpec, actor, variables) {
	if (!caseNeedsIsolatedSession(caseSpec) || !actor?.email || !variables.seed?.password || !variables.baseUrl) {
		return actor;
	}
	const response = await fetchWithTimeout(`${variables.baseUrl}/v1/auth/web/sign-in`, {
		method: 'POST',
		headers: {
			accept: 'application/json',
			'content-type': 'application/json',
		},
		body: JSON.stringify({ email: actor.email, password: variables.seed.password }),
	}, 'POST /v1/auth/web/sign-in isolated session');
	const envelope = await response.json().catch(() => null);
	const token = envelope?.payload?.accessToken;
	return response.ok && typeof token === 'string' && token.trim()
		? { ...actor, token }
		: actor;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		console.log('Usage: npm run test:acceptance -- --environment staging|prod --base-url https://api.example.com [--spec path] [--report-json path] [--report-junit path] [--expand-json path]');
		process.exit(0);
	}
	const spec = loadSpec(args.spec);
	const expectedStatuses = loadExpectedStatuses(spec.expectedStatuses);
	const variables = {
		environment: args.environment,
		baseUrl: args.baseUrl?.replace(/\/+$/u, '') ?? '',
		runNonce: Date.now().toString(36),
		...(spec.variables ?? {}),
	};
	const actors = Object.fromEntries(Object.entries(spec.actors ?? {}).map(([id, actor]) => [id, { id, ...actor }]));
	if (spec.seed?.enabled !== false && !args.expandJson) {
		const seedBody = interpolate({
			namespace: spec.seed?.namespace ?? `acceptance-${args.environment}`,
			password: spec.seed?.password ?? undefined,
			actors: spec.seed?.actors ?? undefined,
		}, variables);
		const seedPath = spec.seed?.path ?? '/v1/acceptance/seed';
		const seedResponse = await fetchWithTimeout(`${variables.baseUrl}${seedPath}`, {
			method: 'POST',
			headers: serviceHeaders(spec),
			body: JSON.stringify(seedBody),
		}, `POST ${seedPath}`);
		const seedEnvelope = await seedResponse.json().catch(() => null);
		if (!seedResponse.ok || seedEnvelope?.ok === false) {
			throw new Error(seedEnvelope?.error ?? `Acceptance seed failed with status ${seedResponse.status}.`);
		}
		variables.fixtures = seedEnvelope.payload?.fixtures ?? {};
		variables.seed = {
			namespace: seedEnvelope.payload?.namespace,
			password: seedEnvelope.payload?.password,
		};
		for (const [id, actor] of Object.entries(seedEnvelope.payload?.actors ?? {})) {
			actors[id] = {
				...(actors[id] ?? { id }),
				id,
				token: actor.accessToken,
				email: actor.email,
				username: actor.username,
			};
		}
		variables.actors = Object.fromEntries(Object.entries(actors).map(([id, actor]) => [id, {
			email: actor.email,
			username: actor.username,
		}]));
	}
	const explicitCases = Array.isArray(spec.cases) ? spec.cases.filter((entry) => matchesCaseFilter(args.caseId, entry.id)) : [];
	const allCases = [
		...explicitCases,
		...expandDeploymentFlows(spec, args.caseId),
		...expandRoleMatrices(spec, args.caseId),
		...expandDescriptorMatrices(spec, expectedStatuses, args.caseId),
		...expandSdkMethodMatrices(spec, expectedStatuses, args.caseId),
	];
	if (!args.caseId) assertCoverage(spec, allCases);
	const cases = allCases
		.filter((entry) => !entry.environments || entry.environments.includes(args.environment))
		.filter((entry) => matchesCaseFilter(args.caseId, entry.id));
	if (args.caseId && cases.length === 0) {
		const message = `Acceptance case not found for environment ${args.environment}: ${args.caseId}`;
		if (args.reportJson) {
			mkdirSync(dirname(args.reportJson), { recursive: true });
			writeFileSync(args.reportJson, `${JSON.stringify({ ok: false, environment: args.environment, caseId: args.caseId, error: message, results: [] }, null, 2)}\n`);
		}
		console.error(message);
		process.exit(1);
	}
	if (args.expandJson) {
		mkdirSync(dirname(args.expandJson), { recursive: true });
		writeFileSync(args.expandJson, `${JSON.stringify({
			ok: true,
			environment: args.environment,
			caseCount: cases.length,
			cases: cases.map((entry) => ({
				id: entry.id,
				descriptorId: entry.descriptorId ?? null,
				actor: entry.actor ?? 'anonymous',
				method: entry.method ?? 'GET',
					path: entry.path ?? null,
					sdkMethod: entry.sdkMethod ?? null,
					deploymentFlow: entry.deploymentFlow === true,
					expect: entry.expect ?? {},
				})),
		}, null, 2)}\n`);
		console.log(`expanded ${cases.length} acceptance cases to ${args.expandJson}`);
		return;
	}
	const results = [];
	for (const rawCase of cases) {
		const caseSpec = interpolate(rawCase, variables);
		const started = Date.now();
		let response;
		let body = null;
		let failures = [];
		try {
			if (caseSpec.coverageOnly) {
				results.push({
					id: caseSpec.id,
					actor: caseSpec.actor ?? 'anonymous',
					method: caseSpec.method ?? 'GET',
					path: caseSpec.path,
					status: null,
					ok: true,
					skipped: true,
					coverageOnly: true,
					failures: [],
					durationMs: Date.now() - started,
				});
				console.log(`coverage ${caseSpec.id}`);
				continue;
			}
				if (caseSpec.deploymentFlow) {
					failures = await runDeploymentAcceptanceFlow(caseSpec, variables, actors, args);
					response = { status: failures.length > 0 ? 500 : Number(caseSpec.expect?.status ?? 200) };
					body = { ok: failures.length === 0 };
				} else {
					const actor = await actorForCase(caseSpec, actors[caseSpec.actor ?? 'anonymous'] ?? {}, variables);
					const headers = actorHeaders(actor);
					if (!headers) {
						results.push({
							id: caseSpec.id,
							actor: caseSpec.actor ?? 'anonymous',
							method: caseSpec.method ?? 'GET',
							path: caseSpec.path,
							status: null,
							ok: true,
							skipped: true,
							failures: [],
							durationMs: Date.now() - started,
						});
						console.log(`skip ${caseSpec.id} missing optional actor credential`);
						continue;
					}
					headers.set('accept', 'application/json');
					if (caseSpec.body !== undefined) headers.set('content-type', 'application/json');
					if (caseSpec.sdkMethod) {
						const { MarketClient } = await loadMarketClient();
						const sdkFetch = (url, init = {}) => {
							const sdkHeaders = new Headers(init.headers ?? {});
							for (const [key, value] of Object.entries(optionalAcceptanceServiceHeaders())) {
								sdkHeaders.set(key, value);
							}
							return fetchWithTimeout(url, { ...init, headers: sdkHeaders }, `${caseSpec.sdkMethod} ${url}`);
						};
						const client = new MarketClient({
							profile: {
								id: args.environment,
								label: args.environment,
								baseUrl: variables.baseUrl,
								kind: 'specialized',
							},
							accessToken: actor.token ?? null,
							fetchImpl: sdkFetch,
							userAgent: 'treeseed-acceptance/1',
						});
						try {
							body = await client[caseSpec.sdkMethod](...(caseSpec.sdkArgs ?? []));
							response = { status: Number(caseSpec.expect?.status ?? caseSpec.expect?.statusAny?.[0] ?? 200) };
						} catch (error) {
							if (typeof error?.status === 'number') {
								body = error.payload ?? { ok: false, error: error.message };
								response = { status: error.status };
							} else {
								throw error;
							}
						}
					} else {
						response = await fetchWithTimeout(`${variables.baseUrl}${caseSpec.path}`, {
							method: caseSpec.method ?? 'GET',
							headers,
							body: caseSpec.body === undefined ? undefined : JSON.stringify(caseSpec.body),
						}, `${caseSpec.method ?? 'GET'} ${caseSpec.path}`);
						body = await response.json().catch(() => null);
					}
					failures = assertCase(caseSpec, response, body);
					failures.push(...await assertMailpitExpectation(caseSpec.expect?.mailpit));
				}
		} catch (error) {
			failures = [error?.message ?? String(error)];
		}
		const result = {
			id: caseSpec.id,
			actor: caseSpec.actor ?? 'anonymous',
			method: caseSpec.method ?? 'GET',
			path: caseSpec.path,
			status: response?.status ?? null,
			ok: failures.length === 0,
			failures,
			durationMs: Date.now() - started,
		};
		results.push(result);
		console.log(`${result.ok ? 'ok' : 'not ok'} ${result.id} ${result.method} ${result.path}`);
		if (!result.ok) console.log(`  ${failures.join('\n  ')}`);
	}
	const report = {
		ok: results.every((result) => result.ok),
		environment: args.environment,
		baseUrl: variables.baseUrl,
		results,
	};
	if (args.reportJson) {
		mkdirSync(dirname(args.reportJson), { recursive: true });
		writeFileSync(args.reportJson, `${JSON.stringify(report, null, 2)}\n`);
	}
	if (args.reportJunit) {
		mkdirSync(dirname(args.reportJunit), { recursive: true });
		writeFileSync(args.reportJunit, `${junit(report)}\n`);
	}
	if (!report.ok) process.exit(1);
	if (!existsSync(args.spec)) process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	main().catch((error) => {
		console.error(error);
		process.exit(1);
	});
}

export {
	assertCoverage,
	bodyForFactory,
	deepMerge,
	expandDeploymentFlows,
	expandDescriptorMatrices,
	expandRoleMatrices,
	expandSdkMethodMatrices,
	loadSpec,
	sdkArgsForMethod,
};
