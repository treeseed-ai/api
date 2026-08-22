import { decodeCapacityPageCursor, normalizeCapacityPageLimit } from '@treeseed/sdk/capacity-pagination';
import { WorkdayPreflightService, parsePublicWorkdayIntent } from '../../../capacity/services/capacity/workdays/scheduling/workday-preflight-service.ts';
import { authorizeCapacityTeam, type CapacityPrincipal } from './capacity-authorization.ts';
import { CapacityOperationError } from './capacity-operation-error.ts';

function page(query: Record<string, unknown>) {
	try { return { limit: normalizeCapacityPageLimit(query.limit), cursor: decodeCapacityPageCursor(query.cursor) }; }
	catch (error) { throw new CapacityOperationError(400, 'capacity_page_invalid', error instanceof Error ? error.message : String(error)); }
}

function translate(error: unknown): never {
	if (error instanceof CapacityOperationError) throw error;
	const candidate = error as { status?: unknown; code?: unknown; message?: unknown };
	const status = Number(candidate?.status);
	throw new CapacityOperationError(Number.isInteger(status) ? status : 500,
		typeof candidate?.code === 'string' ? candidate.code : 'workday_operation_failed',
		typeof candidate?.message === 'string' ? candidate.message : 'Workday operation failed.');
}

export function createWorkdayService(store: any) {
	return {
		async list(principal: CapacityPrincipal, teamId: string, query: Record<string, unknown>) {
			await authorizeCapacityTeam(store, principal, teamId, 'projects:read:team');
			try { return await store.listCapacityWorkdayRunsPage(teamId, { status: query.status ?? null,
				providerId: query.providerId ?? null, executionKind: 'workday', ...page(query) }); } catch (error) { translate(error); }
		},
		async preflight(principal: CapacityPrincipal, teamId: string, body: Record<string, unknown>) {
			const actor = await authorizeCapacityTeam(store, principal, teamId, 'teams:manage:team');
			try { return await new WorkdayPreflightService(store).preflight(teamId, parsePublicWorkdayIntent(teamId, body), actor.id); }
			catch (error) { translate(error); }
		},
		async start(principal: CapacityPrincipal, teamId: string, body: Record<string, unknown>, idempotencyKey?: string) {
			const actor = await authorizeCapacityTeam(store, principal, teamId, 'teams:manage:team');
			try { return await new WorkdayPreflightService(store).start(teamId, {
				preflightId: String(body.preflightId ?? ''), preflightDigest: String(body.preflightDigest ?? ''),
				idempotencyKey: idempotencyKey ?? '',
			}, actor.id); } catch (error) { translate(error); }
		},
		async show(principal: CapacityPrincipal, teamId: string, runId: string) {
			await authorizeCapacityTeam(store, principal, teamId, 'projects:read:team');
			const run = await store.getCapacityWorkdayRun(teamId, runId);
			if (!run) throw new CapacityOperationError(404, 'workday_not_found', 'Workday not found.');
			const events = await store.listCapacityWorkdayEventsPage(teamId, runId, { limit: 50, cursor: null });
			return { run, events: events.items, eventPage: events.page };
		},
		async events(principal: CapacityPrincipal, teamId: string, runId: string, query: Record<string, unknown>) {
			await authorizeCapacityTeam(store, principal, teamId, 'projects:read:team');
			if (!await store.getCapacityWorkdayRun(teamId, runId)) throw new CapacityOperationError(404, 'workday_not_found', 'Workday not found.');
			try { return await store.listCapacityWorkdayEventsPage(teamId, runId, page(query)); } catch (error) { translate(error); }
		},
		async schedules(principal: CapacityPrincipal, teamId: string) {
			await authorizeCapacityTeam(store, principal, teamId, 'projects:read:team');
			return { items: await store.listCapacityWorkdaySchedules(teamId), cursor: null };
		},
		async createSchedule(principal: CapacityPrincipal, teamId: string, body: Record<string, unknown>) {
			await authorizeCapacityTeam(store, principal, teamId, 'teams:manage:team');
			try { return await store.createCapacityWorkdaySchedule(teamId, body); } catch (error) { translate(error); }
		},
		async updateSchedule(principal: CapacityPrincipal, teamId: string, scheduleId: string,
			body: Record<string, unknown>, ifMatch?: string) {
			await authorizeCapacityTeam(store, principal, teamId, 'teams:manage:team');
			const current = await store.getCapacityWorkdaySchedule(teamId, scheduleId);
			if (!current) throw new CapacityOperationError(404, 'workday_schedule_not_found', 'Workday schedule not found.');
			if (!ifMatch || Number(ifMatch) !== Number(current.stateVersion)) {
				throw new CapacityOperationError(412, 'workday_schedule_precondition_failed', 'The workday schedule changed after it was inspected.');
			}
			try { return await store.updateCapacityWorkdaySchedule(teamId, scheduleId, { ...body, stateVersion: current.stateVersion }); }
			catch (error) { translate(error); }
		},
	};
}
