import { describe, expect, it } from 'vitest';
import { evaluateCapacityAdmission } from '@treeseed/sdk/agent-capacity/allocation';
import { MarketControlPlaneStore } from '../../../../../src/api/persistence/store.js';
import { CapacityGovernanceRepository } from '../../../../../src/api/capacity/repositories/governance/policy/governance.ts';
import { CapacityAuditRepository } from '../../../../../src/api/capacity/repositories/support/audit.ts';
import { CapacityRegistrationService } from '../../../../../src/api/capacity/services/support/registration-service.ts';
import { CapacityGrantService } from '../../../../../src/api/capacity/services/capacity/allocations/grant-service.ts';
import { CapacityAllocationService } from '../../../../../src/api/capacity/services/capacity/allocations/allocation-service.ts';
import { loadCapacityAdmissionState } from '../../../../../src/api/capacity/services/support/admission-state-service.ts';
import { settleCapacityReservationExactlyOnce } from '../../../../../src/api/capacity/services/capacity/accounting/settlement-service.ts';
import { capacityProviderTestIdentity as providerIdentity, capacityProviderTestProof as proof, capacityProviderTestSubmission as submission, createCapacityRegistrationTestHarness as createHarness, ensureCapacityTestTeam as ensureTeam, } from '../../../../support/capacity/registration.ts';

