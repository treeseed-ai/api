import { MAX_CAPACITY_PAGE_LIMIT } from '@treeseed/sdk/capacity-pagination';
import type { CapacityGovernanceDatabase } from '../database.ts';
import { CapacityGovernanceError } from '../database.ts';

interface WorkdayEnvelopeTerminalizationStore extends CapacityGovernanceDatabase {
	updateWorkdayCapacityEnvelopeState(workdayId: string, status: string): Promise<{ status?: unknown } | null>;
}

const TERMINAL_STATUSES = new Set(['completed', 'cancelled', 'failed', 'degraded']);

export async function terminalizeCapacityWorkdayEnvelopes(
	store: WorkdayEnvelopeTerminalizationStore,
	teamId: string,
	runId: string,
	status: string,
): Promise<{ terminalized: number }> {
	if (!TERMINAL_STATUSES.has(status)) {
		throw new CapacityGovernanceError(
			'capacity_workday_envelope_terminal_status_invalid',
			`Unknown workday envelope terminal status ${status}.`,
			400,
			{ status },
		);
	}
	let terminalized = 0;
	while (true) {
		const rows = await store.all(
			`SELECT id FROM workday_capacity_envelopes
			 WHERE team_id = ? AND workday_run_id = ?
			   AND status NOT IN ('completed', 'cancelled', 'failed', 'degraded')
			 ORDER BY id ASC LIMIT ?`,
			[teamId, runId, MAX_CAPACITY_PAGE_LIMIT],
		);
		if (rows.length === 0) return { terminalized };
		for (const row of rows) {
			const workdayId = typeof row.id === 'string' ? row.id : '';
			if (!workdayId) {
				throw new CapacityGovernanceError(
					'capacity_workday_envelope_corrupt',
					'Run-owned workday envelope has no valid id.',
					500,
					{ runId },
				);
			}
			const updated = await store.updateWorkdayCapacityEnvelopeState(workdayId, status);
			if (!updated || updated.status !== status) {
				throw new CapacityGovernanceError(
					'capacity_workday_envelope_terminalization_failed',
					`Workday envelope ${workdayId} did not reach ${status}.`,
					500,
					{ runId, workdayId, status },
				);
			}
			terminalized += 1;
		}
	}
}

export async function closeCapacityWorkdayAdmission(
	store: WorkdayEnvelopeTerminalizationStore,
	teamId: string,
	runId: string,
): Promise<{ closed: number }> {
	let closed = 0;
	while (true) {
		const rows = await store.all(
			`SELECT id FROM workday_capacity_envelopes WHERE team_id = ? AND workday_run_id = ? AND status = 'active' ORDER BY id ASC LIMIT ?`,
			[teamId, runId, MAX_CAPACITY_PAGE_LIMIT],
		);
		if (!rows.length) return { closed };
		for (const row of rows) {
			const workdayId = typeof row.id === 'string' ? row.id : '';
			if (!workdayId) throw new CapacityGovernanceError('capacity_workday_envelope_corrupt', 'Run-owned workday envelope has no valid id.', 500, { runId });
			const updated = await store.updateWorkdayCapacityEnvelopeState(workdayId, 'paused');
			if (!updated || updated.status !== 'paused') throw new CapacityGovernanceError(
				'capacity_workday_admission_close_failed', `Workday envelope ${workdayId} did not stop admission.`, 500, { runId, workdayId },
			);
			closed += 1;
		}
	}
}
