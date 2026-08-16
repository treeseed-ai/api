import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DataType,newDb } from 'pg-mem';
import { describe,expect,it,vi } from 'vitest';
import type { CapacityGovernanceDatabase } from '../../../../../src/api/capacity/database.ts';
import { terminalizeCapacityWorkdayAssignments } from '../../../../../src/api/capacity/services/capacity/workdays/lifecycle/workday-assignment-terminalization-service.ts';
import { MarketControlPlaneStore } from '../../../../../src/api/persistence/store.ts';
import { MarketPostgresDatabase } from '../../../../../src/api/support/market-postgres.ts';

const packageRoot = process.cwd();
const migrationRoot = existsSync(resolve(packageRoot, '../sdk/drizzle/market'))
	? resolve(packageRoot, '../sdk/drizzle/market')
	: resolve(packageRoot, 'node_modules/@treeseed/sdk/drizzle/market');

function harness() {
	const memory = newDb();
	memory.public.registerFunction({ name: 'replace', args: [DataType.text,DataType.text,DataType.text], returns: DataType.text,
		implementation: (value: string,search: string,replacement: string) => value.split(search).join(replacement) });
	memory.public.registerFunction({ name: 'md5', args: [DataType.text], returns: DataType.text, implementation: (value: string) => `md5:${value}` });
	const pg = memory.adapters.createPg();
	const database = MarketPostgresDatabase.fromPool(new pg.Pool(), { migrationRoot });
	return { database, store: new MarketControlPlaneStore({ repoRoot: packageRoot }, database) };
}

async function seedExpiredAssignment(store: MarketControlPlaneStore,now: string) {
	await store.ensureInitialized();
	await store.createTeam({ id: 'team-a', slug: 'team-a', name: 'team-a' });
	await store.run(`INSERT INTO capacity_providers (id, fingerprint, public_jwk_json, display_name, identity_version, status, metadata_json, created_at, updated_at) VALUES ('provider-a', 'sha256:provider-a', '{}', 'Provider A', 1, 'active', '{}', ?, ?)`, [now,now]);
	await store.run(`INSERT INTO capacity_provider_team_memberships (id, team_id, capacity_provider_id, status, approved_at, approved_by_id, metadata_json, created_at, updated_at) VALUES ('membership-a', 'team-a', 'provider-a', 'approved', ?, 'owner-a', '{}', ?, ?)`, [now,now,now]);
	await store.run(`INSERT INTO capacity_execution_providers (id, capacity_provider_id, display_name, adapter, status, capabilities_json, native_unit, quota_visibility, max_concurrent_runners, native_limits_json, metadata_json, created_at, updated_at) VALUES ('codex', 'provider-a', 'Codex', 'codex', 'active', '[]', 'credit', 'exact', 1, '[]', '{}', ?, ?)`, [now,now]);
	await store.run(`INSERT INTO projects (id, team_id, slug, name, metadata_json, created_at, updated_at) VALUES ('project-a', 'team-a', 'project-a', 'Project A', '{}', ?, ?)`, [now,now]);
	await store.run(`INSERT INTO project_agent_classes (id, team_id, project_id, slug, name, status, allowed_modes_json, required_capabilities_json, kernel_profile_json, kernel_policy_json, handler_refs_json, output_contracts_json, metadata_json, created_at, updated_at) VALUES ('class-a', 'team-a', 'project-a', 'engineer', 'Engineer', 'active', '["planning"]', '[]', '{}', '{}', '{}', '{}', '{}', ?, ?)`, [now,now]);
	await store.run(`INSERT INTO capacity_allocation_sets (id, team_id, version, status, effective_from, reserve_policy_json, slices_json, borrowing_rules_json, metadata_json, created_at, updated_at) VALUES ('allocation-a', 'team-a', 1, 'active', ?, '{"percent":0,"overflow":"deny"}', '[]', '[]', '{}', ?, ?)`, [now,now,now]);
	await store.run(`INSERT INTO capacity_grants (id, membership_id, capacity_provider_id, team_id, project_id, environment, status, execution_provider_ids_json, lane_ids_json, capabilities_json, allowed_modes_json, daily_agent_seconds_limit, monthly_agent_seconds_limit, max_concurrent_assignments, unmetered, metadata_json, created_at, updated_at) VALUES ('grant-a', 'membership-a', 'provider-a', 'team-a', 'project-a', 'local', 'active', '["codex"]', '[]', '[]', '["planning"]', 900, 900, 1, 0, '{}', ?, ?)`, [now,now]);
	await store.run(`INSERT INTO capacity_workday_runs (id, team_id, capacity_provider_id, scenario_id, status, environment, parameters_json, started_at, created_at, updated_at) VALUES ('run-a', 'team-a', 'provider-a', 'planning', 'cancelled', 'local', '{}', ?, ?, ?)`, [now,now,now]);
	await store.run(`INSERT INTO workday_capacity_envelopes (id, team_id, project_id, allocation_set_id, workday_run_id, status, started_at, envelope_json, metadata_json, created_at, updated_at) VALUES ('workday-a', 'team-a', 'project-a', 'allocation-a', 'run-a', 'cancelled', ?, '{"availableSeconds":900}', '{"grantId":"grant-a"}', ?, ?)`, [now,now,now]);
	await store.run(`INSERT INTO capacity_reservations (id, idempotency_key, admission_token, membership_id, grant_id, capacity_provider_id, execution_provider_id, allocation_set_id, allocation_version, allocation_slice_ids_json, policy_snapshot_json, project_agent_class_id, assignment_id, mode, team_id, project_id, work_day_id, state, requested_seconds, reserved_seconds, active_seconds, metadata_json, created_at, updated_at) VALUES ('reservation-a', 'admit-a', 'token-a', 'membership-a', 'grant-a', 'provider-a', 'codex', 'allocation-a', 1, '[]', '{}', 'class-a', 'assignment-a', 'planning', 'team-a', 'project-a', 'workday-a', 'reserved', 240, 240, 0, '{}', ?, ?)`, [now,now]);
	await store.run(`INSERT INTO capacity_provider_assignments (id, membership_id, team_id, project_id, capacity_provider_id, execution_provider_id, allocation_set_id, project_agent_class_id, reservation_id, work_day_id, mode, status, lease_state, state_version, attempt_count, capacity_envelope_json, decision_input_json, lifecycle_code, metadata_json, created_at, updated_at) VALUES ('assignment-a', 'membership-a', 'team-a', 'project-a', 'provider-a', 'codex', 'allocation-a', 'class-a', 'reservation-a', 'workday-a', 'planning', 'expired', 'expired', 2, 1, '{}', '{}', 'expired_lease_side_effect_evidence_present', '{}', ?, ?)`, [now,now]);
	await store.run(`INSERT INTO capacity_workday_demands (id, team_id, project_id, workday_run_id, workday_id, source_type, source_id, mode, project_agent_class_id, agent_id, handler_id, activity_type, status, priority, requested_seconds, idempotency_key, payload_json, metadata_json, available_at, assignment_id, admitted_at, created_at, updated_at) VALUES ('demand-a', 'team-a', 'project-a', 'run-a', 'workday-a', 'objective', 'objective-a', 'planning', 'class-a', 'agent-a', 'writer', 'planning', 'admitted', 1, 240, 'demand-a', '{}', '{}', ?, 'assignment-a', ?, ?, ?)`, [now,now,now,now]);
}