describe('capacity provider registration governance', () => {
it('rotates one global identity atomically and preserves memberships and credentials', async () => {
    const { database, store, service } = createHarness();
    try {
        await store.ensureInitialized();
        const original = providerIdentity();
        await ensureTeam(store, 'team-a');
        const key = await service.revealRegistrationKey('team-a', 'owner-a');
        const request = await service.submitRegistration(key.registrationKey, submission(original, 'rotation', 'identity-register'), '/v1/provider-registrations', 'identity-register');
        const approved = await service.approve('team-a', request.id, 'owner-a', 'identity-approve');
        const credentialKey = 'identity-credential';
        const credential = await service.exchangeCredential(request.id, proof({ privateKey: original.privateKey, publicJwk: original.publicJwk, method: 'POST', path: `/v1/provider-registrations/${request.id}/credential`, body: { requestId: request.id, idempotencyKey: credentialKey }, jti: 'identity-exchange' }), `/v1/provider-registrations/${request.id}/credential`, credentialKey);
        await ensureTeam(store, 'team-b');
        const teamBKey = await service.revealRegistrationKey('team-b', 'owner-b');
        const teamBRequest = await service.submitRegistration(teamBKey.registrationKey, submission(original, 'rotation-team-b', 'identity-register-team-b'), '/v1/provider-registrations', 'identity-register-team-b');
        const teamBApproved = await service.approve('team-b', teamBRequest.id, 'owner-b', 'identity-approve-team-b');
        const teamBCredentialKey = 'identity-credential-team-b';
        const teamBCredential = await service.exchangeCredential(teamBRequest.id, proof({ privateKey: original.privateKey, publicJwk: original.publicJwk, method: 'POST', path: `/v1/provider-registrations/${teamBRequest.id}/credential`, body: { requestId: teamBRequest.id, idempotencyKey: teamBCredentialKey }, jti: 'identity-exchange-team-b' }), `/v1/provider-registrations/${teamBRequest.id}/credential`, teamBCredentialKey);
        const accessKey = 'identity-access';
        const access = await service.issueAccessToken({ credentialValue: credential.credential, credentialId: credential.id, proof: proof({ privateKey: original.privateKey, publicJwk: original.publicJwk, method: 'POST', path: '/v1/provider/access-tokens', body: { credentialId: credential.id, idempotencyKey: accessKey }, jti: 'identity-access' }), path: '/v1/provider/access-tokens', idempotencyKey: accessKey });
        const principal = (await service.authenticateAccessToken(access.accessToken))!.principal;
        const next = providerIdentity();
        const rotationBody = { expectedIdentityVersion: 1, newPublicJwk: next.publicJwk };
        const forgedOldProof = proof({ privateKey: next.privateKey, publicJwk: original.publicJwk, identityVersion: 1, method: 'POST', path: '/v1/provider/identity/rotate', body: rotationBody, jti: 'identity-rotate-forged-old' });
        const newProof = proof({ privateKey: next.privateKey, publicJwk: next.publicJwk, identityVersion: 2, method: 'POST', path: '/v1/provider/identity/rotate', body: rotationBody, jti: 'identity-rotate-new' });
        await expect(service.rotateIdentity(principal, { ...rotationBody, oldProof: forgedOldProof, newProof }, 'identity-rotate-forged')).rejects.toMatchObject({ code: 'provider_proof_signature_invalid' });
        const oldProof = proof({ privateKey: original.privateKey, publicJwk: original.publicJwk, identityVersion: 1, method: 'POST', path: '/v1/provider/identity/rotate', body: rotationBody, jti: 'identity-rotate-old' });
        const [rotated, replayedRotation] = await Promise.all([
            service.rotateIdentity(principal, { ...rotationBody, oldProof, newProof }, 'identity-rotate'),
            service.rotateIdentity(principal, { ...rotationBody, oldProof, newProof }, 'identity-rotate'),
        ]);
        expect(rotated).toMatchObject({ providerId: request.providerId, identityVersion: 2 });
        expect(replayedRotation).toMatchObject({ providerId: request.providerId, identityVersion: 2, fingerprint: rotated.fingerprint });
        expect(rotated.fingerprint).not.toBe(request.providerFingerprint);
        expect(await service.authenticateAccessToken(access.accessToken)).toBeNull();
        expect((await service.listMembershipsPage('team-a')).items.find((entry) => entry.id === approved.membershipId)?.status).toBe('approved');
        expect((await service.listCredentialsPage('team-a', approved.membershipId!)).items.find((entry) => entry.id === credential.id)?.status).toBe('active');
        expect((await service.listMembershipsPage('team-b')).items.find((entry) => entry.id === teamBApproved.membershipId)?.status).toBe('approved');
        expect((await service.listCredentialsPage('team-b', teamBApproved.membershipId!)).items.find((entry) => entry.id === teamBCredential.id)?.status).toBe('active');
        const nextAccessKey = 'identity-next-access';
        const nextAccess = await service.issueAccessToken({ credentialValue: credential.credential, credentialId: credential.id, proof: proof({ privateKey: next.privateKey, publicJwk: next.publicJwk, identityVersion: 2, method: 'POST', path: '/v1/provider/access-tokens', body: { credentialId: credential.id, idempotencyKey: nextAccessKey }, jti: 'identity-next-access' }), path: '/v1/provider/access-tokens', idempotencyKey: nextAccessKey });
        expect(nextAccess).toMatchObject({ identityVersion: 2, membershipId: approved.membershipId });
    }
    finally {
        await database.close();
    }
});

it('rotates immediately, cancels old-generation pending requests, and keeps approved memberships', async () => {
    const { database, store, repository, service } = createHarness();
    try {
        await store.ensureInitialized();
        await ensureTeam(store, 'team-a');
        const key = await service.revealRegistrationKey('team-a', 'owner-a');
        const approvedIdentity = providerIdentity();
        const approvedRequest = await service.submitRegistration(key.registrationKey, submission(approvedIdentity, 'approved', 'rotate-approved'), '/v1/provider-registrations', 'rotate-approved');
        await service.approve('team-a', approvedRequest.id, 'owner-a', 'rotate-approve');
        const pendingIdentity = providerIdentity();
        const pendingRequest = await service.submitRegistration(key.registrationKey, submission(pendingIdentity, 'pending', 'rotate-pending'), '/v1/provider-registrations', 'rotate-pending');
        const rotated = await service.rotateRegistrationKey('team-a', 'owner-a', 'rotate-key');
        expect(rotated.generation).toBe(2);
        expect(await service.rotateRegistrationKey('team-a', 'owner-a', 'rotate-key')).toMatchObject({ generation: 2, registrationKey: rotated.registrationKey });
        expect(await store.all(`SELECT id FROM capacity_audit_events WHERE team_id = ? AND action = 'registration-key.rotated' AND idempotency_key = ?`, ['team-a', 'rotate-key'])).toHaveLength(1);
        expect((await repository.registrationRequestById(pendingRequest.id))?.status).toBe('cancelled');
        expect((await repository.membershipForTeamProvider('team-a', approvedRequest.providerId))?.status).toBe('approved');
        await expect(service.submitRegistration(key.registrationKey, submission(providerIdentity(), 'old-key', 'old-key'), '/v1/provider-registrations', 'old-key')).rejects.toMatchObject({ code: 'registration_key_disabled' });
        const racingIdentity = providerIdentity();
        const race = await Promise.allSettled([
            service.submitRegistration(rotated.registrationKey, submission(racingIdentity, 'rotation-race', 'rotation-race'), '/v1/provider-registrations', 'rotation-race'),
            service.rotateRegistrationKey('team-a', 'owner-a', 'rotate-key-race'),
        ]);
        expect(race[1].status).toBe('fulfilled');
        expect(await store.all(`SELECT id FROM capacity_provider_registration_requests WHERE team_id = ? AND registration_key_generation = 2 AND status = 'pending'`, ['team-a'])).toEqual([]);
        const disabled = await service.setRegistrationKeyStatus('team-a', 'owner-a', 'disabled', 'key-status');
        expect(await service.setRegistrationKeyStatus('team-a', 'owner-a', 'disabled', 'key-status')).toEqual(disabled);
        await expect(service.setRegistrationKeyStatus('team-a', 'owner-a', 'active', 'key-status')).rejects.toMatchObject({ code: 'idempotency_key_conflict' });
    }
    finally {
        await database.close();
    }
});

it('runs registration through governed admission and exactly-once settlement as one service workflow', async () => {
    const { database, store, service } = createHarness();
    try {
        await store.ensureInitialized();
        await store.createTeam({ id: 'team-workflow', slug: 'team-workflow', name: 'workflow-team' });
        const identity = providerIdentity();
        await ensureTeam(store, 'team-workflow');
        const key = await service.revealRegistrationKey('team-workflow', 'owner-workflow');
        const request = await service.submitRegistration(key.registrationKey, submission(identity, 'team-workflow', 'workflow-register'), '/v1/provider-registrations', 'workflow-register');
        const approved = await service.approve('team-workflow', request.id, 'owner-workflow', 'workflow-approve');
        const credentialKey = 'workflow-credential';
        const credential = await service.exchangeCredential(request.id, proof({ privateKey: identity.privateKey, publicJwk: identity.publicJwk, method: 'POST', path: `/v1/provider-registrations/${request.id}/credential`, body: { requestId: request.id, idempotencyKey: credentialKey }, jti: 'workflow-exchange' }), `/v1/provider-registrations/${request.id}/credential`, credentialKey);
        const accessKey = 'workflow-access';
        const access = await service.issueAccessToken({ credentialValue: credential.credential, credentialId: credential.id, proof: proof({ privateKey: identity.privateKey, publicJwk: identity.publicJwk, method: 'POST', path: '/v1/provider/access-tokens', body: { credentialId: credential.id, idempotencyKey: accessKey }, jti: 'workflow-access' }), path: '/v1/provider/access-tokens', idempotencyKey: accessKey });
        const principal = (await service.authenticateAccessToken(access.accessToken))!.principal;
        const now = new Date().toISOString();
        await store.run(`INSERT INTO projects (id, team_id, slug, name, metadata_json, created_at, updated_at) VALUES ('project-workflow', 'team-workflow', 'project-workflow', 'Workflow Project', '{}', ?, ?)`, [now, now]);
        await store.run(`INSERT INTO project_agent_classes (id, team_id, project_id, slug, name, status, allowed_modes_json, required_capabilities_json, kernel_profile_json, kernel_policy_json, handler_refs_json, output_contracts_json, metadata_json, created_at, updated_at) VALUES ('class-workflow', 'team-workflow', 'project-workflow', 'engineer', 'Engineer', 'active', '["planning"]', '["engineering"]', '{}', '{}', '{}', '{}', '{}', ?, ?)`, [now, now]);
        const allocationId = 'allocation-workflow';
        const allocations = new CapacityAllocationService(store);
        const allocation = await allocations.create('team-workflow', {
            id: allocationId,
            reservePolicy: { percent: 0, overflow: 'deny' },
            slices: [{ id: 'project:project-workflow', scope: 'project', targetId: 'project-workflow', policy: { minPercent: 0, targetPercent: 100, maxPercent: 100, hardCapPercent: 100 } }],
            borrowingRules: [],
        }, 'owner-workflow', 'workflow-allocation-create');
        expect(allocation).not.toBeNull();
        expect(await store.all(`SELECT id, team_id, status FROM capacity_allocation_sets WHERE id = ?`, [allocationId])).toEqual([
            expect.objectContaining({ id: allocationId, team_id: 'team-workflow', status: 'draft' }),
        ]);
        const activatedAllocation = await allocations.activate('team-workflow', allocationId, 'workflow-allocation-activate');
        expect(activatedAllocation).toMatchObject({ id: allocationId, status: 'active' });
        expect(await store.getCapacityAllocationSet('team-workflow', allocationId)).toMatchObject({ id: allocationId, status: 'active' });
        const session = await store.createProviderAvailabilitySession(principal, {
            id: 'session-workflow',
            environment: 'local',
            capabilities: ['engineering'],
            executionProviders: [{
                    id: 'codex',
                    adapter: 'codex',
                    capabilities: ['engineering'],
                    maxConcurrentRunners: 1,
                    nativeLimits: { availableCredits: 10 },
                    lanes: [{ id: 'engineering-lane', maxConcurrentRunners: 1, capabilities: ['engineering'], nativeLimits: { availableCredits: 10 } }],
                }],
            nativeLimits: { availableCredits: 10, maxConcurrentRunners: 1 },
            runnerPressure: { activeRunners: 0, maxConcurrentRunners: 1 },
            constraints: { availableCredits: 10, activeRunners: 0, maxConcurrentRunners: 1 },
        });
        expect(await store.all(`SELECT id, capacity_provider_id FROM capacity_execution_providers WHERE capacity_provider_id = ?`, [request.providerId])).toEqual([
            expect.objectContaining({ id: 'codex', capacity_provider_id: request.providerId }),
        ]);
        expect(await store.all(`SELECT id, capacity_provider_id, execution_provider_id FROM capacity_provider_lanes WHERE capacity_provider_id = ?`, [request.providerId])).toEqual([
            expect.objectContaining({ id: 'engineering-lane', capacity_provider_id: request.providerId, execution_provider_id: 'codex' }),
        ]);
        const grantService = new CapacityGrantService(store);
        const plannedGrant = await grantService.create('team-workflow', { id: 'grant-workflow', membershipId: approved.membershipId, projectId: 'project-workflow', environment: 'local', executionProviderIds: ['codex'], laneIds: ['engineering-lane'], capabilities: ['engineering'], allowedModes: ['planning'], dailyCreditLimit: 10, monthlyCreditLimit: 20, maxConcurrentAssignments: 1 }, 'workflow-grant-create');
        const grant = await grantService.transition('team-workflow', plannedGrant!.id, 'active', 'workflow-grant-activate');
        await store.createWorkdayCapacityEnvelope({ id: 'workday-workflow', projectId: 'project-workflow', allocationSetId: allocationId, status: 'active', availableCredits: 10, metadata: { source: 'service_workflow', grantId: grant!.id } });
        const admission = await loadCapacityAdmissionState(store, { teamId: 'team-workflow', providerId: request.providerId, membershipId: approved.membershipId!, projectId: 'project-workflow', environment: 'local', projectAgentClassId: 'class-workflow', mode: 'planning', workDayId: 'workday-workflow', requestedCredits: 6, executionProviderId: 'codex', laneId: 'engineering-lane', providerSessionId: session.id, requiredCapabilities: ['engineering'] });
        expect(evaluateCapacityAdmission(admission)).toMatchObject({ allowed: true, reasonCodes: [] });
        const assignment = await store.admitSynthesizedProviderAssignment(principal, {
            assignmentId: 'assignment-workflow',
            reservationId: 'reservation-workflow',
            synthesisKey: 'workflow-admit',
            synthesizedFrom: 'workday_demand',
            projectId: 'project-workflow',
            environment: 'local',
            providerSessionId: session.id,
            projectAgentClassId: 'class-workflow',
            mode: 'planning',
            workDayId: 'workday-workflow',
            requestedCredits: 6,
            executionProviderId: 'codex',
            laneId: 'engineering-lane',
            requiredCapabilities: ['engineering'],
        });
        expect(assignment).toMatchObject({ membershipId: approved.membershipId, reservationId: 'reservation-workflow', laneId: 'engineering-lane' });
        expect(await store.first(`SELECT lane_id FROM capacity_reservations WHERE id = ?`, ['reservation-workflow'])).toMatchObject({ lane_id: 'engineering-lane' });
        expect(grant).toMatchObject({ membershipId: approved.membershipId, status: 'active' });
        const settled = await settleCapacityReservationExactlyOnce(store, { settlementKey: 'workflow-settle', teamId: 'team-workflow', membershipId: approved.membershipId!, reservationId: 'reservation-workflow', assignmentId: 'assignment-workflow', actualCredits: 4, source: 'service_workflow' });
        const replay = await settleCapacityReservationExactlyOnce(store, { settlementKey: 'workflow-settle', teamId: 'team-workflow', membershipId: approved.membershipId!, reservationId: 'reservation-workflow', assignmentId: 'assignment-workflow', actualCredits: 4, source: 'service_workflow' });
        expect(settled.replayed).toBe(false);
        expect(replay.replayed).toBe(true);
        expect(await store.all(`SELECT lane_id FROM capacity_usage_actuals WHERE assignment_id = ?`, ['assignment-workflow'])).toEqual([
            expect.objectContaining({ lane_id: 'engineering-lane' }),
        ]);
    }
    finally {
        await database.close();
    }
});
});
