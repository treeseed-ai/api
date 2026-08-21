import { ControlPlaneStore } from "../../../persistence/store.ts";
export async function assertPlatformOperationRunnerUpdateMethod(this: ControlPlaneStore, operationId, runnerId) {
    const operation = await this.findPlatformOperationById(operationId);
    if (!operation) {
        const error: Error & Record<string, any> = new Error(`Unknown platform operation "${operationId}".`);
        error.status = 404;
        throw error;
    }
    if (!runnerId) {
        const error: Error & Record<string, any> = new Error('runnerId is required.');
        error.status = 400;
        throw error;
    }
    if (operation.assignedRunnerId !== runnerId) {
        const error: Error & Record<string, any> = new Error('Platform operation is assigned to a different runner.');
        error.status = 409;
        error.details = { assignedRunnerId: operation.assignedRunnerId };
        throw error;
    }
    if (['succeeded', 'failed', 'cancelled'].includes(operation.status)) {
        const error: Error & Record<string, any> = new Error(`Platform operation is already ${operation.status}.`);
        error.status = 409;
        error.details = { status: operation.status };
        throw error;
    }
    return operation;
}
