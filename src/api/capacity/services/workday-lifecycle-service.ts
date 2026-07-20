import { CapacityGovernanceError } from '../database.ts';

export type CapacityWorkdayStatus =
	| 'draft'
	| 'queued'
	| 'active'
	| 'paused'
	| 'completed'
	| 'cancelled'
	| 'failed'
	| 'degraded';

const TERMINAL_STATUSES = new Set<CapacityWorkdayStatus>(['completed', 'cancelled', 'failed', 'degraded']);
const TRANSITIONS: Record<CapacityWorkdayStatus, readonly CapacityWorkdayStatus[]> = {
	draft: ['queued', 'active', 'cancelled'],
	queued: ['active', 'cancelled', 'failed'],
	active: ['paused', 'completed', 'cancelled', 'failed', 'degraded'],
	paused: ['active', 'completed', 'cancelled', 'failed', 'degraded'],
	completed: [],
	cancelled: [],
	failed: [],
	degraded: [],
};

const STATUSES = new Set<CapacityWorkdayStatus>(Object.keys(TRANSITIONS) as CapacityWorkdayStatus[]);
const SECRET_KEY = /(?:^|_)(?:api_?key|token|registration_?key|credential|password|private_?key|secret)(?:$|_)/iu;

function normalizedKey(key: string) {
	return key.replace(/([a-z0-9])([A-Z])/gu, '$1_$2').replace(/[^a-z0-9]+/giu, '_').toLowerCase();
}

function secretPath(value: unknown, path = 'parameters'): string | null {
	if (Array.isArray(value)) {
		for (const [index, item] of value.entries()) {
			const found = secretPath(item, `${path}[${index}]`);
			if (found) return found;
		}
		return null;
	}
	if (!value || typeof value !== 'object') return null;
	for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
		const nextPath = `${path}.${key}`;
		const normalized = normalizedKey(key);
		const protectedReference = normalized.endsWith('_ref') && typeof item === 'string' && /^[a-z][a-z0-9+.-]*:\/\//iu.test(item);
		if (SECRET_KEY.test(normalized) && !protectedReference) return nextPath;
		const found = secretPath(item, nextPath);
		if (found) return found;
	}
	return null;
}

export function capacityWorkdayStatus(value: unknown, fallback: CapacityWorkdayStatus): CapacityWorkdayStatus {
	const status = String(value ?? fallback) as CapacityWorkdayStatus;
	if (!STATUSES.has(status)) {
		throw new CapacityGovernanceError('capacity_workday_status_invalid', `Unknown capacity workday status ${status}.`, 400);
	}
	return status;
}

export function assertCapacityWorkdayParametersSafe(parameters: unknown) {
	const path = secretPath(parameters);
	if (path) {
		throw new CapacityGovernanceError(
			'capacity_workday_secret_forbidden',
			`Capacity workday records may contain secret references but never secret values or secret-shaped fields (${path}).`,
			400,
			{ path },
		);
	}
}

export function assertRunningCapacityWorkdayBounded(input: {
	status: string;
	durationSeconds: number;
	deadlineAt: string | null;
}) {
	if (input.status !== 'running') return;
	const deadlineValid = typeof input.deadlineAt === 'string' && Number.isFinite(Date.parse(input.deadlineAt));
	if (input.durationSeconds <= 0 && !deadlineValid) {
		throw new CapacityGovernanceError(
			'capacity_workday_bound_required',
			'A running capacity workday requires a positive durationSeconds or a valid deadlineAt.',
			400,
		);
	}
}

export function assertCapacityWorkdayTransition(current: CapacityWorkdayStatus, next: CapacityWorkdayStatus) {
	if (current === next) return;
	if (!TRANSITIONS[current].includes(next)) {
		throw new CapacityGovernanceError(
			'capacity_workday_transition_invalid',
			`Cannot transition a capacity workday from ${current} to ${next}.`,
			409,
			{ current, next, terminal: TERMINAL_STATUSES.has(current) },
		);
	}
}

export function capacityWorkdayTimestampField(status: CapacityWorkdayStatus) {
	if (status === 'active') return 'started_at';
	if (status === 'paused') return 'paused_at';
	if (TERMINAL_STATUSES.has(status)) return 'completed_at';
	return null;
}
