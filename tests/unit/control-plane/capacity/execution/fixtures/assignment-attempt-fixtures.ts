import { allocateWorkdayCapacity, compileWorkday, effectiveActivityProfileSchema, exactEntityReferenceSchema, executionNodeSchema } from '@treeseed/sdk/agent-capacity';
import { capabilityOfferDigest, capabilityOfferSchema, CORE_CAPABILITY_DEFINITIONS, type CapabilityOffer } from '@treeseed/sdk/capacity-provider';
import type { buildAssignmentAttempt } from '../../../../../../src/api/capacity/services/capacity/assignments/planning/execution/assignment-attempt-builder.ts';
import { serializeCapacityWorkdayRunRow } from '../../../../../../src/api/capacity/repositories/capacity/workdays/workday-run.ts';
import { createHash, createPublicKey, sign, type KeyObject } from 'node:crypto';
import { canonicalStandardsJson } from '@treeseed/sdk/standards';

export const sourceRef = { store: 'treedx' as const, model: 'proposal', id: 'proposal', revision: 2,
	digest: `sha256:${'a'.repeat(64)}`, repository: 'library', commit: 'b'.repeat(40), path: 'proposals/one.mdx' };
export const gitRef = { store: 'git' as const, model: 'repository', id: 'sdk', repository: 'treeseed-ai/sdk', commit: 'c'.repeat(40) };
export const permissions = { content: { read: ['proposal'] as const, write: [] }, tools: ['source.read', 'source.write', 'verification'] as const };
export const executionCapability = 'treeseed.engineering.code-change';
export const conversationCapability = 'treeseed.coordination.conversation';
export const candidate = {
	graphRevision: 4, projectAgentClassId: 'class-engineer', projectContentRepositoryId: 'library', contextRefs: [gitRef], predecessorResults: [],
	sourceRepositories: [],
	effectiveProfile: {
		handler: 'actor', prompt: { system: 'Implement the accepted work and verify the exact result.' },
		profileRef: { store: 'treedx', model: 'agent', id: 'agent:engineer', revision: 1, digest: `sha256:${'d'.repeat(64)}` },
		activity: 'acting', handlerOrigin: 'agent-package', permissionCeiling: permissions,
	},
	node: {
		schemaVersion: 'treeseed.execution-node/v1', id: 'node', teamId: 'team', projectId: 'project',
		workItemId: 'implementation', kind: 'acting', pairRole: 'actor', sourceRef,
		authorityRefs: [{ store: 'postgresql', model: 'decision', id: 'decision', revision: 1, digest: `sha256:${'e'.repeat(64)}` }],
		ruleRevision: 1, nodeRevision: 1, agentClass: 'engineer', status: 'ready',
		estimate: { expectedSeconds: 120, maximumSeconds: 180 },
		requiredCapabilities: [executionCapability], requestedPermissions: permissions, workspace: 'git',
		acceptanceCriteria: ['Tests pass.'], maximumReviewCycles: 2,
		graphRevisionCreated: 1, graphRevisionUpdated: 4,
	},
};
export const provider = {
	id: 'codex', runtimeBuild: `sha256:${'f'.repeat(64)}`, status: 'available',
	capabilities: [executionCapability], availableConcurrency: 1, maxConcurrentRunners: 1,
	accountingLimits: { modelConfigurationId: 'terra-medium', dailyActiveSecondsLimit: 28800,
		capabilityLimits: { [executionCapability]: { dailyActiveSecondsLimit: 28800 } } },
	accountingObservation: { modelUsage: { day: '2026-09-13', observedAt: '2026-09-13T12:00:00.000Z', healthy: true, activeSeconds: 0, reservedSeconds: 0 },
		capabilityUsage: { [executionCapability]: { day: '2026-09-13', observedAt: '2026-09-13T12:00:00.000Z', healthy: true, activeSeconds: 0, reservedSeconds: 0 } } },
	lanes: [{ id: 'work', purpose: 'workday', priority: 1, capabilities: [executionCapability],
		maxConcurrentRunners: 1, reservedConcurrentWorkers: 0, borrowWhenIdle: true, lendWhenIdle: true, queueLimit: 10 }],
	offers: [suppliedCapabilityOffer('2026-09-13T12:00:00.000Z', executionCapability, 'codex-offer')],
};
export const run = { id: 'workday', executionMode: 'simulation', parameters: { appliedPlan: {
	schemaVersion: 'treeseed.workday/v1', id: 'workday', teamId: 'team', policyId: 'default', policyRevision: 1,
	executionMode: 'simulation',
	policySnapshot: { durationSeconds: 3600, maximumConcurrency: 1, planningTurnMaximumSeconds: 60,
		communicationConcurrency: 1, projectPercentages: { project: 100 }, agentClassPercentages: { project: { engineer: 100 } } },
	state: 'active', startsAt: '2026-09-13T12:00:00.000Z', endsAt: '2026-09-13T13:00:00.000Z',
	planningRounds: [{ round: 1, state: 'complete', assignmentIds: ['planning:1:project/engineer'] },
		{ round: 2, state: 'complete', assignmentIds: ['planning:2:project/engineer'] }],
	admittedSecondsByProject: {}, admittedSecondsByAgentClass: {}, activatedAt: '2026-09-13T12:00:00.000Z',
} } } as never;

