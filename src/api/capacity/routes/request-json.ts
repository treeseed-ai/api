import type { Context } from 'hono';
import { CapacityGovernanceError } from '../database.ts';

export interface CapacityRequestJsonOptions {
	optional?: boolean;
}

export async function readCapacityRequestObject(
	c: Context,
	options: CapacityRequestJsonOptions = {},
): Promise<Record<string, unknown>> {
	const raw = await c.req.text();
	if (!raw.trim()) {
		if (options.optional) return {};
		throw new CapacityGovernanceError(
			'capacity_request_body_required',
			'A JSON request body is required.',
			400,
		);
	}

	let decoded: unknown;
	try {
		decoded = JSON.parse(raw);
	} catch {
		throw new CapacityGovernanceError(
			'capacity_request_json_invalid',
			'Capacity request body must contain valid JSON.',
			400,
		);
	}

	if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
		throw new CapacityGovernanceError(
			'capacity_request_json_invalid',
			'Capacity request body must be a JSON object.',
			400,
		);
	}
	return decoded as Record<string, unknown>;
}
