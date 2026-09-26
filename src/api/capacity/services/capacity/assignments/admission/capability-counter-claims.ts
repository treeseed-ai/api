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
		VALUES (?,?,?,?,?,?,0,1,?,?) ON CONFLICT (id) DO UPDATE
		SET hard_limit=EXCLUDED.hard_limit,state_version=capacity_admission_counters.state_version+1,
		updated_at=EXCLUDED.updated_at`,
		params: [claim.id, assignment.teamId, claim.scope, claim.scopeId, claim.day, claim.hardLimit, now, now] })).concat([
		{ query: `SELECT id FROM capacity_admission_counters WHERE id IN (${claims.map(() => '?').join(',')}) ORDER BY id FOR UPDATE`, params: claims.map(claim => claim.id) },
	]).concat(claims.map(claim => {
		const capability = claim.scope === 'capability-day';
		const observation = capability ? "adapter->'accountingObservation'->'capabilityUsage'->?" : "adapter->'accountingObservation'->'modelUsage'";
		const scope = capability ? "AND assignment.assignment_attempt_json::jsonb->'provider'->>'executionCapabilityId'=?" : '';
		return { query: `WITH observed AS (
			SELECT ${observation} AS value FROM capacity_provider_availability_sessions session,
			jsonb_array_elements(session.execution_providers_json::jsonb) adapter
			WHERE session.capacity_provider_id=? AND adapter->'nativeLimits'->>'modelConfigurationId'=?
			ORDER BY session.refreshed_at DESC,session.id DESC LIMIT 1
		), ledger AS (
			SELECT COALESCE(SUM(reservation.active_seconds),0) AS active,
			COALESCE(SUM(CASE WHEN reservation.state IN ('reserved','consuming')
			THEN GREATEST(0,reservation.reserved_seconds-reservation.active_seconds) ELSE 0 END),0) AS reserved
			FROM capacity_reservations reservation JOIN capacity_provider_assignments assignment ON assignment.id=reservation.assignment_id
			WHERE reservation.capacity_provider_id=? AND reservation.created_at>=?
			AND (assignment.assignment_attempt_json::jsonb->'provider'->>'modelConfigurationId'=?
				${capability ? '' : "OR NULLIF(assignment.assignment_attempt_json::jsonb->'provider'->>'modelConfigurationId','') IS NULL"}) ${scope}
		) UPDATE capacity_admission_counters SET committed_amount=GREATEST(committed_amount,
			GREATEST(ledger.active,COALESCE((SELECT (value->>'activeSeconds')::numeric FROM observed WHERE value->>'day'=?),0))
			+GREATEST(ledger.reserved,COALESCE((SELECT (value->>'reservedSeconds')::numeric FROM observed WHERE value->>'day'=?),0)))
			FROM ledger WHERE capacity_admission_counters.id=?`, params: [
			...(capability ? [assignment.provider.executionCapabilityId] : []), assignment.provider.providerId, assignment.provider.modelConfigurationId,
			assignment.provider.providerId, `${claim.day}T00:00:00.000Z`, assignment.provider.modelConfigurationId,
			...(capability ? [assignment.provider.executionCapabilityId] : []), claim.day, claim.day, claim.id,
		] };
	}));
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
