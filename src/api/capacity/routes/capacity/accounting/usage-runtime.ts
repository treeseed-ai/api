import type { Hono } from 'hono';
import { CapacityGovernanceError } from '../../../database.ts';
import { settleCapacityReservationExactlyOnce, type CapacitySettlementRequest } from '../../../services/capacity/accounting/settlement-service.ts';
import { reportCapacityUsage } from '../../../services/capacity/accounting/usage-report-service.ts';
import { requireProviderPrincipal } from '../providers/provider-auth.ts';
import { readCapacityRequestObject } from '../../support/request-json.ts';
import { capacityRuntimeFailure, requireCapacityIdempotencyKey, type CapacityRuntimeRouteOptions } from '../../runtime/runtime-route-support.ts';

async function ownedAssignment(options: CapacityRuntimeRouteOptions, assignmentId: string, teamId: string, membershipId: string) {
	const assignment = await options.store.first(`SELECT * FROM capacity_provider_assignments WHERE id = ? AND team_id = ? AND membership_id = ? LIMIT 1`, [assignmentId, teamId, membershipId]);
	if (!assignment) throw new CapacityGovernanceError('provider_assignment_not_found', 'Provider assignment does not exist for this membership.', 404);
	return assignment;
}

function objectValue(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function installUsageRuntimeRoutes(app: Hono, options: CapacityRuntimeRouteOptions) {
	app.post('/v1/provider/assignments/:assignmentId/settle', async (c) => {
		try {
			const principal = requireProviderPrincipal(c, ['provider:usage:write']);
			const assignment = await ownedAssignment(options, c.req.param('assignmentId'), principal.teamId, principal.membershipId);
			const body = await readCapacityRequestObject(c);
			const result = await settleCapacityReservationExactlyOnce(options.store, {
				settlementKey: requireCapacityIdempotencyKey(c), teamId: principal.teamId, membershipId: principal.membershipId,
				reservationId: String(assignment.reservation_id ?? ''), assignmentId: String(assignment.id), assignmentAttempt: body.assignmentAttempt == null ? null : Number(body.assignmentAttempt), usageDimension: typeof body.usageDimension === 'string' ? body.usageDimension : 'aggregate', usageIdempotencyKey: typeof body.usageIdempotencyKey === 'string' ? body.usageIdempotencyKey : null, actualCredits: Number(body.actualCredits), providerUnits: body.providerUnits == null ? null : Number(body.providerUnits), usd: body.usd == null ? null : Number(body.usd), modeRunId: typeof body.modeRunId === 'string' ? body.modeRunId : null, source: 'provider_usage_report', metadata: objectValue(body.metadata), usageActual: objectValue(body.usageActual) as CapacitySettlementRequest['usageActual'],
			});
			return c.json({ ok: true, payload: result }, { status: result.replayed ? 200 : 201 });
		} catch (error) { return capacityRuntimeFailure(c, error); }
	});
	app.post('/v1/provider/assignments/:assignmentId/usage', async (c) => {
		try {
			const principal = requireProviderPrincipal(c, ['provider:usage:write']);
			const assignment = await ownedAssignment(options, c.req.param('assignmentId'), principal.teamId, principal.membershipId);
			const body = await readCapacityRequestObject(c);
			const result = await reportCapacityUsage(options.store, {
				teamId: principal.teamId, membershipId: principal.membershipId, reservationId: String(assignment.reservation_id ?? ''), assignmentId: String(assignment.id), idempotencyKey: requireCapacityIdempotencyKey(c), assignmentAttempt: body.assignmentAttempt == null ? null : Number(body.assignmentAttempt), usageDimension: String(body.usageDimension ?? ''), accountingMode: body.accountingMode === 'incremental' ? 'incremental' : 'informational', actualCredits: Number(body.actualCredits ?? 0), providerUnits: body.providerUnits == null ? null : Number(body.providerUnits), usd: body.usd == null ? null : Number(body.usd), modeRunId: typeof body.modeRunId === 'string' ? body.modeRunId : null, source: 'provider_usage_report', metadata: objectValue(body.metadata), usageActual: objectValue(body.usageActual),
			});
			return c.json({ ok: true, payload: result }, { status: result.replayed ? 200 : 201 });
		} catch (error) { return capacityRuntimeFailure(c, error); }
	});
}
