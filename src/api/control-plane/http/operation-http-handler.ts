import { createHash, randomUUID } from 'node:crypto';
import type { AuthInfo } from '@modelcontextprotocol/server';
import type { Context } from 'hono';
import { ZodError } from 'zod';
import { ControlPlaneOperationError, type BoundOperation } from '../catalog/operation-registry.ts';
import { decodeConfirmation, type ConfirmationService } from '../confirmation/confirmation-service.ts';

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
	if (value && typeof value === 'object') {
		const record = value as Record<string, any>;
		const revision = record.updatedAt ?? record.revision ?? record.version
			?? record.team?.updatedAt ?? record.project?.updatedAt;
		if (typeof revision === 'string' || typeof revision === 'number') return `"${String(revision).replaceAll('"', '')}"`;
	}
	return `"sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}"`;
}

async function operationInput(context: Context, operation: BoundOperation) {
	const query = operation.binding.schema.query.parse(Object.fromEntries(new URL(context.req.url).searchParams.entries()));
	const path = operation.binding.schema.path.parse(context.req.param());
	const rawBody = operation.binding.descriptor.kind === 'read' ? undefined : await context.req.text();
	let bodyValue: unknown = undefined;
	if (rawBody !== undefined) {
		try { bodyValue = rawBody ? JSON.parse(rawBody) : {}; }
		catch { throw new ControlPlaneOperationError(400, 'operation_json_invalid', 'The request body must be valid JSON.'); }
	}
	if (operation.binding.descriptor.kind === 'mutation' && (!bodyValue || typeof bodyValue !== 'object' || Array.isArray(bodyValue))) {
		throw new ControlPlaneOperationError(400, 'operation_input_invalid', 'The request body must be a JSON object.');
	}
	return { input: { path, query, body: operation.binding.schema.body.parse(bodyValue) }, rawBody };
}

export function createOperationHttpHandler(
	operation: BoundOperation,
	authenticate: Authenticate,
	contractDigest: string,
	confirmations?: ConfirmationService,
) {
	return async (context: Context) => {
		const requestId = context.req.header('x-request-id')?.trim() || randomUUID();
		try {
			const descriptor = operation.binding.descriptor;
			const idempotencyKey = context.req.header(descriptor.idempotency.header)
				?? (descriptor.operationId === 'repositories.github.webhook' ? context.req.header('x-github-delivery') : undefined);
			const authInfo = descriptor.authentication === 'oauth' ? await authenticate(context.req.raw) : undefined;
			if (authInfo instanceof Response) return authInfo;
			const missingScope = descriptor.oauthScopes.find((scope) => !authInfo?.scopes.includes(scope));
			if (missingScope) throw new ControlPlaneOperationError(403, 'oauth_scope_insufficient', `The operation requires ${missingScope}.`);
			if (descriptor.idempotency.required && !idempotencyKey) {
				throw new ControlPlaneOperationError(400, 'idempotency_key_required', `${descriptor.idempotency.header} is required.`);
			}
			if (descriptor.concurrency.required && !context.req.header(descriptor.concurrency.writeHeader)) {
				throw new ControlPlaneOperationError(412, 'precondition_required', `${descriptor.concurrency.writeHeader} is required.`);
			}
			const parsed = await operationInput(context, operation);
			const input = parsed.input;
			if (descriptor.confirmation === 'input_required') {
				if (!confirmations || !authInfo?.extra?.principal || !authInfo.clientId) {
					throw new ControlPlaneOperationError(503, 'confirmation_unavailable', 'Confirmation is not configured.');
				}
				const identity = { principalId: String((authInfo.extra.principal as any).id), clientId: authInfo.clientId,
					operationId: descriptor.operationId, arguments: input };
				const supplied = decodeConfirmation(context.req.header('x-treeseed-confirmation'));
				if (!supplied) {
					const required = confirmations.request({ ...identity, requestId });
					return context.json({ type: 'https://treeseed.dev/problems/confirmation_required', title: 'Confirmation required',
						status: 409, code: 'confirmation_required', detail: required.prompt, instance: new URL(context.req.url).pathname,
						requestId, inputRequired: required }, 409, { 'content-type': 'application/problem+json', 'x-request-id': requestId });
				}
				if (!await confirmations.verify(supplied, identity)) {
					throw new ControlPlaneOperationError(409, 'confirmation_invalid', 'The confirmation is invalid, expired, changed, or already used.');
				}
			}
			const providerAuth = context.get('capacityProviderAccessAuth') as { principal?: { membershipId?: string; capacityProviderId?: string; teamId?: string; scopes?: string[] } } | undefined;
			const providerIdentity = providerAuth?.principal;
			const output = operation.binding.schema.output.parse(await operation.handler(input, {
				interface: 'rest',
				requestId,
				traceparent: context.req.header('traceparent'),
				idempotencyKey,
				ifMatch: context.req.header(descriptor.concurrency.writeHeader)?.replace(/^"|"$/gu, ''),
				rawBody: parsed.rawBody,
				requestHeaders: Object.fromEntries(['content-type', 'content-length', 'x-hub-signature-256',
					'x-github-delivery', 'x-github-event', 'authorization', 'x-treeseed-provider-proof',
					'cf-connecting-ip', 'x-forwarded-for'].map((name) => [name, context.req.header(name) ?? ''])),
				providerAuth,
				signal: context.req.raw.signal,
				authInfo,
				principal: authInfo?.extra?.principal as { id: string; roles?: string[]; permissions?: string[] } | undefined
					?? (providerIdentity ? { id: `capacity-provider:${providerIdentity.capacityProviderId ?? providerIdentity.membershipId}`,
						roles: ['capacity_provider'], permissions: providerIdentity.scopes ?? [], metadata: { membershipId: providerIdentity.membershipId, teamId: providerIdentity.teamId } } : undefined),
			}));
			if (descriptor.operationId === 'repositories.github.callback' && typeof (output as any).redirect === 'string') {
				return context.redirect((output as any).redirect, 302);
			}
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
