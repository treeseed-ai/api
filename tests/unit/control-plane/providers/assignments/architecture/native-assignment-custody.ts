import {expect} from 'vitest';
import type {AssignmentAttempt} from '@treeseed/sdk/agent-capacity';
import type {createControlPlanePostgresDatabase} from '../../../../../../src/api/support/control-plane-postgres.ts';

/** Transfer controlled original fixture inputs through the original migrations.
 * No admission, provider execution or generated usage is claimed. */
export async function copyNativeAssignmentCustody(left:ReturnType<typeof createControlPlanePostgresDatabase>,supplied:{attempt:AssignmentAttempt;query:(sql:string,params?:unknown[])=>Promise<{rows:Record<string,unknown>[]}>},tables:readonly string[]){
	await seedNativeAssignmentCustody(left,supplied.attempt);
	for (const table of tables) {
		const current = await left.pool.query<{ column_name: string }>('SELECT column_name FROM information_schema.columns WHERE table_schema=\'public\' AND table_name=$1', [table]);
		const names = new Set(current.rows.map(column => column.column_name));
		for (const row of (await supplied.query(`SELECT * FROM ${table}`)).rows) {
			// Full owning migrations remove retired nullable columns that the
			// older original-DDL fixture still exposes. Never discard a fact.
			for (const column of Object.keys(row).filter(name => !names.has(name))) {
				const emptyRetired = column === 'decision_input_json' ? '{}' : column === 'allocation_slice_ids_json' ? '[]' : null;
				expect(row[column], `${table}.${column}`).toBe(emptyRetired);
			}
			const columns = Object.keys(row).filter(name => names.has(name)), values = columns.map(name => row[name]);
			await left.pool.query(`INSERT INTO ${table} (${columns.map(name => `"${name}"`).join(',')}) VALUES (${values.map((_, index) => `$${index + 1}`).join(',')})`, values);
		}
	}
}

/** Original owning fixture setup, also used when no raw assignment rows are copied. */
export async function seedNativeAssignmentCustody(left:ReturnType<typeof createControlPlanePostgresDatabase>,attempt:AssignmentAttempt){
	const now = attempt.createdAt;
	await left.pool.query(`INSERT INTO projects (id,team_id,slug,name,created_at,updated_at) VALUES ('project','team','project','Project',$1,$1)`, [now]);
	for (const id of ['isolated-class-row', attempt.agentClass]) await left.pool.query(
		`INSERT INTO project_agent_classes (id,team_id,project_id,slug,name,created_at,updated_at) VALUES ($1,'team','project',$1,$1,$2,$2)`, [id, now]);
	await left.pool.query(`INSERT INTO capacity_providers (id,fingerprint,public_jwk_json,display_name,created_at,updated_at) VALUES ('provider','recovery-input','{}','Controlled recovery provider',$1,$1)`, [now]);
	await left.pool.query(`INSERT INTO capacity_provider_team_memberships (id,team_id,capacity_provider_id,approved_at,approved_by_id,created_at,updated_at) VALUES ('membership','team','provider',$1,'operator',$1,$1)`, [now]);
	await left.pool.query(`INSERT INTO capacity_execution_providers (id,capacity_provider_id,display_name,adapter,native_unit,max_concurrent_runners,created_at,updated_at) VALUES ($1,'provider','Controlled executor','codex','seconds',1,$2,$2)`, [attempt.provider.executionProviderId, now]);
}
