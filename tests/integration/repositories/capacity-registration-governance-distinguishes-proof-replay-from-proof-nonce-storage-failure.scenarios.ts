import { describe, expect, it } from 'vitest';
import { evaluateCapacityAdmission } from '@treeseed/sdk/agent-capacity/allocation';
import { MarketControlPlaneStore } from '../../../src/api/store.js';
import { CapacityGovernanceRepository } from '../../../src/api/capacity/repositories/governance.ts';
import { CapacityAuditRepository } from '../../../src/api/capacity/repositories/audit.ts';
import { CapacityRegistrationService } from '../../../src/api/capacity/services/registration-service.ts';
import { CapacityGrantService } from '../../../src/api/capacity/services/grant-service.ts';
import { CapacityAllocationService } from '../../../src/api/capacity/services/allocation-service.ts';
import { loadCapacityAdmissionState } from '../../../src/api/capacity/services/admission-state-service.ts';
import { settleCapacityReservationExactlyOnce } from '../../../src/api/capacity/services/settlement-service.ts';
import { capacityProviderTestIdentity as providerIdentity, capacityProviderTestProof as proof, capacityProviderTestSubmission as submission, createCapacityRegistrationTestHarness as createHarness, ensureCapacityTestTeam as ensureTeam, } from '../../support/capacity/registration.ts';

