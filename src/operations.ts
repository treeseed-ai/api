import { TreeseedOperationsSdk } from '@treeseed/sdk/operations';
import type { ApiWorkflowOperationResponse, WorkflowHttpOperationRequest } from './types.ts';

export async function executeHttpWorkflowOperation(
	operation: string,
	request: WorkflowHttpOperationRequest,
): Promise<ApiWorkflowOperationResponse> {
	if (operation === 'dev' || operation === 'dev:watch') {
		throw new Error('Workflow operation "dev" is not supported over HTTP.');
	}

	const operations = new TreeseedOperationsSdk();
	return operations.execute({
		operationName: operation,
		input: (request.input ?? {}) as Record<string, unknown>,
	}, {
		cwd: request.cwd ?? process.cwd(),
		env: {
			...process.env,
			...(request.env ?? {}),
		},
		transport: 'api',
	});
}
