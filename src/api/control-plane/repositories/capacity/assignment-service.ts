import { decodeCapacityPageCursor, normalizeCapacityPageLimit } from '@treeseed/sdk/capacity-pagination';
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
		typeof candidate?.code === 'string' ? candidate.code : 'assignment_operation_failed',
		typeof candidate?.message === 'string' ? candidate.message : 'Assignment operation failed.');
}

export function createAssignmentService(store: any) {
	async function assignment(principal: CapacityPrincipal, teamId: string, assignmentId: string) {
		await authorizeCapacityTeam(store, principal, teamId, 'projects:read:team');
		const result = await store.getProviderAssignment(teamId, assignmentId);
		if (!result) throw new CapacityOperationError(404, 'assignment_not_found', 'Assignment not found.');
		return result;
	}
	return {
		async list(principal: CapacityPrincipal, teamId: string, query: Record<string, unknown>) {
			await authorizeCapacityTeam(store, principal, teamId, 'projects:read:team');
			try { return await store.listProviderAssignmentsPage(teamId, { projectId: query.projectId ?? null,
				providerId: query.providerId ?? null, status: query.status ?? null, assignmentId: query.assignmentId ?? null,
				workdayId: query.workdayId ?? null, executionProviderId: query.executionProviderId ?? null, ...page(query) }); }
			catch (error) { translate(error); }
		},
		show: assignment,
		async explain(principal: CapacityPrincipal, teamId: string, assignmentId: string) {
			return (await assignment(principal, teamId, assignmentId)).explanation ?? {};
		},
		async cancel(principal: CapacityPrincipal, teamId: string, assignmentId: string,
			body: Record<string, unknown>, idempotencyKey?: string) {
			const actor = await authorizeCapacityTeam(store, principal, teamId, 'teams:manage:team');
			try { return await store.cancelCapacityAssignment(teamId, assignmentId,
				{ ...body, idempotencyKey: idempotencyKey ?? '', actorId: actor.id }); } catch (error) { translate(error); }
		},
		async retry(principal: CapacityPrincipal, teamId: string, assignmentId: string,
			body: Record<string, unknown>, idempotencyKey?: string) {
			const actor = await authorizeCapacityTeam(store, principal, teamId, 'teams:manage:team');
			try { return await store.requeueCapacityAssignment(teamId, assignmentId,
				{ ...body, idempotencyKey: idempotencyKey ?? '', actorId: actor.id }); } catch (error) { translate(error); }
		},
	};
}
