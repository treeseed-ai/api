import { AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv';
import { CONTROL_PLANE_OPERATIONS, type ControlPlaneOperationBinding } from '@treeseed/sdk/operator-contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod/v3';
import { sdkOperationInputStandardSchema, sdkSchemaJson, sdkStandardSchema } from '../../../../src/api/control-plane/catalog/sdk-standard-schema.ts';

function bindings(value: unknown): ControlPlaneOperationBinding[] {
	if (!value || typeof value !== 'object') return [];
	if ('descriptor' in value && 'schema' in value) return [value as ControlPlaneOperationBinding];
	return Object.values(value).flatMap(bindings);
}

describe('MCP JSON Schema dialect', () => {
	it('compiles every declared MCP tool input and output with the official client validator', () => {
		const exposed = bindings(CONTROL_PLANE_OPERATIONS).filter(binding => binding.descriptor.surfaces.includes('mcp_tool'));
		expect(exposed.map(binding => binding.descriptor.operationId)).toContain('communications.send');
		const validator = new AjvJsonSchemaValidator(), failures: string[] = [];
		for (const binding of exposed) {
			for (const [kind, document] of [['input', sdkOperationInputStandardSchema(binding)['~standard'].jsonSchema.input()],
				['output', sdkStandardSchema(binding.schema.output)['~standard'].jsonSchema.output()]] as const) {
				try { validator.getValidator(document); }
				catch (error) { failures.push(`${binding.descriptor.operationId}.${kind}: ${String(error)}`); }
			}
		}
		expect(failures).toEqual([]);
	});
	it('preserves native numeric nullable tuple and strict object constraints without changing OpenAPI projection', () => {
		const schema = z.object({ positive: z.number().positive(), ceiling: z.number().lt(4), inclusive: z.number().min(2).max(3),
			optional: z.string().nullable(), pair: z.tuple([z.string(), z.number()]) }).strict();
		const document = sdkStandardSchema(schema)['~standard'].jsonSchema.output();
		const validate = new AjvJsonSchemaValidator().getValidator(document);
		const valid = { positive: 1, ceiling: 3, inclusive: 2, optional: null, pair: ['row', 2] };
		for (const value of [valid, { ...valid, optional: 'present' }, { ...valid, positive: 0 }, { ...valid, ceiling: 4 },
			{ ...valid, inclusive: 1 }, { ...valid, inclusive: 4 }, { ...valid, pair: [2, 'row'] }, { ...valid, unexpected: true }]) {
			expect(validate(value).valid).toBe(schema.safeParse(value).success);
		}
		expect(sdkSchemaJson(schema)).toMatchObject({ properties: { positive: { minimum: 0, exclusiveMinimum: true },
			optional: { type: 'string', nullable: true } } });
	});
});
