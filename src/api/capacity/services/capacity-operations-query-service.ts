import type {
	ApprovalRequest,
	CapacityLedgerEntry,
	CapacityReservation,
	CapacityUsageActual,
	ProjectCapacityDiagnostics,
} from '@treeseed/sdk';
import type { CapacityPage } from '@treeseed/sdk/capacity-pagination';
import type { CapacityGovernanceDatabase } from '../database.ts';
import type { ProjectCapacitySummary } from './capacity-summary-service.ts';
import type { ProjectCapacityEnvironment } from './project-capacity-diagnostics-service.ts';

interface CapacityOperationsStore extends CapacityGovernanceDatabase {
	getProjectCapacityDiagnostics(projectId: string, environment: ProjectCapacityEnvironment): Promise<ProjectCapacityDiagnostics | null>;
	getProjectCapacitySummary(projectId: string, environment: ProjectCapacityEnvironment): Promise<ProjectCapacitySummary | null>;
	listCapacityReservationsForProjectPage(projectId: string, filters: { limit: number }): Promise<CapacityPage<CapacityReservation>>;
	listCapacityLedgerEntriesPage(projectId: string, filters: { limit: number }): Promise<CapacityPage<CapacityLedgerEntry>>;
	listTaskUsageActualsForProject(projectId: string, limit: number): Promise<CapacityUsageActual[]>;
	listApprovalRequestsForProject(projectId: string, limit: number): Promise<ApprovalRequest[]>;
}

function interrupted(reservation: CapacityReservation): boolean {
	return reservation.state === 'overran_pending_approval'
		|| reservation.state === 'continuation_required'
		|| reservation.metadata?.interrupted === true
		|| Boolean(reservation.metadata?.checkpointId);
}

export class CapacityOperationsQueryService {
	constructor(private readonly store: CapacityOperationsStore) {}

	async project(projectId: string, environment: ProjectCapacityEnvironment = 'staging') {
		await this.store.ensureInitialized();
		const [diagnostics, summary, reservations, ledgerEntries, usageActuals, approvalRequests] = await Promise.all([
			this.store.getProjectCapacityDiagnostics(projectId, environment),
			this.store.getProjectCapacitySummary(projectId, environment),
			this.store.listCapacityReservationsForProjectPage(projectId, { limit: 50 }),
			this.store.listCapacityLedgerEntriesPage(projectId, { limit: 50 }),
			this.store.listTaskUsageActualsForProject(projectId, 50),
			this.store.listApprovalRequestsForProject(projectId, 50),
		]);
		return {
			projectId, environment, summary, diagnostics,
			reservations: reservations.items, reservationPage: reservations.page,
			ledgerEntries: ledgerEntries.items, ledgerPage: ledgerEntries.page,
			usageActuals, approvalRequests,
			pendingApprovalRequests: approvalRequests.filter((request) => request.state === 'pending'),
			interruptionReservations: reservations.items.filter(interrupted),
		};
	}
}
