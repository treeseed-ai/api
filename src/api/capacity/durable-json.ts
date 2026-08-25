import { CapacityGovernanceError } from './database.ts';

export interface DurableJsonContext {
	owner: string;
	ownerId?: string | null;
	column: string;
}

function decode(value: unknown, context: DurableJsonContext): unknown {
	if (typeof value !== 'string' || !value) {
		throw new CapacityGovernanceError(
			'capacity_durable_json_invalid',
			`${context.owner} has missing ${context.column}.`,
			500,
			{ owner: context.owner, ownerId: context.ownerId ?? null, column: context.column },
		);
	}
	try {
		return JSON.parse(value);
	} catch {
		throw new CapacityGovernanceError(
			'capacity_durable_json_invalid',
			`${context.owner} contains invalid ${context.column}.`,
			500,
			{ owner: context.owner, ownerId: context.ownerId ?? null, column: context.column },
		);
	}
}

export function decodeDurableJsonObject(value: unknown, context: DurableJsonContext): Record<string, unknown> {
	const decoded = decode(value, context);
	if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
		throw new CapacityGovernanceError(
			'capacity_durable_json_invalid',
			`${context.owner} ${context.column} must be an object.`,
			500,
			{ owner: context.owner, ownerId: context.ownerId ?? null, column: context.column },
		);
	}
	return decoded as Record<string, unknown>;
}

export function decodeDurableJsonArray<T = unknown>(value: unknown, context: DurableJsonContext): T[] {
	const decoded = decode(value, context);
	if (!Array.isArray(decoded)) {
		throw new CapacityGovernanceError(
			'capacity_durable_json_invalid',
			`${context.owner} ${context.column} must be an array.`,
			500,
			{ owner: context.owner, ownerId: context.ownerId ?? null, column: context.column },
		);
	}
	return decoded as T[];
}
