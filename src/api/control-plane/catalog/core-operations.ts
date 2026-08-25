import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { ControlPlaneOperationError, type BoundOperation } from './operation-registry.ts';

export const statusOperation: BoundOperation<typeof CONTROL_PLANE_OPERATIONS.status.show> = {
	binding: CONTROL_PLANE_OPERATIONS.status.show,
	async handler() {
		return { service: 'control-plane', status: 'ok', contractVersion: 'treeseed.control-plane-operation/v1', mcpProtocolVersion: '2026-07-28' };
	},
};

export interface DeepHealthDependencies {
	store: {
		ensureInitialized(): Promise<unknown>;
		first(query: string): Promise<Record<string, unknown> | null | undefined>;
	};
}

export function createDeepHealthOperation(dependencies: DeepHealthDependencies): BoundOperation<typeof CONTROL_PLANE_OPERATIONS.health.deep> {
	return {
		binding: CONTROL_PLANE_OPERATIONS.health.deep,
		async handler() {
			try {
				await dependencies.store.ensureInitialized();
				const probe = await dependencies.store.first('SELECT 1 AS ok');
				const database = probe?.ok === 1 || probe?.ok === '1';
				if (!database) throw new Error('Readiness probe failed.');
				return { status: 'ok', checks: { database: true } };
			} catch {
				throw new ControlPlaneOperationError(503, 'control_plane_database_unavailable', 'The control-plane database is unavailable.');
			}
		},
	};
}

export function createReadinessOperation(dependencies: DeepHealthDependencies): BoundOperation<typeof CONTROL_PLANE_OPERATIONS.health.ready> {
	return { ...createDeepHealthOperation(dependencies), binding: CONTROL_PLANE_OPERATIONS.health.ready };
}
