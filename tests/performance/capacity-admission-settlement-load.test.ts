import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { commitCapacityAdmission } from '../../src/api/capacity/services/admission-service.ts';
import { settleCapacityReservationExactlyOnce } from '../../src/api/capacity/services/settlement-service.ts';
import {
	capacityAdmissionInput,
	createCapacityAdmissionTestHarness,
	seedCapacityAdmissionDependencies,
} from '../support/capacity/admission.ts';
import {
	capacityProviderTestIdentity,
	capacityProviderTestSubmission,
	createCapacityRegistrationTestHarness,
	ensureCapacityTestTeam,
} from '../support/capacity/registration.ts';

const CONCURRENCY = 10;
const LOCAL_P95_LIMIT_MS = 5_000;
// pg-mem serializes substantial portions of concurrent lease-candidate evaluation.
// This is an emulator regression guard; real PostgreSQL concurrency has a separate service proof.
const LOCAL_LEASE_P95_LIMIT_MS = 25_000;
const LOCAL_TOTAL_LIMIT_MS = 30_000;

function percentile(values: number[], fraction: number) {
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))] ?? 0;
}

async function measured<T>(operation: () => Promise<T>) {
	const started = performance.now();
	const value = await operation();
	return { value, durationMs: performance.now() - started };
}