describe('capacity provider registration governance', () => {
it('distinguishes proof replay from proof-nonce storage failure', async () => {
    const storageFailure = new Error('proof nonce storage unavailable');
    const repository = new CapacityGovernanceRepository({
        ensureInitialized: async () => undefined,
        run: async () => { throw storageFailure; },
        first: async () => null,
        all: async () => [],
        batch: async () => { throw storageFailure; },
    });
    await expect(repository.consumeProofNonce('sha256:test', 'nonce', new Date(Date.now() + 60000).toISOString(), new Date().toISOString())).rejects.toBe(storageFailure);
});

it('persists and pages durable capacity audit evidence and rejects malformed evidence', async () => {
    const { database, store } = createHarness();
    try {
        await store.ensureInitialized();
        await ensureTeam(store, 'team-audit');
        const auditRepository = new CapacityAuditRepository(store);
        await auditRepository.record({
            id: 'audit-a', teamId: 'team-audit', providerId: 'provider-a', membershipId: 'membership-a',
            actorType: 'provider-membership', actorId: 'membership-a', action: 'assignment-synthesis.denied',
            resourceType: 'planning-input-request', resourceId: 'request-a', idempotencyKey: 'synthesis-a',
            metadata: { reasons: ['capacity_admission_denied'], assignmentId: 'assignment-a' },
            now: '2026-07-17T20:00:00.000Z',
        });
        const page = await auditRepository.listPage('team-audit', {
            action: 'assignment-synthesis.denied', providerId: 'provider-a', limit: 1,
        });
        expect(page).toMatchObject({
            items: [{ id: 'audit-a', teamId: 'team-audit', action: 'assignment-synthesis.denied', metadata: { assignmentId: 'assignment-a' } }],
            page: { limit: 1, hasMore: false, nextCursor: null },
        });
        await store.run(`UPDATE capacity_audit_events SET metadata_json = ? WHERE id = ?`, ['{broken', 'audit-a']);
        await expect(auditRepository.listPage('team-audit')).rejects.toMatchObject({ code: 'capacity_audit_event_metadata_invalid' });
    }
    finally {
        await database.close();
    }
});

it('rejects registration-key governance for nonexistent teams', async () => {
    const { database, store, service } = createHarness();
    try {
        await store.ensureInitialized();
        await expect(service.registrationKey('missing-team', 'owner')).rejects.toMatchObject({ code: 'capacity_team_not_found', status: 404 });
        await expect(service.revealRegistrationKey('missing-team', 'owner')).rejects.toMatchObject({ code: 'capacity_team_not_found', status: 404 });
        expect(await store.all(`SELECT * FROM team_capacity_registration_keys WHERE team_id = ?`, ['missing-team'])).toEqual([]);
    }
    finally {
        await database.close();
    }
});

it('enforces team ownership and governance status in the clean database schema', async () => {
    const { database, store } = createHarness();
    try {
        await store.ensureInitialized();
        const now = new Date().toISOString();
        await expect(store.run(`INSERT INTO team_capacity_registration_keys (id, team_id, generation, key_prefix, key_hash, encrypted_reveal_value, status, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?, 'active', ?, ?)`, ['orphan-key', 'missing-team', 'tsrk_orphan', 'hash', 'ciphertext', now, now])).rejects.toThrow(/foreign key constraint/ui);
        await store.run(`INSERT INTO capacity_providers (id, fingerprint, public_jwk_json, display_name, identity_version, status, metadata_json, created_at, updated_at) VALUES (?, ?, '{}', ?, 1, 'active', '{}', ?, ?)`, ['provider-schema', 'sha256:provider-schema', 'Schema Provider', now, now]);
        await expect(store.run(`INSERT INTO capacity_provider_team_memberships (id, team_id, capacity_provider_id, status, approved_at, approved_by_id, metadata_json, created_at, updated_at) VALUES (?, ?, ?, 'approved', ?, ?, '{}', ?, ?)`, ['orphan-membership', 'missing-team', 'provider-schema', now, 'owner', now, now])).rejects.toThrow(/foreign key constraint/ui);
        await ensureTeam(store, 'team-schema');
        await expect(store.run(`INSERT INTO capacity_provider_team_memberships (id, team_id, capacity_provider_id, status, approved_at, approved_by_id, metadata_json, created_at, updated_at) VALUES (?, ?, ?, 'unknown', ?, ?, '{}', ?, ?)`, ['invalid-membership', 'team-schema', 'provider-schema', now, 'owner', now, now])).rejects.toThrow(/check constraint/ui);
    }
    finally {
        await database.close();
    }
});

it('approves membership without creating a grant and issues a one-time credential', async () => {
    const { database, store, service } = createHarness();
    try {
        await store.ensureInitialized();
        await ensureTeam(store, 'team-a');
        const revealed = await service.revealRegistrationKey('team-a', 'owner-a');
        const identity = providerIdentity();
        const request = await service.submitRegistration(revealed.registrationKey, submission(identity, 'team-a', 'registration-a'), '/v1/provider-registrations', 'register-a');
        expect(request).toMatchObject({ teamId: 'team-a', status: 'pending', registrationKeyGeneration: 1 });
        expect(await service.submitRegistration(revealed.registrationKey, submission(identity, 'team-a', 'registration-a-retry'), '/v1/provider-registrations', 'register-a')).toMatchObject({ id: request.id });
        await expect(service.submitRegistration(revealed.registrationKey, submission(identity, 'different-request-body', 'registration-a-conflict'), '/v1/provider-registrations', 'register-a')).rejects.toMatchObject({ code: 'idempotency_key_conflict' });
        const approved = await service.approve('team-a', request.id, 'owner-a', 'approve-a');
        expect(approved).toMatchObject({ status: 'approved' });
        expect(await service.approve('team-a', request.id, 'owner-a', 'approve-a')).toMatchObject({ id: request.id, status: 'approved' });
        await expect(service.reject('team-a', request.id, 'owner-a', 'different operation', 'approve-a')).rejects.toMatchObject({ code: 'idempotency_key_conflict' });
        const grants = await store.all(`SELECT * FROM capacity_grants WHERE team_id = ? AND capacity_provider_id = ?`, ['team-a', request.providerId]);
        expect(grants).toEqual([]);
        const exchangeIdempotency = 'credential-a';
        const credential = await service.exchangeCredential(request.id, proof({ privateKey: identity.privateKey, publicJwk: identity.publicJwk, method: 'POST', path: `/v1/provider-registrations/${request.id}/credential`, body: { requestId: request.id, idempotencyKey: exchangeIdempotency }, jti: 'exchange-a' }), `/v1/provider-registrations/${request.id}/credential`, exchangeIdempotency);
        expect(credential.credential).toMatch(/^tspc_/u);
        const credentialReplay = await service.exchangeCredential(request.id, proof({ privateKey: identity.privateKey, publicJwk: identity.publicJwk, method: 'POST', path: `/v1/provider-registrations/${request.id}/credential`, body: { requestId: request.id, idempotencyKey: exchangeIdempotency }, jti: 'exchange-a-retry' }), `/v1/provider-registrations/${request.id}/credential`, exchangeIdempotency);
        expect(credentialReplay).toMatchObject({ id: credential.id, credential: credential.credential });
        const credentialRow = await store.first(`SELECT * FROM capacity_provider_team_credentials WHERE id = ?`, [credential.id]);
        expect(credentialRow).not.toHaveProperty('encrypted_reveal_value');
        expect(credentialRow).not.toHaveProperty('credential');
        const accessIdempotency = 'access-a';
        const access = await service.issueAccessToken({
            credentialValue: credential.credential,
            credentialId: credential.id,
            proof: proof({ privateKey: identity.privateKey, publicJwk: identity.publicJwk, method: 'POST', path: '/v1/provider/access-tokens', body: { credentialId: credential.id, idempotencyKey: accessIdempotency }, jti: 'access-a' }),
            path: '/v1/provider/access-tokens',
            idempotencyKey: accessIdempotency,
        });
        expect(access).toMatchObject({ membershipId: approved.membershipId, status: 'active' });
        expect(access.accessToken).toMatch(/^tspa_/u);
        const accessReplay = await service.issueAccessToken({
            credentialValue: credential.credential,
            credentialId: credential.id,
            proof: proof({ privateKey: identity.privateKey, publicJwk: identity.publicJwk, method: 'POST', path: '/v1/provider/access-tokens', body: { credentialId: credential.id, idempotencyKey: accessIdempotency }, jti: 'access-a-retry' }),
            path: '/v1/provider/access-tokens',
            idempotencyKey: accessIdempotency,
        });
        expect(accessReplay).toMatchObject({ id: access.id, accessToken: access.accessToken });
        const accessAuth = await service.authenticateAccessToken(access.accessToken);
        expect(accessAuth).toMatchObject({
            principal: { membershipId: approved.membershipId, capacityProviderId: request.providerId, teamId: 'team-a', authType: 'membership-access-token' },
            provider: { id: request.providerId, teamId: 'team-a' },
        });
        const principal = accessAuth?.principal;
        expect(principal).toBeTruthy();
        await expect(service.authorizeProviderCredentialRotation({ ...principal!, scopes: principal!.scopes.filter((scope) => scope !== 'provider:credentials:rotate') }, 'provider-scope-denied')).rejects.toMatchObject({ code: 'provider_scope_required' });
        await expect(service.authorizeTeamCredentialRotation('team-b', approved.membershipId!, 'owner-b', 'cross-team-rotation')).rejects.toMatchObject({ code: 'provider_membership_not_found' });
        const rotation = await service.authorizeTeamCredentialRotation('team-a', approved.membershipId!, 'owner-a', 'rotate-credential-a');
        expect(rotation).toMatchObject({ membershipId: approved.membershipId, generation: 2, status: 'pending' });
        expect(await service.authorizeTeamCredentialRotation('team-a', approved.membershipId!, 'owner-a', 'rotate-credential-a')).toEqual(rotation);
        expect(await service.authenticateAccessToken(access.accessToken)).toBeNull();
        const rotationExchangeIdempotency = 'credential-a-generation-2';
        const exchangePath = `/v1/provider-registrations/${request.id}/credential`;
        const rotatedCredential = await service.exchangeCredential(request.id, proof({ privateKey: identity.privateKey, publicJwk: identity.publicJwk, method: 'POST', path: exchangePath, body: { requestId: request.id, idempotencyKey: rotationExchangeIdempotency }, jti: 'credential-a-generation-2' }), exchangePath, rotationExchangeIdempotency);
        expect(rotatedCredential).toMatchObject({ membershipId: approved.membershipId, issuanceGeneration: 2, rotatedFromCredentialId: credential.id, status: 'active' });
        expect(rotatedCredential.credential).toMatch(/^tspc_/u);
        const credentialRecords = (await service.listCredentialsPage('team-a', approved.membershipId!)).items;
        expect(credentialRecords).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: credential.id, status: 'revoked' }),
            expect.objectContaining({ id: rotatedCredential.id, status: 'active', rotatedFromCredentialId: credential.id }),
        ]));
        const firstCredentialPage = await service.listCredentialsPage('team-a', approved.membershipId!, { limit: 1 });
        const secondCredentialPage = await service.listCredentialsPage('team-a', approved.membershipId!, { limit: 1, cursor: firstCredentialPage.page.nextCursor });
        expect(firstCredentialPage.page).toMatchObject({ limit: 1, hasMore: true });
        expect(new Set([...firstCredentialPage.items, ...secondCredentialPage.items].map((entry) => entry.id))).toEqual(new Set([credential.id, rotatedCredential.id]));
        const rotatedAccessIdempotency = 'access-rotated-a';
        const rotatedAccess = await service.issueAccessToken({
            credentialValue: rotatedCredential.credential,
            credentialId: rotatedCredential.id,
            proof: proof({ privateKey: identity.privateKey, publicJwk: identity.publicJwk, method: 'POST', path: '/v1/provider/access-tokens', body: { credentialId: rotatedCredential.id, idempotencyKey: rotatedAccessIdempotency }, jti: 'access-rotated-a' }),
            path: '/v1/provider/access-tokens',
            idempotencyKey: rotatedAccessIdempotency,
        });
        const rotatedPrincipal = (await service.authenticateAccessToken(rotatedAccess.accessToken))?.principal;
        expect(rotatedPrincipal).toBeTruthy();
        const session = await store.createProviderAvailabilitySession(rotatedPrincipal!, {
            environment: 'local',
            capabilities: ['engineering'],
            nativeLimits: { availableCredits: 20, maxConcurrentRunners: 2 },
            runnerPressure: { activeRunners: 0, maxConcurrentRunners: 2 },
        });
        expect(session).toMatchObject({ membershipId: approved.membershipId, providerId: request.providerId, status: 'open', sequence: 1, snapshot: { maxConcurrentAssignments: 2, capabilities: ['engineering'] } });
        const refreshed = await store.refreshProviderAvailabilitySession(rotatedPrincipal!, session.id, { expectedSequence: 1, capabilities: ['engineering', 'research'], nativeLimits: { availableCredits: 19, maxConcurrentRunners: 2 } });
        expect(refreshed).toMatchObject({ id: session.id, sequence: 2, snapshot: { capabilities: ['engineering', 'research'] } });
        expect(await store.refreshProviderAvailabilitySession(rotatedPrincipal!, session.id, { expectedSequence: 1 })).toBeNull();
        expect(await store.closeProviderAvailabilitySession(rotatedPrincipal!, session.id)).toMatchObject({ status: 'closed' });
        await expect(service.exchangeCredential(request.id, proof({ privateKey: identity.privateKey, publicJwk: identity.publicJwk, method: 'POST', path: `/v1/provider-registrations/${request.id}/credential`, body: { requestId: request.id, idempotencyKey: 'credential-again' }, jti: 'exchange-again' }), `/v1/provider-registrations/${request.id}/credential`, 'credential-again')).rejects.toMatchObject({ code: 'provider_credential_already_issued' });
        expect(await service.leaveMembership(rotatedPrincipal!, 'provider-leave-a')).toMatchObject({ status: 'revoked' });
        expect(await service.leaveMembership(rotatedPrincipal!, 'provider-leave-a')).toMatchObject({ status: 'revoked' });
        await expect(service.updateMembership('team-a', approved.membershipId!, request.providerId, 'approved', 'provider-leave-a', 'provider-identity')).rejects.toMatchObject({ code: 'idempotency_key_conflict' });
        expect(await service.authenticateAccessToken(rotatedAccess.accessToken)).toBeNull();
        await expect(service.submitRegistration(revealed.registrationKey, submission(identity, 'team-a', 'registration-after-revoke'), '/v1/provider-registrations', 'register-after-revoke')).rejects.toMatchObject({ code: 'provider_membership_revoked' });
    }
    finally {
        await database.close();
    }
});

