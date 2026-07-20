import type { Context } from 'hono';
import type { CapacityGovernanceDatabase } from '../database.ts';
import { CapacityGovernanceError } from '../database.ts';

export interface CapacityRuntimeRouteOptions {
	store: CapacityGovernanceDatabase;
	requireTeamAccess(c: Context, store: CapacityGovernanceDatabase, teamId: string, permission: string): Promise<{ response?: Response | null }>;
}

export function capacityRuntimeFailure(c: Context, error: unknown) {
	if (error instanceof CapacityGovernanceError) return c.json({ ok: false, error: error.message, code: error.code, details: error.details }, { status: error.status });
	return c.json({ ok: false, error: error instanceof Error ? error.message : String(error), code: 'capacity_runtime_failed' }, { status: 500 });
}

export function requireCapacityIdempotencyKey(c: Context) {
	const key = c.req.header('idempotency-key')?.trim();
	if (!key) throw new CapacityGovernanceError('idempotency_key_required', 'Idempotency-Key is required.', 400);
	return key;
}
