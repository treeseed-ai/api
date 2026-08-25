import { CapacityGovernanceError } from '../../../../../database.ts';
import type { ProviderSynthesisExecutionProvider } from '../../../providers/provider-synthesis-context-service.ts';

export async function assertBatteryAdmission(input: {
	store: any;
	teamId: string;
	providerId: string;
	executionProvider: ProviderSynthesisExecutionProvider;
	lanes: ProviderSynthesisExecutionProvider['lanes'];
	laneLoads: ReadonlyMap<string, number>;
	requestedLane: 'communication' | 'platform' | 'workday';
}) {
	const active = await input.store.first(`SELECT COUNT(*) AS count FROM capacity_provider_assignments WHERE capacity_provider_id = ? AND status IN ('pending','leased','running')`, [input.providerId]);
	const activeTotal = Number(active?.count ?? 0);
	if (activeTotal >= input.executionProvider.maxConcurrentRunners) throw new CapacityGovernanceError('capacity_provider_battery_exhausted', 'The provider-wide worker budget is exhausted.', 409, { activeTotal, maxConcurrentWorkers: input.executionProvider.maxConcurrentRunners });
	if (input.requestedLane === 'communication') return;
	const communication = input.lanes.find((candidate) => candidate.purpose === 'communication');
	const waiting = await input.store.first(`SELECT COUNT(*) AS count FROM agent_invocation_requests WHERE team_id = ? AND execution_kind = 'conversation' AND status IN ('queued','blocked','admitted')`, [input.teamId]);
	if (!communication || Number(waiting?.count ?? 0) === 0) return;
	const protectedWorkers = Math.max(0, communication.reservedConcurrentWorkers - Number(input.laneLoads.get(communication.id) ?? 0));
	if (activeTotal >= input.executionProvider.maxConcurrentRunners - protectedWorkers) throw new CapacityGovernanceError('capacity_communication_reserve_reclaiming', 'Communication demand is reclaiming its reserved capacity through admission control.', 409, { activeTotal, protectedWorkers });
}