it('rejects invalid, expired, future, and replayed registration proofs before admission', async () => {
    const { database, store, service } = createHarness();
    try {
        await store.ensureInitialized();
        await ensureTeam(store, 'team-proof');
        const key = await service.revealRegistrationKey('team-proof', 'owner-proof');
        const identity = providerIdentity();
        await expect(service.submitRegistration('tsrk_invalid_secret', submission(identity, 'team-proof', 'invalid-key'), '/v1/provider-registrations', 'invalid-key')).rejects.toMatchObject({ code: 'registration_key_invalid' });
        const expired = submission(identity, 'team-proof', 'expired-proof');
        const expiredBody = { schemaVersion: expired.schemaVersion, displayName: expired.displayName, publicJwk: expired.publicJwk, capabilitySummary: expired.capabilitySummary, supplyOffer: expired.supplyOffer, metadata: expired.metadata ?? {} };
        expired.proof = proof({ privateKey: identity.privateKey, publicJwk: identity.publicJwk, method: 'POST', path: '/v1/provider-registrations', body: expiredBody, jti: 'expired-proof', issuedAt: new Date(Date.now() - 6 * 60000).toISOString(), expiresAt: new Date(Date.now() - 60000).toISOString() });
        await expect(service.submitRegistration(key.registrationKey, expired, '/v1/provider-registrations', 'expired-proof')).rejects.toMatchObject({ code: 'provider_proof_invalid', details: { diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'provider_proof_expired' })]) } });
        const future = submission(identity, 'team-proof', 'future-proof');
        const futureBody = { schemaVersion: future.schemaVersion, displayName: future.displayName, publicJwk: future.publicJwk, capabilitySummary: future.capabilitySummary, supplyOffer: future.supplyOffer, metadata: future.metadata ?? {} };
        future.proof = proof({ privateKey: identity.privateKey, publicJwk: identity.publicJwk, method: 'POST', path: '/v1/provider-registrations', body: futureBody, jti: 'future-proof', issuedAt: new Date(Date.now() + 61000).toISOString(), expiresAt: new Date(Date.now() + 4 * 60000).toISOString() });
        await expect(service.submitRegistration(key.registrationKey, future, '/v1/provider-registrations', 'future-proof')).rejects.toMatchObject({ code: 'provider_proof_invalid', details: { diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'provider_proof_issued_in_future' })]) } });
        const replay = submission(identity, 'team-proof', 'replayed-proof');
        await service.submitRegistration(key.registrationKey, replay, '/v1/provider-registrations', 'replay-first');
        await expect(service.submitRegistration(key.registrationKey, replay, '/v1/provider-registrations', 'replay-second')).rejects.toMatchObject({ code: 'provider_proof_replayed' });
    }
    finally {
        await database.close();
    }
});

