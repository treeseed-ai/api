import type { CapacityPageCursor } from '@treeseed/sdk/capacity-pagination';
import type { CapacityGovernanceDatabase } from '../../database.ts';
import { CapacityGovernanceError } from '../../database.ts';
import { CapacityLedgerRepository } from '../../repositories/capacity/accounting/ledger.ts';
import { listTaskUsageActualsPage } from '../../repositories/capacity/accounting/task-usage.ts';

export interface CapacityOperatorEvidencePage {
	projectId: string;
	workDayId?: string | null;
	limit: number;
	cursor: CapacityPageCursor | null;
}

export class CapacityOperatorEvidenceService {
	private readonly ledger: CapacityLedgerRepository;

	constructor(private readonly database: CapacityGovernanceDatabase) {
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
