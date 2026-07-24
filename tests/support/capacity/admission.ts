import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DataType, newDb } from 'pg-mem';
import type { CapacityAdmissionInput } from '@treeseed/sdk/agent-capacity/allocation';
import { MarketPostgresDatabase } from '../../../src/api/support/market-postgres.js';
import { MarketControlPlaneStore } from '../../../src/api/persistence/store.js';
import { createCapacityControlPlane, type CapacityControlPlaneStore } from '../../../src/api/capacity/control-plane.ts';

const packageRoot = process.cwd();
const migrationRoot = existsSync(resolve(packageRoot, '../sdk/drizzle/market'))
	? resolve(packageRoot, '../sdk/drizzle/market')
	: resolve(packageRoot, 'node_modules/@treeseed/sdk/drizzle/market');

export function createCapacityAdmissionTestHarness() {
	const memory = newDb();
	memory.public.registerFunction({ name: 'md5', args: [DataType.text], returns: DataType.text, implementation: (value: string) => `md5:${value}` });
	const pg = memory.adapters.createPg();
	const database = MarketPostgresDatabase.fromPool(new pg.Pool(), { migrationRoot });
	const store = createCapacityControlPlane(new MarketControlPlaneStore({ repoRoot: packageRoot }, database));
	return { database, store };
}

export function capacityAdmissionInput(requestedCredits: number, committed = 0, now = new Date().toISOString()): CapacityAdmissionInput {
	const nowMs = Date.parse(now);
	return {
		now,
		request: { teamId: 'team-a', providerId: 'provider-a', membershipId: 'membership-a', projectId: 'project-a', environment: 'local', agentClassId: 'class-a', mode: 'planning', executionProviderId: 'codex', laneId: 'lane-a', requiredCapabilities: ['engineering'], requestedCredits },
		membership: { id: 'membership-a', teamId: 'team-a', providerId: 'provider-a', status: 'approved' },
		availability: { status: 'open', availableFrom: new Date(nowMs - 60_000).toISOString(), availableUntil: new Date(nowMs + 60_000).toISOString() },
		grant: { schemaVersion: 2, id: 'grant-a', membershipId: 'membership-a', teamId: 'team-a', providerId: 'provider-a', projectId: 'project-a', environment: 'local', status: 'active', executionProviderIds: ['codex'], laneIds: ['lane-a'], capabilities: ['engineering'], allowedModes: ['planning'], dailyCreditLimit: 10, monthlyCreditLimit: 20, maxConcurrentAssignments: 1, unmetered: false },
		workday: { id: 'workday-a', status: 'active', totalCredits: 10, committedCredits: committed },
		allocationSet: { schemaVersion: 2, id: 'allocation-a', teamId: 'team-a', version: 1, status: 'active', effectiveFrom: new Date(nowMs - 60_000).toISOString(), reservePolicy: { percent: 0, overflow: 'deny' }, slices: [{ id: 'project:project-a', scope: 'project', targetId: 'project-a', policy: { minPercent: 0, targetPercent: 100, maxPercent: 100, hardCapPercent: 100 } }], borrowingRules: [] },
		allocationSliceIds: ['project:project-a'],
		committedCreditsBySlice: { 'project:project-a': committed },
		providerCapacity: { availableCredits: 10 - committed, availableConcurrentAssignments: 1 },
		providerLocalLimits: { availableCredits: 10 - committed, availableConcurrentAssignments: 1 },
		grantCommitted: { dailyCredits: committed, monthlyCredits: committed, activeAssignments: 0 },
	};
}

export async function seedCapacityAdmissionDependencies(store: CapacityControlPlaneStore, now: string) {
	await store.createTeam({ id: 'team-a', slug: 'team-a', name: 'team-a' });
	await store.run(`INSERT INTO capacity_providers (id, fingerprint, public_jwk_json, display_name, identity_version, status, metadata_json, created_at, updated_at) VALUES ('provider-a', 'sha256:provider-a', '{}', 'Provider A', 1, 'active', '{}', ?, ?)`, [now, now]);
	await store.run(`INSERT INTO capacity_provider_team_memberships (id, team_id, capacity_provider_id, status, approved_at, approved_by_id, metadata_json, created_at, updated_at) VALUES ('membership-a', 'team-a', 'provider-a', 'approved', ?, 'owner-a', '{}', ?, ?)`, [now, now, now]);
	await store.run(`INSERT INTO capacity_execution_providers (id, capacity_provider_id, display_name, adapter, status, capabilities_json, native_unit, quota_visibility, max_concurrent_runners, native_limits_json, metadata_json, created_at, updated_at) VALUES ('codex', 'provider-a', 'Codex', 'codex', 'active', '["engineering"]', 'wall_minute', 'exact', 1, '[]', '{}', ?, ?)`, [now, now]);
	await store.run(`INSERT INTO capacity_provider_lanes (id, capacity_provider_id, execution_provider_id, display_name, status, capabilities_json, max_concurrent_runners, native_limits_json, metadata_json, created_at, updated_at) VALUES ('lane-a', 'provider-a', 'codex', 'Lane A', 'active', '["engineering"]', 1, '[]', '{}', ?, ?)`, [now, now]);
	await store.run(`INSERT INTO projects (id, team_id, slug, name, metadata_json, created_at, updated_at) VALUES ('project-a', 'team-a', 'project-a', 'Project A', '{}', ?, ?)`, [now, now]);
	await store.run(`INSERT INTO project_agent_classes (id, team_id, project_id, slug, name, status, allowed_modes_json, required_capabilities_json, kernel_profile_json, kernel_policy_json, handler_refs_json, output_contracts_json, metadata_json, created_at, updated_at) VALUES ('class-a', 'team-a', 'project-a', 'engineer', 'Engineer', 'active', '["planning"]', '["engineering"]', '{}', '{}', '{}', '{}', '{}', ?, ?)`, [now, now]);
	await store.run(`INSERT INTO capacity_allocation_sets (id, team_id, version, status, effective_from, reserve_policy_json, slices_json, borrowing_rules_json, metadata_json, created_at, updated_at) VALUES ('allocation-a', 'team-a', 1, 'active', ?, '{"percent":0,"overflow":"deny"}', '[{"id":"project:project-a","scope":"project","targetId":"project-a","policy":{"minPercent":0,"targetPercent":100,"maxPercent":100,"hardCapPercent":100}}]', '[]', '{}', ?, ?)`, [now, now, now]);
	await store.run(`INSERT INTO capacity_grants (id, membership_id, capacity_provider_id, team_id, project_id, environment, status, execution_provider_ids_json, lane_ids_json, capabilities_json, allowed_modes_json, daily_credit_limit, monthly_credit_limit, max_concurrent_assignments, unmetered, metadata_json, created_at, updated_at) VALUES ('grant-a', 'membership-a', 'provider-a', 'team-a', 'project-a', 'local', 'active', '["codex"]', '["lane-a"]', '["engineering"]', '["planning"]', 10, 20, 1, 0, '{}', ?, ?)`, [now, now]);
}
