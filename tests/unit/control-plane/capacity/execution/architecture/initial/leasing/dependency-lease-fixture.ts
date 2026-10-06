import { readFileSync } from 'node:fs';
import { dependencyAdmission, dependencyInputs } from '../admission/dependency-admission-fixture.ts';
import { compileAssignmentTimeBudget } from '../../../../../../../../src/api/capacity/services/capacity/assignments/planning/assignment-time-budget.ts';
import { evaluateProviderAssignmentLeaseAuthority } from '../../../../../../../../src/api/capacity/services/accounts/lease-authority-service.ts';
import { splitPostgresSqlStatements } from '../../../../../../../../src/api/persistence/postgres-sql-statements.ts';

export function dependencyLeaseBudget() {
	const { attempt } = dependencyInputs();
	const compiled = compileAssignmentTimeBudget({ now: attempt.createdAt, requestedSeconds: attempt.limits.maximumSeconds, configuredBudget: { deadline: attempt.deadline } });
	return { now: attempt.createdAt, deadline: attempt.deadline, envelope: { teamId: attempt.teamId, projectId: attempt.projectId, workDayId: attempt.workdayId,
		mode: 'acting' as const, requestedSeconds: attempt.limits.maximumSeconds, reservedSeconds: attempt.limits.maximumSeconds, budget: compiled.capacityBudget } };
}

// Actual final admission, original account/session/reservation/proxy SQL and
// owning lease evaluator. Principal, JWK, availability and completed predecessor
// facts are supplied INPUTS, not authenticated provider HTTP or model dispatch.
export async function dependencyLease(admissionNow?: string | (() => string), completeOriginalTables = false) {
	const f = await dependencyAdmission(admissionNow, completeOriginalTables);
	try {
		const ddl = splitPostgresSqlStatements(readFileSync('drizzle/control-plane/0000_control_plane.sql', 'utf8'));
		for (const table of ['capacity_providers', 'capacity_provider_team_memberships']) {
			const statement = ddl.filter(sql => sql.startsWith(`CREATE TABLE "${table}" (`));
			if (statement.length !== 1) throw new Error(`Original ${table} DDL required`);
			if (!completeOriginalTables) await f.db.exec(statement[0]!);
		}
		const now = f.attempt.createdAt, principal = { teamId: f.attempt.teamId, capacityProviderId: 'provider', membershipId: 'membership' };
		await f.query(`INSERT INTO capacity_providers (id,fingerprint,public_jwk_json,display_name,created_at,updated_at) VALUES ('provider','supplied-lease-input','{}','Supplied lease provider',?,?)`, [now, now]);
		await f.query(`INSERT INTO capacity_provider_team_memberships (id,team_id,capacity_provider_id,approved_at,approved_by_id,created_at,updated_at)
			VALUES ('membership','team','provider',?,'supplied-operator',?,?)`, [now, now, now]);
		await f.admit();
		const evaluate = (at = now, identity = principal, session: string | null = 'session') => evaluateProviderAssignmentLeaseAuthority(f.store, identity, f.attempt.id, at, session);
		const snapshot = async () => ({ ...await f.snapshot(), accounts: (await f.query('SELECT * FROM capacity_providers ORDER BY id')).rows,
			memberships: (await f.query('SELECT * FROM capacity_provider_team_memberships ORDER BY id')).rows,
			sessions: (await f.query('SELECT * FROM capacity_provider_availability_sessions ORDER BY id')).rows });
		return { ...f, now, principal, evaluate, snapshot };
	} catch (error) { await f.db.close(); throw error; }
}