describe('capacity admission and settlement bounded local load profile', () => {
	it('verifies and persists concurrent signed provider registrations within the local regression budget', async () => {
		const { database, store, service } = createCapacityRegistrationTestHarness();
		try {
			await store.ensureInitialized();
			await ensureCapacityTestTeam(store, 'team-registration-load');
			const key = await service.revealRegistrationKey('team-registration-load', 'load-owner');
			const identities = Array.from({ length: CONCURRENCY }, () => capacityProviderTestIdentity());
			const registrations = await Promise.all(identities.map((identity, index) => measured(() =>
				service.submitRegistration(
					key.registrationKey,
					capacityProviderTestSubmission(identity, 'team-registration-load', `load-proof-${index}`),
					'/v1/provider-registrations',
					`load-registration-${index}`,
					`198.51.100.${index + 1}`,
				))));
			const registrationP95Ms = percentile(registrations.map((entry) => entry.durationMs), 0.95);
			expect(new Set(registrations.map(({ value }) => value.id)).size).toBe(CONCURRENCY);
			expect(await store.first(`SELECT COUNT(*) AS count FROM capacity_provider_registration_requests WHERE team_id = 'team-registration-load' AND status = 'pending'`))
				.toEqual({ count: CONCURRENCY });
			expect(registrationP95Ms).toBeLessThan(LOCAL_P95_LIMIT_MS);
			console.info(JSON.stringify({
				profile: 'capacity-registration-local',
				concurrency: CONCURRENCY,
				registrationP95Ms,
			}));
		} finally {
			await database.close();
		}
	}, 60_000);

	it('admits and exactly-once settles concurrent independent assignments within the local regression budget', async () => {
		const { database, store } = createCapacityAdmissionTestHarness();
		try {
			await store.ensureInitialized();
			const now = new Date().toISOString();
			await seedCapacityAdmissionDependencies(store, now);
			await store.run(`UPDATE capacity_grants SET daily_credit_limit = 100, monthly_credit_limit = 100, max_concurrent_assignments = ? WHERE id = 'grant-a'`, [CONCURRENCY]);
			await store.run(`UPDATE capacity_execution_providers SET max_concurrent_runners = ? WHERE id = 'codex'`, [CONCURRENCY]);
			await store.run(`UPDATE capacity_provider_lanes SET max_concurrent_runners = ? WHERE id = 'lane-a'`, [CONCURRENCY]);
			await store.run(`INSERT INTO workday_capacity_envelopes (id, team_id, project_id, allocation_set_id, status, started_at, envelope_json, metadata_json, created_at, updated_at) VALUES ('workday-load', 'team-a', 'project-a', 'allocation-a', 'active', ?, '{"availableCredits":100,"totalCredits":100}', '{}', ?, ?)`, [now, now, now]);
			await store.run(`INSERT INTO capacity_provider_availability_sessions (id, membership_id, team_id, capacity_provider_id, environment, status, sequence, opened_at, refreshed_at, expires_at, available_from, available_until, execution_providers_json, capabilities_json, native_limits_json, runner_pressure_json, constraints_json, metadata_json, created_at, updated_at) VALUES ('session-load', 'membership-a', 'team-a', 'provider-a', 'local', 'open', 1, ?, ?, ?, ?, ?, '[{"id":"codex","kind":"codex"}]', '["engineering"]', ?, ?, ?, '{}', ?, ?)`, [
				now,
				now,
				new Date(Date.now() + 60_000).toISOString(),
				now,
				new Date(Date.now() + 60_000).toISOString(),
				JSON.stringify({ availableCredits: 100, maxConcurrentRunners: CONCURRENCY }),
				JSON.stringify({ activeRunners: 0, maxConcurrentRunners: CONCURRENCY }),
				JSON.stringify({ availableCredits: 100, activeRunners: 0, maxConcurrentRunners: CONCURRENCY }),
				now,
				now,
			]);
			const input = capacityAdmissionInput(1, 0, now);
			input.grant = { ...input.grant!, dailyCreditLimit: 100, monthlyCreditLimit: 100, maxConcurrentAssignments: CONCURRENCY };
			input.workday = { id: 'workday-load', status: 'active', totalCredits: 100, committedCredits: 0 };
			input.providerCapacity = { availableCredits: 100, availableConcurrentAssignments: CONCURRENCY };
			input.providerLocalLimits = { availableCredits: 100, availableConcurrentAssignments: CONCURRENCY };

			const totalStarted = performance.now();
			const admissions = await Promise.all(Array.from({ length: CONCURRENCY }, (_, index) => measured(() =>
				commitCapacityAdmission(store, {
					idempotencyKey: `load-admission-${index}`,
					admission: input,
					reservationId: `load-reservation-${index}`,
					assignmentId: `load-assignment-${index}`,
					assignment: { projectAgentClassId: 'class-a', workDayId: 'workday-load', providerSessionId: 'session-load' },
				}))));
			const principal = { membershipId: 'membership-a', teamId: 'team-a', capacityProviderId: 'provider-a' };
			const leases = await Promise.all(Array.from({ length: CONCURRENCY }, (_, index) => measured(async () => {
				for (let attempt = 0; attempt < CONCURRENCY * 2; attempt += 1) {
					const leased = await store.leaseNextProviderAssignment(principal, {
						sessionId: 'session-load',
						runnerId: `load-runner-${index}`,
					});
					if (leased.assignment) return leased;
				}
				throw new Error(`load runner ${index} did not acquire an assignment`);
			})));
			const renewals = await Promise.all(leases.map(({ value }, index) => measured(() =>
				store.renewProviderAssignmentLease(principal, value.assignment!.id, {
					leaseToken: value.leaseToken,
					runnerId: `load-runner-${index}`,
				}))));
			const settlements = await Promise.all(admissions.map(({ value }, index) => measured(() =>
				settleCapacityReservationExactlyOnce(store, {
					settlementKey: `load-settlement-${index}`,
					teamId: 'team-a',
					membershipId: 'membership-a',
					reservationId: String(value.reservation.id),
					assignmentId: String(value.assignment.id),
					actualCredits: 1,
					source: 'capacity_local_load_profile',
				}))));
			const totalMs = performance.now() - totalStarted;
			const admissionP95Ms = percentile(admissions.map((entry) => entry.durationMs), 0.95);
			const leaseP95Ms = percentile(leases.map((entry) => entry.durationMs), 0.95);
			const renewalP95Ms = percentile(renewals.map((entry) => entry.durationMs), 0.95);
			const settlementP95Ms = percentile(settlements.map((entry) => entry.durationMs), 0.95);

			expect(new Set(leases.map(({ value }) => value.assignment!.id)).size).toBe(CONCURRENCY);
			expect(renewals.every(({ value }) => value?.assignment.status === 'leased')).toBe(true);
			expect(await store.first(`SELECT COUNT(*) AS count FROM capacity_reservations WHERE id LIKE 'load-reservation-%' AND state = 'consumed'`))
				.toEqual({ count: CONCURRENCY });
			expect(await store.first(`SELECT COUNT(*) AS count FROM capacity_ledger_entries WHERE settlement_key LIKE 'load-settlement-%'`))
				.toEqual({ count: CONCURRENCY });
			expect(await store.first(`SELECT COUNT(*) AS count FROM capacity_usage_actuals WHERE assignment_id LIKE 'load-assignment-%' AND accounting_mode = 'aggregate'`))
				.toEqual({ count: CONCURRENCY });
			expect(admissionP95Ms).toBeLessThan(LOCAL_P95_LIMIT_MS);
			expect(leaseP95Ms).toBeLessThan(LOCAL_LEASE_P95_LIMIT_MS);
			expect(renewalP95Ms).toBeLessThan(LOCAL_P95_LIMIT_MS);
			expect(settlementP95Ms).toBeLessThan(LOCAL_P95_LIMIT_MS);
			expect(totalMs).toBeLessThan(LOCAL_TOTAL_LIMIT_MS);
			console.info(JSON.stringify({
				profile: 'capacity-admission-settlement-local',
				concurrency: CONCURRENCY,
				admissionP95Ms,
				leaseP95Ms,
				renewalP95Ms,
				settlementP95Ms,
				totalMs,
			}));
		} finally {
			await database.close();
		}
	}, 60_000);
});
