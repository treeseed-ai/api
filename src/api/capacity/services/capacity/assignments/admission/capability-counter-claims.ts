import { createHash } from 'node:crypto';
import type { AssignmentAttempt, CapabilityAccountingLimits } from '@treeseed/sdk/agent-capacity';
import type { CapacityDatabaseOperation } from '../../../../database.ts';

/** Existing daily admission counters are shared across every team using this host/model. */
export function capabilityCounterClaims(assignment: AssignmentAttempt, limits: CapabilityAccountingLimits, now: string) {
	const day = now.slice(0, 10);
	const capability = limits.capabilityLimits[assignment.provider.executionCapabilityId];
	if (!capability || assignment.provider.modelConfigurationId !== limits.modelConfigurationId) throw new Error('assignment_accounting_scope_mismatch');
	return [
		{ scope: 'model-day', scopeId: JSON.stringify([assignment.provider.providerId, limits.modelConfigurationId]), hardLimit: limits.dailyActiveSecondsLimit },
		{ scope: 'capability-day', scopeId: JSON.stringify([assignment.provider.providerId, limits.modelConfigurationId, assignment.provider.executionCapabilityId]), hardLimit: capability.dailyActiveSecondsLimit },
	].map(value => ({ ...value, day, id: `supply_${createHash('sha256').update(JSON.stringify([value.scope, value.scopeId, day])).digest('hex')}` }))
		.sort((a, b) => a.id.localeCompare(b.id));
}

export function initializeCapabilityCounters(assignment: AssignmentAttempt, claims: ReturnType<typeof capabilityCounterClaims>, now: string): CapacityDatabaseOperation[] {
	return claims.map(claim => ({ query: `INSERT INTO capacity_admission_counters
		(id,team_id,scope,scope_id,period_key,hard_limit,committed_amount,state_version,created_at,updated_at)
		VALUES (?,?,?,?,?,?,0,1,?,?) ON CONFLICT (id) DO NOTHING`,
		params: [claim.id, assignment.teamId, claim.scope, claim.scopeId, claim.day, claim.hardLimit, now, now] })).concat([
		{ query: `SELECT id FROM capacity_admission_counters WHERE id IN (${claims.map(() => '?').join(',')}) ORDER BY id FOR UPDATE`, params: claims.map(claim => claim.id) },
	]);
}

export function commitCapabilityCounters(assignment: AssignmentAttempt, claims: ReturnType<typeof capabilityCounterClaims>, token: string, now: string): CapacityDatabaseOperation[] {
	return claims.flatMap(claim => [
		{ query: `UPDATE capacity_admission_counters SET committed_amount=committed_amount+?,state_version=state_version+1,updated_at=?
			WHERE id=? AND EXISTS (SELECT 1 FROM capacity_reservations WHERE id=? AND admission_token=?)`,
			params: [assignment.limits.maximumSeconds, now, claim.id, assignment.reservationId, token] },
		{ query: `INSERT INTO capacity_reservation_counter_claims
			(reservation_id,counter_id,admission_token,reserved_amount,released_amount,release_policy,created_at,updated_at)
			SELECT ?,?,?,?,0,'actual-settlement',?,? WHERE EXISTS (SELECT 1 FROM capacity_reservations WHERE id=? AND admission_token=?)
			ON CONFLICT (reservation_id,counter_id) DO NOTHING`,
			params: [assignment.reservationId, claim.id, token, assignment.limits.maximumSeconds, now, now, assignment.reservationId, token] },
	]);
}
