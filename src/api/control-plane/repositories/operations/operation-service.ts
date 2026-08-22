import { CapacityOperationError } from '../capacity/capacity-operation-error.ts';

type Principal = { id: string; roles?: string[]; permissions?: string[] } | undefined;
function authorize(principal: Principal, permission: string) {
	if (!principal) throw new CapacityOperationError(401, 'authentication_required', 'Authentication is required.');
	if (!principal.roles?.some((role) => role === 'admin' || role === 'platform_admin')
		&& !principal.permissions?.includes('*:*:*') && !principal.permissions?.includes(permission)) {
		throw new CapacityOperationError(403, 'platform_operation_denied', `${permission} authority is required.`);
	}
	return principal;
}

export function createOperationService(store: any) {
	async function operation(principal: Principal, id: string, permission = 'platform:operations:read') {
		authorize(principal, permission); const result = await store.findPlatformOperationById(id);
		if (!result) throw new CapacityOperationError(404, 'platform_operation_not_found', 'Platform operation not found.');
		return result;
	}
	return {
		async list(principal: Principal, query: Record<string, unknown>) {
			authorize(principal, 'platform:operations:read');
			return { items: await store.listPlatformOperations({ limit: query.limit }), cursor: null };
		},
		async create(principal: Principal, body: Record<string, unknown>, idempotencyKey?: string) {
			const actor = authorize(principal, 'platform:operations:create');
			const namespace = String(body.namespace ?? '').trim(); const name = String(body.operation ?? '').trim();
			if (!namespace || !name) throw new CapacityOperationError(400, 'platform_operation_invalid', 'namespace and operation are required.');
			const input = body.input && typeof body.input === 'object' && !Array.isArray(body.input) ? body.input : {};
			const approvalRequired = (input as any).approvalRequired === true && (input as any).approvalSatisfied !== true;
			return store.createPlatformOperation({ namespace, operation: name,
				target: String(body.target ?? 'control_plane_operations_runner'), status: approvalRequired ? 'waiting_for_approval' : String(body.status ?? 'queued'),
				idempotencyKey: idempotencyKey ?? '', input, requestedByType: 'user', requestedById: actor.id });
		},
		show: operation,
		async events(principal: Principal, id: string) { const existing = await operation(principal, id); return { items: await store.listPlatformOperationEvents(existing.id), cursor: null }; },
		async cancel(principal: Principal, id: string) { const existing = await operation(principal, id, 'platform:operations:cancel'); return store.cancelPlatformOperation(existing.id); },
		async retry(principal: Principal, id: string, body: Record<string, unknown>) {
			const existing = await operation(principal, id, 'platform:operations:retry');
			if (!['failed', 'cancelled'].includes(String(existing.status))) throw new CapacityOperationError(409, 'platform_operation_not_retryable', 'Only failed or cancelled operations can be retried.');
			return store.retryPlatformOperation(existing.id, { inputPatch: body.inputPatch && typeof body.inputPatch === 'object' ? body.inputPatch : {} });
		},
	};
}
