import { readFileSync } from 'node:fs';
import type { CapacityGovernanceDatabase } from '../../../../../../../src/api/capacity/database.ts';
import { livingAllocationInputs } from '../../../../../../../src/api/capacity/services/capacity/assignments/admission/living-allocation-inputs.ts';
import { splitPostgresSqlStatements } from '../../../../../../../src/api/persistence/postgres-sql-statements.ts';
import { closeoutDatabase, now } from './closeout-sql-fixture.ts';

type Scope = { capacityProvider: string; executionProvider: string; model: string; capability: string;
	agentClass: string; activity: string; accountingMode: string; status: string; code: string | null;
	expected: number; active: number };
const selected: Scope = { capacityProvider: 'provider', executionProvider: 'native-test-provider', model: 'model-test',
	capability: 'writing', agentClass: 'arbitrary-author', activity: 'report', accountingMode: 'aggregate',
	status: 'completed', code: null, expected: 300, active: 100 };

/** Original SQL authority and actual owning selector; supplied usage rows are isolated test data, not live accounting proof. */
export async function calibrationDatabase() {
	const fixture = await closeoutDatabase();
	try {
		const original = splitPostgresSqlStatements(readFileSync('drizzle/control-plane/0000_control_plane.sql', 'utf8'))
			.filter(sql => sql.startsWith('CREATE TABLE "capacity_usage_actuals" ('));
		if (original.length !== 1) throw new Error('Missing or duplicate original usage DDL');
		await fixture.db.exec(original[0]!);
		await fixture.query(`UPDATE execution_nodes SET status='ready',estimate_json=?,required_capabilities_json=?`,
			[JSON.stringify({ expectedSeconds: 300, maximumSeconds: 600 }), JSON.stringify(['writing'])]);
		const stored = (await fixture.reads.get('team', 'workday'))!;
		const run = { ...stored, parameters: { ...stored.parameters, scheduledProjectIds: ['project'] } };
		const observation = { day: now.slice(0, 10), observedAt: now, healthy: true, activeSeconds: 10, reservedSeconds: 0 };
		const providers: Parameters<typeof livingAllocationInputs>[1]['providers'] = [{ id: selected.executionProvider,
			runtimeBuild: 'isolated-selector-test', status: 'ready', capabilities: ['writing'], offers: [], maxConcurrentRunners: 1, lanes: [],
			accountingLimits: { modelConfigurationId: selected.model, dailyActiveSecondsLimit: 1000,
				capabilityLimits: { writing: { dailyActiveSecondsLimit: 1000 } } },
			accountingObservation: { modelUsage: observation, capabilityUsage: { writing: observation } } }];
		const input: Parameters<typeof livingAllocationInputs>[1] = { run, runs: [run], providers,
			capacityProviderId: selected.capacityProvider, capabilityId: selected.capability,
			agentClass: selected.agentClass, activity: selected.activity, now };
		async function seed(id: string, order: number, overrides: Partial<Scope> = {}) {
			const scope = { ...selected, ...overrides };
			const createdAt = new Date(Date.parse('2026-10-02T20:00:00.000Z') + order * 1000).toISOString();
			const attempt = { estimate: { expectedSeconds: scope.expected }, limits: { maximumSeconds: 600 },
				provider: { modelConfigurationId: scope.model, executionCapabilityId: scope.capability },
				effectiveProfile: { activity: scope.activity } };
			await fixture.query(`INSERT INTO execution_nodes (id,team_id,project_id,kind,source_ref_json,rule_revision,
				node_revision,agent_class,status,graph_revision_created,graph_revision_updated,created_at,updated_at)
				VALUES (?,'team','project','reporting','{}',1,1,?,'completed',1,1,?,?)`, [`node-${id}`, scope.agentClass, createdAt, createdAt]);
			await fixture.query(`INSERT INTO capacity_provider_assignments (id,membership_id,team_id,project_id,capacity_provider_id,
				execution_provider_id,project_agent_class_id,work_day_id,mode,status,lifecycle_code,execution_node_id,
				assignment_attempt_json,created_at,updated_at)
				VALUES (?,'membership','team','project',?,?,?,'workday','acting',?,?,?,?,?,?)`,
				[`assignment-${id}`, scope.capacityProvider, scope.executionProvider, scope.agentClass, scope.status, scope.code,
					`node-${id}`, JSON.stringify(attempt), createdAt, createdAt]);
			await fixture.query(`INSERT INTO capacity_usage_actuals (id,idempotency_key,project_id,task_signature,assignment_id,
				assignment_attempt,usage_dimension,accounting_mode,business_model,active_seconds,elapsed_seconds,created_at)
				VALUES (?,?,'project',?,?,1,'active-seconds',?,'isolated-test',?,?,?)`,
				[id, id, `task-${id}`, `assignment-${id}`, scope.accountingMode, scope.active, scope.active, createdAt]);
		}
		const calculate = () => livingAllocationInputs(fixture.store as unknown as CapacityGovernanceDatabase, input);
		return { ...fixture, seed, calculate, input, providerId: selected.executionProvider };
	} catch (error) { await fixture.db.close(); throw error; }
}
