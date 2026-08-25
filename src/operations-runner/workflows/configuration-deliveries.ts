import { createHash, timingSafeEqual } from 'node:crypto';

export interface WorkflowConfigurationDelivery {
	id: string;
	operationId: string;
	payload: string | null;
	keyId: string | null;
	payloadDigest: string | null;
	expiresAt: string;
}

const deliveries = new Map<string, WorkflowConfigurationDelivery>();

function digest(value: string) {
	return createHash('sha256').update(value).digest('hex');
}

function sameDigest(actual: string, expected: string) {
	const left = Buffer.from(actual, 'hex');
	const right = Buffer.from(expected, 'hex');
	return left.length === right.length && timingSafeEqual(left, right);
}

export function registerWorkflowConfigurationDelivery(delivery: WorkflowConfigurationDelivery) {
	const expiresAt = Date.parse(delivery.expiresAt);
	if (!delivery.id || !delivery.operationId || !Number.isFinite(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 120_000) {
		throw new Error('The workflow configuration delivery scope is invalid.');
	}
	if (delivery.payload !== null) {
		if (!delivery.payloadDigest || !sameDigest(digest(delivery.payload), delivery.payloadDigest)) {
			throw new Error('The workflow configuration delivery digest does not match.');
		}
	}
	deliveries.set(delivery.id, { ...delivery });
}

export function consumeWorkflowConfigurationDelivery(id: string, operationId: string) {
	const delivery = deliveries.get(id);
	deliveries.delete(id);
	if (!delivery || delivery.operationId !== operationId || Date.parse(delivery.expiresAt) <= Date.now()) {
		throw new Error('The single-use workflow configuration delivery is unavailable or expired.');
	}
	return delivery;
}

export function clearWorkflowConfigurationDeliveries() {
	deliveries.clear();
}
