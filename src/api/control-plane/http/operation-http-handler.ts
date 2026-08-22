import { createHash, randomUUID } from 'node:crypto';
import type { AuthInfo } from '@modelcontextprotocol/server';
import type { Context } from 'hono';
import { ZodError } from 'zod';
import { ControlPlaneOperationError, type BoundOperation } from '../catalog/operation-registry.ts';

type Authenticate = (request: Request) => Promise<AuthInfo | Response>;

function problem(context: Context, error: ControlPlaneOperationError, requestId: string) {
	const title = error.status === 400 ? 'Invalid request'
		: error.status === 401 ? 'Authentication required'
			: error.status === 403 ? 'Access denied'
				: error.status === 404 ? 'Not found'
					: error.status === 409 ? 'Conflict'
						: error.status === 412 ? 'Precondition failed'
							: error.status === 429 ? 'Rate limited'
								: error.status === 503 ? 'Service unavailable' : 'Operation failed';
	return context.json({
		type: `https://treeseed.dev/problems/${error.code}`,
		title,
		status: error.status,
		code: error.code,
		detail: error.message,
		instance: new URL(context.req.url).pathname,
		requestId,
	}, error.status, { 'content-type': 'application/problem+json', 'x-request-id': requestId });
}

function etag(value: unknown) {
	return `"sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}"`;
}

async function operationInput(context: Context, operation: BoundOperation) {
	const query = operation.binding.schema.query.parse(Object.fromEntries(new URL(context.req.url).searchParams.entries()));
	const path = operation.binding.schema.path.parse(context.req.param());
	const bodyValue = operation.binding.descriptor.kind === 'read' ? undefined : await context.req.json().catch(() => ({}));
	if (operation.binding.descriptor.kind === 'mutation' && (!bodyValue || typeof bodyValue !== 'object' || Array.isArray(bodyValue))) {
		throw new ControlPlaneOperationError(400, 'operation_input_invalid', 'The request body must be a JSON object.');
	}
	return { path, query, body: operation.binding.schema.body.parse(bodyValue) };
}

export function createOperationHttpHandler(
	operation: BoundOperation,
	authenticate: Authenticate,
	contractDigest: string,
) {
	return async (context: Context) => {
		const requestId = context.req.header('x-request-id')?.trim() || randomUUID();
		try {
			const descriptor = operation.binding.descriptor;
			const authInfo = descriptor.oauthScopes.length > 0 ? await authenticate(context.req.raw) : undefined;
			if (authInfo instanceof Response) return authInfo;
			const missingScope = descriptor.oauthScopes.find((scope) => !authInfo?.scopes.includes(scope));
			if (missingScope) throw new ControlPlaneOperationError(403, 'oauth_scope_insufficient', `The operation requires ${missingScope}.`);
			if (descriptor.idempotency.required && !context.req.header(descriptor.idempotency.header)) {
				throw new ControlPlaneOperationError(400, 'idempotency_key_required', `${descriptor.idempotency.header} is required.`);
			}
			if (descriptor.concurrency.required && !context.req.header(descriptor.concurrency.writeHeader)) {
				throw new ControlPlaneOperationError(412, 'precondition_required', `${descriptor.concurrency.writeHeader} is required.`);
			}
			const input = await operationInput(context, operation);
			const output = operation.binding.schema.output.parse(await operation.handler(input, {
				interface: 'rest',
				requestId,
				traceparent: context.req.header('traceparent'),
				authInfo,
				principal: authInfo?.extra?.principal as { id: string; roles?: string[]; permissions?: string[] } | undefined,
			}));
			return context.json({ data: output }, 200, {
				'x-request-id': requestId,
				'x-treeseed-contract-digest': contractDigest,
				...(descriptor.concurrency.required || descriptor.kind === 'read' ? { etag: etag(output) } : {}),
			});
		} catch (error) {
			const failure = error instanceof ControlPlaneOperationError ? error
				: error instanceof ZodError ? new ControlPlaneOperationError(400, 'operation_input_invalid', 'The operation input is invalid.')
					: new ControlPlaneOperationError(500, 'operation_failed', 'The operation failed.');
			return problem(context, failure, requestId);
		}
	};
}