it('commits exactly one approve-or-reject result without an orphan membership', async () => {
    const { database, store, service } = createHarness();
    try {
        await store.ensureInitialized();
        await ensureTeam(store, 'team-review-race');
        const key = await service.revealRegistrationKey('team-review-race', 'owner-review-race');
        const identity = providerIdentity();
        const request = await service.submitRegistration(key.registrationKey, submission(identity, 'team-review-race', 'review-race-register'), '/v1/provider-registrations', 'review-race-register');
        const results = await Promise.allSettled([
            service.approve('team-review-race', request.id, 'owner-review-race', 'review-race-approve'),
            service.reject('team-review-race', request.id, 'owner-review-race', 'not approved', 'review-race-reject'),
        ]);
        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
        const finalRequest = await service.registrationRequest('team-review-race', request.id);
        const memberships = await store.all(`SELECT id FROM capacity_provider_team_memberships WHERE team_id = ? AND capacity_provider_id = ?`, ['team-review-race', request.providerId]);
        expect(memberships).toHaveLength(finalRequest.status === 'approved' ? 1 : 0);
        if (finalRequest.status === 'approved')
            expect(memberships[0]?.id).toBe(finalRequest.membershipId);
    }
    finally {
        await database.close();
    }
});

it('persists registration throttles across team, address, fingerprint, and key-generation dimensions', async () => {
    const { database, store, service } = createHarness();
    try {
        await store.ensureInitialized();
        await ensureTeam(store, 'team-rate-limit');
        const key = await service.revealRegistrationKey('team-rate-limit', 'owner-rate-limit');
        for (let index = 0; index < 20; index += 1) {
            const identity = providerIdentity();
            await service.submitRegistration(key.registrationKey, submission(identity, 'team-rate-limit', `rate-register-${index}`), '/v1/provider-registrations', `rate-register-${index}`, '198.51.100.10');
        }
        const blockedIdentity = providerIdentity();
        await expect(service.submitRegistration(key.registrationKey, submission(blockedIdentity, 'team-rate-limit', 'rate-register-blocked'), '/v1/provider-registrations', 'rate-register-blocked', '198.51.100.10')).rejects.toMatchObject({
            code: 'provider_registration_rate_limited',
            details: { dimensions: expect.arrayContaining(['team', 'ip', 'key-generation']) },
        });
        const counters = await store.all(`SELECT dimension, count FROM capacity_provider_registration_rate_limits ORDER BY dimension, bucket_key`);
        expect(counters.filter((row) => ['team', 'ip', 'key-generation'].includes(String(row.dimension))).every((row) => Number(row.count) === 21)).toBe(true);
        expect(counters.filter((row) => row.dimension === 'fingerprint')).toHaveLength(21);
    }
    finally {
        await database.close();
    }
});

