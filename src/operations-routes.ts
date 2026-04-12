import type { Hono } from 'hono';
import { findTreeseedOperation } from '@treeseed/sdk';
import { executeHttpWorkflowOperation, isHttpWorkflowOperationAllowed } from './operations.ts';
import { jsonError, requireScope } from './http.ts';
import type { AppVariables } from './types.ts';

export function registerOperationRoutes(
	app: Hono<{ Variables: AppVariables }>,
	options: {
		scope: string;
		executeOperation?: typeof executeHttpWorkflowOperation;
	},
) {
	const executeOperation = options.executeOperation ?? executeHttpWorkflowOperation;

	app.post('/operations/:operation', async (c) => {
		const unauthorized = requireScope(c, options.scope);
		if (unauthorized) return unauthorized;

		const requestedOperation = c.req.param('operation');
		const resolvedOperation = findTreeseedOperation(requestedOperation);
		if (!resolvedOperation) {
			return jsonError(c, 400, `Unknown Treeseed operation "${requestedOperation}".`, {
				operation: requestedOperation,
			});
		}
		if (!isHttpWorkflowOperationAllowed(resolvedOperation.name)) {
			return jsonError(c, 400, `Workflow operation "${resolvedOperation.name}" is not supported over HTTP.`, {
				operation: resolvedOperation.name,
			});
		}

		const body = await c.req.json().catch(() => ({}));
		try {
			const result = await executeOperation(resolvedOperation.name, body);
			return c.json(result, result.ok ? 200 : 400);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const status = /Unknown Treeseed operation|not supported over HTTP|confirmation required/i.test(message) ? 400 : 500;
			return jsonError(c, status, message, { operation: resolvedOperation.name });
		}
	});
}
