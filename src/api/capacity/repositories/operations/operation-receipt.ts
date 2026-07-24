import { randomUUID } from 'node:crypto';
import type { CapacityDatabaseOperation, CapacityGovernanceDatabase } from '../../database.ts';
import { CapacityGovernanceError } from '../../database.ts';
import { canonicalJson, sha256 } from '../../security.ts';

interface OperationReceiptRow extends Record<string, unknown> {
	request_digest?: unknown;
	response_json?: unknown;
}

export interface CapacityOperationIdentity {
	teamId: string;
	operation: string;
	idempotencyKey: string;
	request: unknown;
}

export class CapacityOperationReceiptRepository {
	constructor(private readonly database: CapacityGovernanceDatabase) {}

	digest(request: unknown) {
		return sha256(canonicalJson(request));
	}

	async replay<T>(identity: CapacityOperationIdentity): Promise<{ found: false } | { found: true; response: T }> {
		if (!identity.idempotencyKey.trim()) {
			throw new CapacityGovernanceError('capacity_idempotency_key_required', 'An idempotency key is required.', 400);
		}
		await this.database.ensureInitialized();
		const row = await this.database.first<OperationReceiptRow>(
			`SELECT request_digest, response_json
			 FROM capacity_operation_receipts
			 WHERE team_id = ? AND operation = ? AND idempotency_key = ?
			 LIMIT 1`,
			[identity.teamId, identity.operation, identity.idempotencyKey],
		);
		if (!row) return { found: false };
		if (String(row.request_digest) !== this.digest(identity.request)) {
			throw new CapacityGovernanceError(
				'capacity_idempotency_key_conflict',
				'The idempotency key is already bound to different operation input.',
				409,
				{ operation: identity.operation },
			);
		}
		try {
			return { found: true, response: JSON.parse(String(row.response_json)) as T };
		} catch {
			throw new CapacityGovernanceError(
				'capacity_operation_receipt_invalid',
				'The durable capacity operation receipt is invalid.',
				500,
				{ operation: identity.operation },
			);
		}
	}

	insertOperation(
		identity: CapacityOperationIdentity,
		resourceType: string,
		resourceId: string | null,
		response: unknown,
		now: string,
	): CapacityDatabaseOperation {
		return {
			query: `INSERT INTO capacity_operation_receipts (
				id, team_id, operation, idempotency_key, request_digest, resource_type,
				resource_id, response_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			params: [
				randomUUID(),
				identity.teamId,
				identity.operation,
				identity.idempotencyKey,
				this.digest(identity.request),
				resourceType,
				resourceId,
				canonicalJson(response),
				now,
				now,
			],
		};
	}

	insertOperationWhen(
		identity: CapacityOperationIdentity,
		resourceType: string,
		resourceId: string | null,
		response: unknown,
		now: string,
		guardQuery: string,
		guardParams: unknown[],
	): CapacityDatabaseOperation {
		const values = [
			randomUUID(),
			identity.teamId,
			identity.operation,
			identity.idempotencyKey,
			this.digest(identity.request),
			resourceType,
			resourceId,
			canonicalJson(response),
			now,
			now,
		];
		return {
			query: `INSERT INTO capacity_operation_receipts (
				id, team_id, operation, idempotency_key, request_digest, resource_type,
				resource_id, response_json, created_at, updated_at
			) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (${guardQuery})`,
			params: [...values, ...guardParams],
		};
	}
}
