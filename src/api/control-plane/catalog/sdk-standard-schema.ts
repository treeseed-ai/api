import { controlPlaneSchemaJson, type ControlPlaneOperationBinding } from '@treeseed/sdk/operator-contracts';
import { z } from 'zod';

type SdkSchema = ControlPlaneOperationBinding<unknown, unknown, unknown, unknown>['schema']['output'];

function issues(error: { issues: Array<{ message: string; path: Array<string | number> }> }) {
	return error.issues.map((issue) => ({ message: issue.message, path: issue.path }));
}

export function sdkStandardSchema(schema: SdkSchema) {
	const document = controlPlaneSchemaJson(schema);
	return {
		'~standard': {
			version: 1 as const,
			vendor: 'treeseed-sdk',
			validate(value: unknown) {
				const result = schema.safeParse(value);
				return result.success ? { value: result.data } : { issues: issues(result.error) };
			},
			jsonSchema: {
				input: () => document,
				output: () => document,
			},
		},
	};
}

export function sdkOperationInputStandardSchema(binding: {
	descriptor: Pick<ControlPlaneOperationBinding['descriptor'], 'kind' | 'idempotency' | 'concurrency'>;
	schema: { path: SdkSchema; query: SdkSchema; body: SdkSchema };
}) {
	const headerNames: string[] = binding.descriptor.kind === 'mutation'
		? [binding.descriptor.idempotency.header, ...(binding.descriptor.concurrency.required ? [binding.descriptor.concurrency.writeHeader] : [])] : [];
	const headersSchema = headerNames.length ? z.object(Object.fromEntries(headerNames.map(name => [name,
		z.string().min(1).regex(/^(?=.*\S)[^\r\n\u0000]+$/u).describe(name === binding.descriptor.idempotency.header
			? 'Reuse this key for retries of the unchanged request.' : 'Exact current resource version read before this mutation.'),
	]))).strict() : undefined;
	const document = {
		type: 'object',
		properties: {
			path: controlPlaneSchemaJson(binding.schema.path),
			query: controlPlaneSchemaJson(binding.schema.query),
			...(binding.descriptor.kind === 'mutation' ? { body: controlPlaneSchemaJson(binding.schema.body) } : {}),
			...(headersSchema ? { headers: z.toJSONSchema(headersSchema) } : {}),
		},
		additionalProperties: false,
	};
	return {
		'~standard': {
			version: 1 as const,
			vendor: 'treeseed-sdk',
			validate(value: unknown) {
				const input = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
				let headers: Record<string, string> | undefined;
				if (input.headers !== undefined) {
					if (!headersSchema) {
						return { issues: [{ path: ['headers'], message: 'Supply only the advertised mutation headers.' }] };
					}
					const parsed = headersSchema.safeParse(input.headers);
					if (!parsed.success) return { issues: parsed.error.issues.map(issue => ({ path: ['headers', ...issue.path.map(String)], message: issue.message })) };
					headers = parsed.data;
				}
				const path = binding.schema.path.safeParse(input.path ?? {});
				const query = binding.schema.query.safeParse(input.query ?? {});
				const body = binding.schema.body.safeParse(binding.descriptor.kind === 'mutation' ? input.body ?? {} : undefined);
				if (!path.success) return { issues: issues(path.error) };
				if (!query.success) return { issues: issues(query.error) };
				if (!body.success) return { issues: issues(body.error) };
				return { value: { path: path.data, query: query.data, body: body.data,
					...(headers !== undefined ? { headers } : {}) } };
			},
			jsonSchema: { input: () => document, output: () => document },
		},
	};
}

export function sdkSchemaJson(schema: SdkSchema) {
	return controlPlaneSchemaJson(schema);
}
