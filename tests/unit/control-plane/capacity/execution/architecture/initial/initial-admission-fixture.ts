import { readFileSync } from 'node:fs';
import { DEFAULT_WORKDAY_POLICY, assignmentAttemptSchema, calculateAssignmentAllocation, compileWorkday, allocateWorkdayCapacity,
	selectFairReadyNode, type AssignmentAttempt } from '@treeseed/sdk/agent-capacity';
import { settlementDatabase } from '../../../accounting/architecture/settlement-fixture.ts';
import { replayAttempt } from '../admission-replay-fixture.ts';
import { splitPostgresSqlStatements } from '../../../../../../../src/api/persistence/postgres-sql-statements.ts';
import { ProviderAssignmentRepository } from '../../../../../../../src/api/capacity/repositories/capacity/assignments/assignment.ts';
import { admitLivingExecutionAssignment } from '../../../../../../../src/api/capacity/services/capacity/assignments/admission/living-execution-admission.ts';

// Conflicting supplied identities are not authenticated principals. The
// original admission boundary must reject them before consulting/writing SQL.
export function invalidAdmissionBindings(original: Parameters<typeof admitLivingExecutionAssignment>[1]) {
	const variants: Array<{ name: string; input: typeof original }> = [];
	const add = (name: string, edit: (input: typeof original) => void) => {
		const input = structuredClone(original); edit(input); variants.push({ name, input });
	};
	add('foreign-team', input => { input.principal.teamId = 'foreign-team'; });
	add('foreign-provider', input => { input.principal.capacityProviderId = 'foreign-provider'; });
	add('foreign-executor', input => { input.executionProviderId = 'foreign-executor'; });
	add('foreign-model', input => { input.accountingLimits.modelConfigurationId = 'foreign-model'; });
	for (const field of ['teamId', 'capacityProviderId', 'membershipId'] as const) for (const value of ['', '   ', null, undefined, 7]) {
		add(`${field}:${String(value)}`, input => { Object.assign(input.principal, { [field]: value }); });
	}
	for (const field of ['providerSessionId', 'executionProviderId', 'laneId'] as const) {
		add(`${field}:empty`, input => { input[field] = ''; });
	}
	return variants;
}

