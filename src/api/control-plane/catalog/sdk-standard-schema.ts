import type { ControlPlaneOperationBinding } from '@treeseed/sdk/operator-contracts';
import { zodToJsonSchema } from 'zod-to-json-schema';

type SdkSchema = ControlPlaneOperationBinding<any, any, any, any>['schema']['output'];

function jsonSchema(schema: SdkSchema) {
	return zodToJsonSchema(schema, { target: 'openApi3', $refStrategy: 'none' });
}

function issues(error: { issues: Array<{ message: string; path: Array<string | number> }> }) {
	return error.issues.map((issue) => ({ message: issue.message, path: issue.path }));
}

export function sdkStandardSchema(schema: SdkSchema) {
	const document = jsonSchema(schema);
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

export function sdkOperationInputStandardSchema(binding: ControlPlaneOperationBinding<any, any, any, any>) {
	const document = {
		type: 'object',
		properties: {
			path: jsonSchema(binding.schema.path),
			query: jsonSchema(binding.schema.query),
			...(binding.descriptor.kind === 'mutation' ? { body: jsonSchema(binding.schema.body) } : {}),
		},
		additionalProperties: false,
	};
	return {
		'~standard': {
			version: 1 as const,
			vendor: 'treeseed-sdk',
			validate(value: unknown) {
				const input = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
				const path = binding.schema.path.safeParse(input.path ?? {});
				const query = binding.schema.query.safeParse(input.query ?? {});
				const body = binding.schema.body.safeParse(binding.descriptor.kind === 'mutation' ? input.body ?? {} : undefined);
				if (!path.success) return { issues: issues(path.error) };
				if (!query.success) return { issues: issues(query.error) };
				if (!body.success) return { issues: issues(body.error) };
				return { value: { path: path.data, query: query.data, body: body.data } };
			},
			jsonSchema: { input: () => document, output: () => document },
		},
	};
}

export function sdkSchemaJson(schema: SdkSchema) {
	return jsonSchema(schema);
}