it('durably expires pending registration requests before reads or review', async () => {
    const { database, store, service } = createHarness();
    try {
        await store.ensureInitialized();
        await ensureTeam(store, 'team-expiry');
        const key = await service.revealRegistrationKey('team-expiry', 'owner-expiry');
        const identity = providerIdentity();
        const request = await service.submitRegistration(key.registrationKey, submission(identity, 'team-expiry', 'expiry-register'), '/v1/provider-registrations', 'expiry-register');
        await store.run(`UPDATE capacity_provider_registration_requests SET expires_at = ? WHERE id = ?`, [new Date(Date.now() - 1000).toISOString(), request.id]);
        expect(await service.registrationRequest('team-expiry', request.id)).toMatchObject({ status: 'expired' });
        await expect(service.approve('team-expiry', request.id, 'owner-expiry', 'expiry-approve')).rejects.toMatchObject({ code: 'provider_registration_not_pending', details: { status: 'expired' } });
        expect(await store.all(`SELECT id FROM capacity_provider_team_memberships WHERE team_id = ?`, ['team-expiry'])).toEqual([]);
    }
    finally {
        await database.close();
    }
});

it('paginates registration requests and memberships with stable opaque cursors', async () => {
    const { database, store, repository, service } = createHarness();
    try {
        await store.ensureInitialized();
        await ensureTeam(store, 'team-pages');
        const key = await service.revealRegistrationKey('team-pages', 'owner-pages');
        const requestIds: string[] = [];
        const membershipIds: string[] = [];
        for (let index = 0; index < 3; index += 1) {
            const identity = providerIdentity();
            const registration = await service.submitRegistration(key.registrationKey, submission(identity, 'team-pages', `page-register-${index}`), '/v1/provider-registrations', `page-register-${index}`);
            requestIds.push(registration.id);
            const approved = await service.approve('team-pages', registration.id, 'owner-pages', `page-approve-${index}`);
            membershipIds.push(approved.membershipId!);
        }
        const requestPageOne = await service.listRequestsPage('team-pages', { limit: 2 });
        const requestPageTwo = await service.listRequestsPage('team-pages', { limit: 2, cursor: requestPageOne.page.nextCursor });
        expect(requestPageOne.page).toMatchObject({ limit: 2, hasMore: true });
        expect(requestPageTwo.page).toMatchObject({ limit: 2, hasMore: false, nextCursor: null });
        expect(new Set([...requestPageOne.items, ...requestPageTwo.items].map((entry) => entry.id))).toEqual(new Set(requestIds));
        const membershipPageOne = await repository.listMembershipsPage('team-pages', { limit: 2 });
        const membershipPageTwo = await repository.listMembershipsPage('team-pages', { limit: 2, cursor: membershipPageOne.page.nextCursor });
        expect(new Set([...membershipPageOne.items, ...membershipPageTwo.items].map((entry) => entry.id))).toEqual(new Set(membershipIds));
        await expect(service.listRequestsPage('team-pages', { cursor: 'not-a-cursor' })).rejects.toMatchObject({ code: 'capacity_page_invalid', status: 400 });
    }
    finally {
        await database.close();
    }
});

