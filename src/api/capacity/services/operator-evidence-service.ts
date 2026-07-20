import type { CapacityPageCursor } from '@treeseed/sdk/capacity-pagination';
import type { CapacityGovernanceDatabase } from '../database.ts';
import { CapacityGovernanceError } from '../database.ts';
import { CapacityLedgerRepository } from '../repositories/ledger.ts';
import { CapacityReservationRepository, serializeCapacityReservationRow } from '../repositories/reservation.ts';
import { listTaskUsageActualsPage } from '../repositories/task-usage.ts';

export interface CapacityOperatorEvidencePage {
	projectId: string;
	workDayId?: string | null;
	limit: number;
	cursor: CapacityPageCursor | null;
}

export class CapacityOperatorEvidenceService {
	private readonly reservations: CapacityReservationRepository;
	private readonly ledger: CapacityLedgerRepository;

	constructor(private readonly database: CapacityGovernanceDatabase) {
		this.reservations = new CapacityReservationRepository(database);
		this.ledger = new CapacityLedgerRepository(database);
	}

	private async assertProject(teamId: string, projectId: string) {
		if (!projectId) {
			throw new CapacityGovernanceError(
				'capacity_project_scope_required',
				'projectId is required for capacity evidence inspection.',
				400,
			);
		}
		const project = await this.database.first(
			'SELECT id FROM projects WHERE id = ? AND team_id = ? LIMIT 1',
			[projectId, teamId],
		);
		if (!project) throw new CapacityGovernanceError('capacity_project_not_found', 'Project does not exist in this team.', 404);
	}

	async listReservations(teamId: string, page: CapacityOperatorEvidencePage) {
		await this.assertProject(teamId, page.projectId);
		return this.reservations.listProjectPage(page.projectId, {
			workDayId: page.workDayId,
			limit: page.limit,
			cursor: page.cursor,
		});
	}

	async explainReservation(teamId: string, reservationId: string) {
		await this.database.ensureInitialized();
		const row = await this.database.first(
			'SELECT * FROM capacity_reservations WHERE id = ? AND team_id = ? LIMIT 1',
			[reservationId, teamId],
		);
		const reservation = serializeCapacityReservationRow(row);
		if (!reservation) throw new CapacityGovernanceError('capacity_reservation_not_found', 'Capacity reservation does not exist.', 404);
		const claims = await this.database.all(
			`SELECT claim.counter_id, counter.scope, counter.scope_id, counter.period_key,
			        counter.hard_limit, counter.committed_amount, claim.reserved_amount,
			        claim.released_amount, claim.release_policy
			   FROM capacity_reservation_counter_claims claim
			   JOIN capacity_admission_counters counter ON counter.id = claim.counter_id
			  WHERE claim.reservation_id = ?
			  ORDER BY claim.counter_id ASC`,
			[reservationId],
		);
		return { reservation, policySnapshot: reservation.policySnapshot, counterClaims: claims };
	}

	async listUsage(teamId: string, page: CapacityOperatorEvidencePage) {
		await this.assertProject(teamId, page.projectId);
		return listTaskUsageActualsPage(this.database, page.projectId, {
			workDayId: page.workDayId,
			limit: page.limit,
			cursor: page.cursor,
		});
	}

	async listLedger(teamId: string, page: CapacityOperatorEvidencePage) {
		await this.assertProject(teamId, page.projectId);
		return this.ledger.listProjectPage(page.projectId, {
			workDayId: page.workDayId,
			limit: page.limit,
			cursor: page.cursor,
		});
	}
}