/** Complete supplied qualification input, not native attestation or suite proof. */
export function suppliedCapabilityOffer(now: string, capabilityId: string, offerId: string): CapabilityOffer {
	const definition = CORE_CAPABILITY_DEFINITIONS.find(value => value.id === capabilityId);
	if (!definition) throw new Error('Original core capability definition required');
	const reference = { id: definition.id, version: definition.version, digest: definition.digest };
	const material: Omit<CapabilityOffer, 'offerDigest'> = {
		schemaVersion: 'treeseed.capability-offer/v2', offerId, capabilities: [reference],
		features: [], configurationSupport: {}, permissionClasses: definition.permissionClasses, contextModes: definition.contextModes,
		inputContracts: [], outputContracts: [], interactionModes: definition.interactionModes,
		conformance: [{ schemaVersion: 'treeseed.capability-conformance/v1', providerId: 'provider', capability: reference,
			tier: definition.qualificationTier, status: 'passed', evidenceDigest: definition.digest,
			suite: definition.qualificationTier === 'automated-suite' ? { id: 'supplied-qualification', version: '1.0.0' } : null,
			issuedAt: new Date(Date.parse(now) - 1_000).toISOString(), expiresAt: null,
			signature: { keyId: 'controlled-key', algorithm: 'Ed25519', value: 'controlled-input-not-attestation-proof' } }],
		contextCapacity: { mode: 'bounded', measurement: 'tokens', defaultInitial: 1024, maximum: 4096, reservedOutput: 256,
			transportPayloadBytes: 1_048_576, measurementProvenance: { provider: 'controlled', implementation: 'unit-input', version: null } },
		limits: {}, commercial: { currency: null, estimatedCost: null }, region: null, trust: [],
	};
	return capabilityOfferSchema.parse({ ...material, offerDigest: capabilityOfferDigest(material) });
}