it('lets one global provider request independent membership in multiple teams', async () => {
    const { database, store, repository, service } = createHarness();
    try {
        await store.ensureInitialized();
        const identity = providerIdentity();
        await ensureTeam(store, 'team-a');
        await ensureTeam(store, 'team-b');
        const teamAKey = await service.revealRegistrationKey('team-a', 'owner-a');
        const teamBKey = await service.revealRegistrationKey('team-b', 'owner-b');
        const requestA = await service.submitRegistration(teamAKey.registrationKey, submission(identity, 'team-a', 'multi-a'), '/v1/provider-registrations', 'multi-a');
        const requestB = await service.submitRegistration(teamBKey.registrationKey, submission(identity, 'team-b', 'multi-b'), '/v1/provider-registrations', 'multi-b');
        expect(requestA.providerId).toBe(requestB.providerId);
        const membershipA = await service.approve('team-a', requestA.id, 'owner-a', 'approve-multi-a');
        await service.approve('team-b', requestB.id, 'owner-b', 'approve-multi-b');
        expect((await repository.listMembershipsPage('team-a')).items).toHaveLength(1);
        expect((await repository.listMembershipsPage('team-b')).items).toHaveLength(1);
        await expect(service.membership('team-b', membershipA.membershipId!)).rejects.toMatchObject({ code: 'provider_membership_not_found' });
    }
    finally {
        await database.close();
    }
});
});
