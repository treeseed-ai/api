import { controlPlaneSchemaJson, type ControlPlaneOperationBinding } from '@treeseed/sdk/operator-contracts';

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
	descriptor: Pick<ControlPlaneOperationBinding['descriptor'], 'kind'>;
	schema: { path: SdkSchema; query: SdkSchema; body: SdkSchema };
}) {
	const document = {
		type: 'object',
		properties: {
			path: controlPlaneSchemaJson(binding.schema.path),
			query: controlPlaneSchemaJson(binding.schema.query),
			...(binding.descriptor.kind === 'mutation' ? { body: controlPlaneSchemaJson(binding.schema.body) } : {}),
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
	return controlPlaneSchemaJson(schema);
}