export function canonicalOfferBuildInput(now = '2026-10-04T12:00:00.000Z', capabilityId = executionCapability): Parameters<typeof buildAssignmentAttempt>[0] {
	const offer = suppliedCapabilityOffer(now, capabilityId, 'canonical-code-change'), reference = offer.capabilities[0]!;
	const observation = { day: now.slice(0, 10), observedAt: now, healthy: true, activeSeconds: 0, reservedSeconds: 0 };
	const plan = { ...compileWorkday({ id: 'workday', teamId: 'team', policyId: 'default', policyRevision: 1,
		executionMode: 'simulation', startsAt: new Date(Date.parse(now) - 20_000).toISOString(), agentIds: [],
		policy: { durationSeconds: 60, planningPercent: 20, maximumConcurrency: 1, communicationConcurrency: 1 } }), state: 'active' as const };
	const ownerRun = serializeCapacityWorkdayRunRow({ id: 'workday', team_id: 'team', scenario_id: 'canonical-offer-input', status: 'running',
		environment: 'local', execution_kind: 'workday', trigger_kind: 'manual', execution_mode: 'simulation', created_at: now, updated_at: now,
		started_at: now, parameters_json: JSON.stringify({ appliedPlan: plan }), summary_json: '{}', metrics_json: '{}', expected_json: '{}',
		actual_json: '{}', report_refs_json: '{}', error_json: '{}' });
	if (!ownerRun) throw new Error('Original serialized Workday input required');
	const opportunity = allocateWorkdayCapacity({ now, remainingSeconds: 10, workdays: [{ plan,
		committedSeconds: 0, planningCommittedSeconds: 0, maximumAdditionalSeconds: 10, actingReady: true }] })[plan.id];
	if (!opportunity) throw new Error('Original allocator opportunity required');
	return { candidate: { ...candidate, readyAt: now,
		node: executionNodeSchema.parse({ ...candidate.node, requiredCapabilities: [reference.id] }),
		effectiveProfile: effectiveActivityProfileSchema.parse(candidate.effectiveProfile),
		contextRefs: candidate.contextRefs.map(value => exactEntityReferenceSchema.parse(value)) }, run: ownerRun,
		principal: { teamId: 'team', capacityProviderId: 'provider', membershipId: 'membership' }, providerSessionId: 'session',
		providers: [{ ...provider, capabilities: [reference.id], offers: [offer],
			accountingLimits: { modelConfigurationId: 'terra-medium', dailyActiveSecondsLimit: 10,
				capabilityLimits: { [reference.id]: { dailyActiveSecondsLimit: 10, maximumAssignmentSeconds: 3 } } },
			accountingObservation: { modelUsage: observation, capabilityUsage: { [reference.id]: observation } },
			lanes: [{ ...provider.lanes[0]!, purpose: 'workday', capabilities: [reference.id] }] }],
		allocationInputs: { [provider.id]: { measurements: [], constraints: [], opportunity } }, attempt: 1, now };
}

export function invalidCanonicalOffers(original: CapabilityOffer, now: string): Array<{ name: string; offer: unknown }> {
	const outcomes: Array<{ name: string; offer: unknown }> = [];
	const add = (name: string, edit: (offer: CapabilityOffer) => void, rehash = true) => {
		const offer = structuredClone(original); edit(offer);
		const { offerDigest: ignored, ...material } = offer;
		if (rehash) offer.offerDigest = capabilityOfferDigest(material);
		outcomes.push({ name, offer });
	};
	add('partial', offer => { Object.assign(offer, { conformance: undefined }); });
	add('digest', offer => { offer.offerDigest = `sha256:${'0'.repeat(64)}`; }, false);
	add('failed', offer => { offer.conformance[0]!.status = 'failed'; });
	add('revoked', offer => { offer.conformance[0]!.status = 'revoked'; });
	add('foreign-provider', offer => { offer.conformance[0]!.providerId = 'foreign-provider'; });
	add('missing-conformance', offer => { offer.conformance = []; });
	add('foreign-capability', offer => { offer.conformance[0]!.capability.id = 'treeseed.engineering.release'; });
	add('changed-version', offer => { offer.conformance[0]!.capability.version = '9.0.0'; });
	add('changed-capability-digest', offer => { offer.conformance[0]!.capability.digest = `sha256:${'0'.repeat(64)}`; });
	add('expired', offer => { offer.conformance[0]!.expiresAt = new Date(Date.parse(now) - 1).toISOString(); });
	add('expiry-boundary', offer => { offer.conformance[0]!.expiresAt = now; });
	add('future-issued', offer => { offer.conformance[0]!.issuedAt = new Date(Date.parse(now) + 1).toISOString(); });
	add('malformed-issued', offer => { Object.assign(offer.conformance[0]!, { issuedAt: null }); });
	add('empty-signature', offer => { offer.conformance[0]!.signature.value = ''; });
	add('duplicate-capability', offer => { offer.capabilities.push(structuredClone(offer.capabilities[0]!)); });
	add('ambiguous-conformance', offer => { offer.conformance.push({ ...structuredClone(offer.conformance[0]!), status: 'revoked' }); });
	add('prohibited-credential', offer => { Object.assign(offer, { credentials: {} }); });
	return outcomes;
}

/** Native fixture writer only, not a second conformance verifier. The public
 * identity and signed bytes remain input to the ORIGINAL publication service. */
