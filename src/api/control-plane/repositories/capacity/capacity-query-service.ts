import { decodeCapacityPageCursor, normalizeCapacityPageLimit } from '@treeseed/sdk/capacity-pagination';
import type { CapacityGrantStatus } from '@treeseed/sdk/agent-capacity';
import { optionalAvailabilityStatus } from '../../../capacity/services/accounts/availability-session-service.ts';
import { CapacityGrantService } from '../../../capacity/services/capacity/allocations/grant-service.ts';
import { CapacityOperatorEvidenceService } from '../../../capacity/services/support/operator-evidence-service.ts';
import { authorizeCapacityTeam, type CapacityPrincipal } from './capacity-authorization.ts';
import { CapacityOperationError } from './capacity-operation-error.ts';

function page(query: Record<string, unknown>) {
	try { return { limit: normalizeCapacityPageLimit(query.limit), cursor: decodeCapacityPageCursor(query.cursor) }; }
	catch (error) { throw new CapacityOperationError(400, 'capacity_page_invalid', error instanceof Error ? error.message : String(error)); }
}
function grantStatus(value: unknown): CapacityGrantStatus | undefined {
	if (value == null || value === '') return undefined;
	if (['planned', 'active', 'paused', 'revoked', 'expired'].includes(String(value))) return String(value) as CapacityGrantStatus;
	throw new CapacityOperationError(400, 'capacity_grant_status_invalid', `Unknown capacity grant status ${String(value)}.`);
}
function translate(error: unknown): never {
	if (error instanceof CapacityOperationError) throw error;
	const candidate = error as { status?: unknown; code?: unknown; message?: unknown };
	const status = Number(candidate?.status);
	throw new CapacityOperationError(Number.isInteger(status) ? status : 500,
		typeof candidate?.code === 'string' ? candidate.code : 'capacity_query_failed',
		typeof candidate?.message === 'string' ? candidate.message : 'Capacity query failed.');
}

export function createCapacityQueryService(store: any) {
	const evidence = new CapacityOperatorEvidenceService(store);
	const grants = new CapacityGrantService(store);
	return {
		async explain(principal: CapacityPrincipal, teamId: string) {
			await authorizeCapacityTeam(store, principal, teamId, 'projects:read:team');
			const [sessions, lanes, active] = await Promise.all([
				store.listProviderAvailabilitySessionsPage(teamId, { status: 'open', limit: 100 }),
				store.all(`SELECT lanes.*, providers.display_name AS provider_name FROM capacity_provider_lanes lanes INNER JOIN capacity_providers providers ON providers.id = lanes.capacity_provider_id WHERE lanes.team_id = ? ORDER BY lanes.priority DESC, lanes.purpose`, [teamId]),
				store.first(`SELECT COUNT(*) AS count FROM capacity_provider_assignments WHERE team_id = ? AND status IN ('pending','leased','returned')`, [teamId]),
			]);
			return { teamId, model: 'shared-provider-battery', lanePurposes: ['communication', 'platform', 'workday'],
				availability: sessions, lanes, activeAssignments: Number(active?.count ?? 0) };
		},
		async availability(principal: CapacityPrincipal, teamId: string, query: Record<string, unknown>) {
			await authorizeCapacityTeam(store, principal, teamId, 'projects:read:team');
			try { return await store.listProviderAvailabilitySessionsPage(teamId, { providerId: query.providerId ?? null,
				status: optionalAvailabilityStatus(query.status as string | undefined), ...page(query) }); } catch (error) { translate(error); }
		},
		async usage(principal: CapacityPrincipal, teamId: string, query: Record<string, unknown>) {
			await authorizeCapacityTeam(store, principal, teamId, 'projects:read:team');
			try { return await evidence.listUsage(teamId, { projectId: String(query.projectId ?? ''),
				workDayId: typeof query.workDayId === 'string' ? query.workDayId : null, ...page(query) }); } catch (error) { translate(error); }
		},
		async ledger(principal: CapacityPrincipal, teamId: string, query: Record<string, unknown>) {
			await authorizeCapacityTeam(store, principal, teamId, 'projects:read:team');
			try { return await evidence.listLedger(teamId, { projectId: String(query.projectId ?? ''),
				workDayId: typeof query.workDayId === 'string' ? query.workDayId : null, ...page(query) }); } catch (error) { translate(error); }
		},
		async audit(principal: CapacityPrincipal, teamId: string, query: Record<string, unknown>) {
			await authorizeCapacityTeam(store, principal, teamId, 'projects:read:team');
			const { limit } = page(query);
			return { items: await store.all(`SELECT * FROM capacity_audit_events WHERE team_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`, [teamId, limit]), page: { limit, hasMore: false, nextCursor: null } };
		},
		async lanes(principal: CapacityPrincipal, teamId: string) {
			await authorizeCapacityTeam(store, principal, teamId, 'projects:read:team');
			return { items: await store.all(`SELECT * FROM capacity_provider_lanes WHERE team_id = ? ORDER BY priority DESC, purpose, id`, [teamId]) };
		},
		async grants(principal: CapacityPrincipal, teamId: string, query: Record<string, unknown>) {
			await authorizeCapacityTeam(store, principal, teamId, 'projects:read:team');
			try { return await grants.listPage(teamId, { projectId: query.projectId as string | undefined,
				membershipId: query.membershipId as string | undefined, providerId: query.providerId as string | undefined,
				environment: query.environment as string | undefined, status: grantStatus(query.status),
				limit: query.limit, cursor: query.cursor }); } catch (error) { translate(error); }
		},
		async grant(principal: CapacityPrincipal, teamId: string, grantId: string) {
			await authorizeCapacityTeam(store, principal, teamId, 'projects:read:team');
			try { const result = await grants.get(teamId, grantId);
				if (!result) throw new CapacityOperationError(404, 'capacity_grant_not_found', 'Capacity grant not found.');
				return result; } catch (error) { translate(error); }
		},
	};
}