describe('workday assignment terminalization service', () => {
	it('counts provider-completed mutation work as unfinished until exact content integration',async()=>{
		const queries:string[]=[];
		const database={ensureInitialized:vi.fn(async()=>undefined),run:vi.fn(async()=>undefined),batch:vi.fn(async()=>[]),
			all:vi.fn(async(query:string)=>{queries.push(query);return [];}),
			first:vi.fn(async(query:string)=>{queries.push(query);return query.includes('COUNT(*) AS assignment_count')
				? {assignment_count:1,completed_assignments:0,failed_assignments:0,unfinished_assignments:1}:null;})} as unknown as CapacityGovernanceDatabase;
		await expect(terminalizeCapacityWorkdayAssignments(database,'team-a','conversation-a',{now:'2026-08-15T12:00:00.000Z'}))
			.resolves.toMatchObject({assignmentCount:1,completedAssignments:0,unfinishedAssignmentCount:1});
		const totals=queries.filter((query)=>query.includes('COUNT(*) AS assignment_count'));
		expect(totals).toHaveLength(2);
		for(const query of totals)expect(query).toContain("event_type = 'assignment.content.integrated'");
		for(const query of totals)expect(query).toContain("event_type = 'assignment.content.integration_required'");
	});

	it('preserves an exact durable required-response suspension as a terminal child outcome',async()=>{
		const queries:string[]=[];
		const database={ensureInitialized:vi.fn(async()=>undefined),run:vi.fn(async()=>undefined),batch:vi.fn(async()=>[]),
			all:vi.fn(async(query:string)=>{queries.push(query);return [];}),
			first:vi.fn(async(query:string)=>{queries.push(query);return query.includes('COUNT(*) AS assignment_count')
				? {assignment_count:1,completed_assignments:0,failed_assignments:0,unfinished_assignments:0}:null;})} as unknown as CapacityGovernanceDatabase;
		await expect(terminalizeCapacityWorkdayAssignments(database,'team-a','conversation-a',{now:'2026-08-15T12:00:00.000Z'}))
			.resolves.toMatchObject({assignmentCount:1,failedAssignments:0,unfinishedAssignmentCount:0});
		const selection=queries.find((query)=>query.includes('SELECT assignment.id, assignment.membership_id'))??'';
		expect(selection).toContain("assignment.lifecycle_code = 'discussion_response_required'");
		expect(selection).toContain("invocation.status = 'suspended'");
		expect(selection).toContain('invocation.final_message_ref IS NOT NULL');
	});

	it('leaves assignment and mode-run state recoverable when settlement cannot commit', async () => {
		const run = vi.fn(async () => undefined);
		const database = {
			ensureInitialized: vi.fn(async () => undefined),
			run,
			batch: vi.fn(async () => undefined),
			first: vi.fn(async <T extends Record<string, unknown>>(query: string) => {
				if (query.includes('COUNT(*) AS assignment_count')) {
					return { assignment_count: 1, completed_assignments: 0, failed_assignments: 0, unfinished_assignments: 1 } as unknown as T;
				}
				return null;
			}),
			all: vi.fn(async <T extends Record<string, unknown>>(query: string) => (query.includes('SELECT assignment.id, assignment.membership_id')
				? [{ id: 'assignment-a', membership_id: 'membership-a', reservation_id: 'reservation-missing', state_version: 4 }]
				: []) as unknown as T[]),
		};

		await expect(terminalizeCapacityWorkdayAssignments(database as unknown as CapacityGovernanceDatabase, 'team-a', 'run-a', {
			now: '2026-07-17T18:00:00.000Z',
		})).rejects.toMatchObject({ code: 'capacity_reservation_not_found' });
		expect(run).not.toHaveBeenCalled();
	});

	it('releases an unsettled expired reservation without erasing preserved assignment evidence', async () => {
		const { database,store } = harness();
		try {
			const now = '2026-08-12T08:30:00.000Z';
			await seedExpiredAssignment(store,now);
			await terminalizeCapacityWorkdayAssignments(store,'team-a','run-a',{ now,settlementKeyPrefix:'workday-cancel',demandStatus:'cancelled' });
			expect(await store.first(`SELECT status, lease_state, lifecycle_code FROM capacity_provider_assignments WHERE id = 'assignment-a'`))
				.toEqual({ status:'expired',lease_state:'expired',lifecycle_code:'expired_lease_side_effect_evidence_present' });
			expect(await store.first(`SELECT state, released_seconds FROM capacity_reservations WHERE id = 'reservation-a'`))
				.toEqual({ state:'consumed',released_seconds:240 });
			expect(await store.first(`SELECT COUNT(*) AS total FROM capacity_ledger_entries WHERE reservation_id = 'reservation-a' AND phase = 'task_completed_actual_settlement'`))
				.toEqual({ total:1 });
			expect(await store.first(`SELECT status FROM capacity_workday_demands WHERE id = 'demand-a'`)).toEqual({ status:'cancelled' });
			await terminalizeCapacityWorkdayAssignments(store,'team-a','run-a',{ now,settlementKeyPrefix:'workday-cancel',demandStatus:'cancelled' });
			expect(await store.first(`SELECT COUNT(*) AS total FROM capacity_ledger_entries WHERE reservation_id = 'reservation-a' AND phase = 'task_completed_actual_settlement'`))
				.toEqual({ total:1 });
		} finally { await database.close(); }
	});

	it('compare-and-set preserves a suspension selected by a stale recovery scan',async()=>{
		const {database,store}=harness();
		try{
			const now='2026-08-15T12:00:00.000Z';await seedExpiredAssignment(store,now);
			await store.run(`UPDATE capacity_provider_assignments SET status='returned',lease_state='released',execution_kind='conversation',lifecycle_code='discussion_response_required' WHERE id='assignment-a'`);
			await store.run(`INSERT INTO agent_invocation_requests (id,team_id,project_id,project_agent_class_id,agent_id,agent_revision,mode,execution_kind,trigger_kind,status,scope_hash,content_refs_json,recipients_json,blocking_state_json,subject_digest,priority_class,available_at,idempotency_key,request_digest,assignment_id,final_message_ref,response_json,metadata_json,requested_at,updated_at,completed_at) VALUES ('invocation-a','team-a','project-a','class-a','agent-a','revision-a','planning','conversation','discussion','suspended','scope-a','[]','[]','{}','subject-a','human-interactive',?,'invocation-a','digest-a','assignment-a','src/content/discussion-messages/d/m.mdx','{}','{}',?,?,?)`,[now,now,now,now]);
			let stale=true;const wrapped=new Proxy(store,{get(target,property){if(property==='all')return async(query:string,params:unknown[])=>{if(stale&&query.includes('SELECT assignment.id, assignment.membership_id')){stale=false;return [{id:'assignment-a',membership_id:'membership-a',reservation_id:'reservation-a',state_version:2,lifecycle_output_json:'{}'}];}return target.all(query,params);};const value=target[property as keyof typeof target];return typeof value==='function'?value.bind(target):value;}}) as unknown as CapacityGovernanceDatabase;
			await terminalizeCapacityWorkdayAssignments(wrapped,'team-a','run-a',{now,settlementKeyPrefix:'stale-scan'});
			expect(await store.first(`SELECT status,lease_state,lifecycle_code FROM capacity_provider_assignments WHERE id='assignment-a'`)).toEqual({status:'returned',lease_state:'released',lifecycle_code:'discussion_response_required'});
		}finally{await database.close();}
	});
});