// Fresh original DDL and native transactions. This fixture supplies reviewed
// authority and availability; it does not prove governance or native provider usage.
export async function initialAdmission(admissionNow: string | (() => string) = '2026-10-02T21:00:20.000Z', completeOriginalTables = false) {
	const base = await settlementDatabase();
	try {
		for (const table of ['capacity_provider_assignments', 'capacity_reservations', 'capacity_usage_actuals',
			'capacity_ledger_entries', 'capacity_admission_counters', 'capacity_reservation_counter_claims', 'execution_nodes', 'audit_events']) {
			await base.query(`DELETE FROM ${table}`);
		}
		const initial = splitPostgresSqlStatements(readFileSync('drizzle/control-plane/0000_control_plane.sql', 'utf8'));
		// Apply the original migration to the represented owning tables. Do not
		// widen a copied legacy CHECK or invent a test-only lane definition.
		for (const statement of splitPostgresSqlStatements(readFileSync('drizzle/control-plane/0002_service_principals.sql', 'utf8'))) {
			if (/^(?:ALTER TABLE|UPDATE) "(?:capacity_provider_assignments|capacity_reservations|capacity_ledger_entries)"/u.test(statement)) await base.db.exec(statement);
		}
		if (completeOriginalTables) {
			// Read the native catalog once and apply the same missing original DDL
			// in one batch. Each scenario still owns a fresh database; no authority
			// clock is created until this bootstrap has completed.
			const existing = await base.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public'");
			const names = new Set(existing.rows.map(row => row.table_name));
			const missing: string[] = [];
			for (const statement of initial) {
				const table = /^CREATE TABLE "([a-z0-9_]+)" \(/u.exec(statement)?.[1];
				if (!table) continue;
				if (!names.has(table)) missing.push(statement);
			}
			if (missing.length) await base.db.exec(`${missing.join(';\n')};`);
			await base.db.exec(readFileSync('drizzle/control-plane/0008_capability_ontology.sql', 'utf8'));
		}
		for (const table of ['capacity_provider_availability_sessions', 'treedx_proxy_handles']) {
			const ddl = initial.filter(sql => sql.startsWith(`CREATE TABLE "${table}" (`));
			if (ddl.length !== 1) throw new Error(`Missing original ${table} DDL`);
			if (!completeOriginalTables) await base.db.exec(ddl[0]!);
		}
		const source = replayAttempt();
		const now = typeof admissionNow === 'function' ? admissionNow() : admissionNow;
		const attempt = assignmentAttemptSchema.parse({ ...source, status: 'created', createdAt: now,
			deadline: new Date(Date.parse(now) + 3_000).toISOString(), attempt: 1, graphRevision: 2, nodeRevision: 1 });
		const plan = { ...compileWorkday({ id: attempt.workdayId, teamId: attempt.teamId, policyId: 'default',
			policyRevision: 1, executionMode: 'simulation', startsAt: new Date(Date.parse(now) - 20_000).toISOString(), agentIds: [],
			policy: { ...DEFAULT_WORKDAY_POLICY, durationSeconds: 60, planningPercent: 20, maximumConcurrency: 1, communicationConcurrency: 1 } }), state: 'active' as const };
		await base.query(`UPDATE capacity_workday_runs SET status='running',parameters_json=? WHERE id=?`,
			[JSON.stringify({ appliedPlan: plan }), attempt.workdayId]);
		if (completeOriginalTables) await base.query('UPDATE capacity_workday_runs SET started_at=?,created_at=?,updated_at=? WHERE id=?',
			[plan.startsAt, plan.startsAt, now, attempt.workdayId]);
		const observed = { day: now.slice(0, 10), observedAt: now, healthy: true, activeSeconds: 1, reservedSeconds: 0 };
		await base.query(`INSERT INTO capacity_provider_availability_sessions
			(id,membership_id,team_id,capacity_provider_id,opened_at,refreshed_at,expires_at,available_from,execution_providers_json,created_at,updated_at)
			VALUES ('session','membership','team','provider',?,?,?,?,?,?,?)`, [now, now, attempt.deadline, now,
			JSON.stringify([{ id: attempt.provider.executionProviderId, nativeLimits: { modelConfigurationId: attempt.provider.modelConfigurationId },
				accountingObservation: { modelUsage: observed, capabilityUsage: { [attempt.provider.executionCapabilityId]: observed } } }]), now, now]);
		const seedNode = async (value: AssignmentAttempt) => base.query(`INSERT INTO execution_nodes
			(id,team_id,project_id,workday_id,kind,source_ref_json,authority_refs_json,rule_revision,node_revision,agent_class,status,
			graph_revision_created,graph_revision_updated,created_at,updated_at)
			VALUES (?,?,?,?,'acting',?,?,1,?,?,'ready',1,?,?,?)`, [value.nodeId, value.teamId, value.projectId, value.workdayId,
			JSON.stringify(value.sourceRef), JSON.stringify(value.authorityRefs), value.nodeRevision, value.agentClass, value.graphRevision, now, now]);
		await seedNode(attempt);
		const repository = new ProviderAssignmentRepository(base.owner);
		const store = { ...base.owner, getProviderAssignment: (teamId: string, id: string) => repository.get(teamId, id) };
		const input = (value = attempt): Parameters<typeof admitLivingExecutionAssignment>[1] => {
			const opportunity = allocateWorkdayCapacity({ now, remainingSeconds: 9, workdays: [{ plan,
				committedSeconds: 0, planningCommittedSeconds: 0, maximumAdditionalSeconds: 9, actingReady: true }] })[plan.id];
			if (!opportunity) throw new Error('Actual allocator opportunity required');
			const selection = selectFairReadyNode([{ id: value.nodeId, projectId: value.projectId, agentClass: value.agentClass,
				readyAt: value.createdAt }], [], plan.policySnapshot);
			return { principal: { teamId: value.teamId, capacityProviderId: value.provider.providerId, membershipId: 'membership' },
				assignment: value, allocation: { ...calculateAssignmentAllocation({ estimate: value.estimate, measurements: [],
					constraints: [{ id: 'original-productive-window', remainingSeconds: 3 }] }), opportunity, selection },
				accountingLimits: { modelConfigurationId: value.provider.modelConfigurationId, dailyActiveSecondsLimit: 10,
					capabilityLimits: { [value.provider.executionCapabilityId]: { dailyActiveSecondsLimit: 10 } } },
				projectAgentClassId: value.agentClass, providerSessionId: 'session', executionProviderId: value.provider.executionProviderId,
				laneId: 'workday', lanePurpose: 'workday', executionKind: 'workday', workdayConcurrencyLimit: 1,
				providerConcurrencyLimit: 1, predecessorResults: [], treedxProxyHandle: { id: `proxy-${value.id}`, expiresAt: value.deadline }, now };
		};
		const snapshot = async () => ({ financial: await base.snapshot(), nodes: (await base.query('SELECT * FROM execution_nodes ORDER BY id')).rows,
			proxies: (await base.query('SELECT * FROM treedx_proxy_handles ORDER BY id')).rows });
		return { ...base, attempt, plan, input, snapshot, seedNode, repository, store,
			admit: (value = input()) => admitLivingExecutionAssignment(store, value) };
	} catch (error) { await base.db.close(); throw error; }
}
