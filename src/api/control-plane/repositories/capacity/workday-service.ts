import { decodeCapacityPageCursor, normalizeCapacityPageLimit } from '@treeseed/sdk/capacity-pagination';
import { WorkdayPreflightService, parsePublicWorkdayIntent } from '../../../capacity/services/capacity/workdays/scheduling/workday-preflight-service.ts';
import { authorizeCapacityTeam, type CapacityPrincipal } from './capacity-authorization.ts';
import { CapacityOperationError } from './capacity-operation-error.ts';
import { createWorkdayProfileService } from './workdays/profile-service.ts';
import { communicationSchedulingDiagnostics } from './communication/scheduling-diagnostics.ts';
import { advanceLivingWorkday } from '../../../capacity/services/capacity/workdays/lifecycle/living-workday-lifecycle.ts';
import { reconcileExecutionGraph } from './execution/execution-graph-service.ts';
import { workdayTerminalizationPreserveUntil } from '../../../capacity/services/capacity/workdays/scheduling/workday-run-service.ts';
import { encryptedEnvelopeSchema } from '@treeseed/sdk/security';
import type { CapacityWorkdayEventRecord } from '@treeseed/sdk/agent-capacity';
import type { DiagnosticEnvelopeService } from '../../../../security/diagnostic-envelope.ts';

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

export function createWorkdayService(store: any, diagnosticEnvelopes?: DiagnosticEnvelopeService) {
	return {
		...createWorkdayProfileService(store),
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
			return { run, events: events.items, eventPage: events.page, scheduling: await communicationSchedulingDiagnostics(store, teamId, runId) };
		},
		async stop(principal: CapacityPrincipal, teamId: string, runId: string, body: Record<string, unknown>) {
			const actor = await authorizeCapacityTeam(store, principal, teamId, 'teams:manage:team');
			try {
				const run = await store.getCapacityWorkdayRun(teamId, runId);
				if (!run) throw new CapacityOperationError(404, 'workday_not_found', 'Workday not found.');
				if (run.status !== 'running') throw new CapacityOperationError(409, 'workday_not_active', 'Only an active workday can enter closeout.');
				const now = new Date().toISOString();
				const lifecycle = await advanceLivingWorkday(store, run, now, true);
				const reason = String(body.reason ?? 'Workday stopped by an authorized operator.');
				const terminalization = await store.terminalizeCapacityWorkdayAssignments(teamId, runId, {
					now, settlementKeyPrefix: 'workday-operator-stop', source: 'capacity_workday_operator_stop',
					code: 'workday_operator_stopped', reason, metadata: { requestedById: actor.id },
					preserveActiveLeasesUntil: workdayTerminalizationPreserveUntil('cancelled', run.parameters, now),
				});
				const closing = await store.getCapacityWorkdayRun(teamId, runId);
				if (!closing) throw new CapacityOperationError(404, 'workday_not_found', 'Workday not found after terminalization.');
				await store.updateCapacityWorkdayRun(teamId, runId, {
					summary: { outcome: 'operator_stopped', reason, terminalization },
				});
				// Stopping must remain available when the current proposal graph is invalid.
				// Closing blocks ordinary admissions; only required closeout remains eligible.
				let reconciliation: { status: 'current' | 'deferred'; code?: string } = { status: 'current' };
				try { await reconcileExecutionGraph(store, teamId); }
				catch (error) {
					const code = String((error as { code?: unknown }).code ?? 'graph_reconciliation_failed');
					reconciliation = { status: 'deferred', code };
				}
				return { run: await store.getCapacityWorkdayRun(teamId, runId), lifecycle, terminalization, reconciliation, reason };
			} catch (error) { translate(error); }
		},
		async events(principal: CapacityPrincipal, teamId: string, runId: string, query: Record<string, unknown>) {
			await authorizeCapacityTeam(store, principal, teamId, 'projects:read:team');
			if (query.diagnostics !== undefined && query.diagnostics !== 'metadata' && query.diagnostics !== 'full') {
				throw new CapacityOperationError(400, 'workday_diagnostics_invalid', 'Diagnostic detail must be metadata or full.');
			}
			if (query.diagnostics === 'full') await authorizeCapacityTeam(store, principal, teamId, 'agents:diagnostics:team');
			if (!await store.getCapacityWorkdayRun(teamId, runId)) throw new CapacityOperationError(404, 'workday_not_found', 'Workday not found.');
			try {
				const events = await store.listCapacityWorkdayEventsPage(teamId, runId, page(query));
				if (query.diagnostics !== 'full') return events;
				return { ...events, items: events.items.map((event: CapacityWorkdayEventRecord) => {
					const raw = event.metadata.protectedPayloadEnvelope;
					if (raw === undefined) return event;
					if (!diagnosticEnvelopes) throw new CapacityOperationError(503, 'diagnostics_encryption_unavailable', 'Protected diagnostics require an active encryption key.');
					const envelope = encryptedEnvelopeSchema.safeParse(raw), aad = envelope.success ? envelope.data.aad : undefined;
					if (!envelope.success || !aad || event.teamId !== teamId || event.runId !== runId || aad.purpose !== 'diagnostics' || aad.teamId !== teamId
						|| aad.assignmentId !== event.assignmentId || aad.resourceId !== event.id || aad.eventType !== event.eventType) {
						throw new CapacityOperationError(409, 'workday_diagnostics_integrity_invalid', 'Protected diagnostics disagree with their owning event.');
					}
					try {
						const protectedPayload = diagnosticEnvelopes.decrypt(envelope.data);
						if (!protectedPayload || typeof protectedPayload !== 'object' || Array.isArray(protectedPayload) || !Object.keys(protectedPayload).length) throw new Error('Invalid protected payload.');
						return { ...event, protectedPayload };
					} catch { throw new CapacityOperationError(409, 'workday_diagnostics_integrity_invalid', 'Protected diagnostics cannot be authenticated.'); }
				}) };
			} catch (error) { translate(error); }
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