export function signSuppliedOffer(original: CapabilityOffer, privateKey: KeyObject) {
	const publicJwk = createPublicKey(privateKey).export({ format: 'jwk' });
	if (typeof publicJwk.x !== 'string' || !publicJwk.x) throw new Error('Original Ed25519 fixture public key required');
	const offer = structuredClone(original), keyId = `provider-${createHash('sha256').update(publicJwk.x).digest('hex').slice(0, 16)}`;
	for (const receipt of offer.conformance) {
		receipt.signature = { keyId, algorithm: 'Ed25519', value: '' };
		receipt.signature.value = sign(null, Buffer.from(canonicalStandardsJson(receipt)), privateKey).toString('base64url');
	}
	const { offerDigest: ignored, ...material } = offer;
	offer.offerDigest = capabilityOfferDigest(material);
	return { publicJwk, offer: capabilityOfferSchema.parse(offer) };
}

/** Qualification semantics supplied BEFORE native signing. These variants
 * have valid signatures, unlike the signature-substitution regressions. */
export function invalidQualificationOffers(original: CapabilityOffer, now: string): Array<{ name: string; offer: CapabilityOffer; code: string }> {
	const outcomes: Array<{ name: string; offer: CapabilityOffer; code: string }> = [];
	const add = (name: string, edit: (offer: CapabilityOffer) => void, code = 'provider_capability_conformance_invalid') => {
		const offer = structuredClone(original); edit(offer); outcomes.push({ name, offer, code });
	};
	add('below-declared-tier', offer => { offer.conformance[0]!.tier = 'signed-attestation'; offer.conformance[0]!.suite = null; }, 'provider_capability_qualification_insufficient');
	add('missing-automated-suite', offer => { offer.conformance[0]!.suite = null; });
	add('future-issued', offer => { offer.conformance[0]!.issuedAt = new Date(Date.parse(now) + 60_000).toISOString(); });
	add('expiry-before-issuance', offer => { offer.conformance[0]!.expiresAt = new Date(Date.parse(offer.conformance[0]!.issuedAt) - 1).toISOString(); });
	add('exact-expiry', offer => { offer.conformance[0]!.expiresAt = now; });
	add('duplicate-passed', offer => { offer.conformance.push(structuredClone(offer.conformance[0]!)); });
	for (const status of ['failed', 'revoked'] as const) for (const first of [false, true]) add(`${status}-${first ? 'first' : 'last'}`, offer => {
		const contradicted = { ...structuredClone(offer.conformance[0]!), status };
		if (first) offer.conformance.unshift(contradicted); else offer.conformance.push(contradicted);
	});
	return outcomes;
}

export function substitutedSignedOffers(original: CapabilityOffer, foreignKey: KeyObject): Array<{ name: string; offer: CapabilityOffer }> {
	const outcomes: Array<{ name: string; offer: CapabilityOffer }> = [{ name: 'foreign-signer', offer: signSuppliedOffer(original, foreignKey).offer }];
	const add = (name: string, edit: (receipt: CapabilityOffer['conformance'][number]) => void) => {
		const offer = structuredClone(original); edit(offer.conformance[0]!);
		const { offerDigest: ignored, ...material } = offer;
		offer.offerDigest = capabilityOfferDigest(material); outcomes.push({ name, offer });
	};
	add('changed-evidence', receipt => { receipt.evidenceDigest = `sha256:${'0'.repeat(64)}`; });
	add('changed-tier', receipt => { receipt.tier = receipt.tier === 'reviewed-certification' ? 'automated-suite' : 'reviewed-certification'; });
	add('changed-issued-clock', receipt => { receipt.issuedAt = new Date(Date.parse(receipt.issuedAt) - 1).toISOString(); });
	add('changed-key-id', receipt => { receipt.signature.keyId = 'provider-foreign'; });
	add('changed-signature-byte', receipt => { const bytes = Buffer.from(receipt.signature.value, 'base64url'); bytes[0] = bytes[0]! ^ 1; receipt.signature.value = bytes.toString('base64url'); });
	add('short-signature', receipt => { receipt.signature.value = Buffer.alloc(8, 1).toString('base64url'); });
	add('malformed-signature', receipt => { receipt.signature.value = 'not-a-native-signature'; });
	add('noncanonical-signature', receipt => { receipt.signature.value += '='; });
	return outcomes;
}
