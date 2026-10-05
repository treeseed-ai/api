import { controlPlaneErrorStatus } from '../../catalog/operation-registry.ts';

export class CapacityOperationError extends Error {
	readonly status: ReturnType<typeof controlPlaneErrorStatus>;
	constructor(status: number, readonly code: string, message: string) {
		super(message);
		this.status = controlPlaneErrorStatus(status);
		this.name = 'CapacityOperationError';
	}
}
