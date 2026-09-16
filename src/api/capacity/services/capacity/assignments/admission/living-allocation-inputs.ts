import { allocateWorkdayCapacity, appliedWorkdaySchema, remainingCapabilitySeconds, workdayPhase,
	type AllocationMeasurement, type AssignmentAllocationConstraint } from '@treeseed/sdk/agent-capacity';
import type { CapacityGovernanceDatabase } from '../../../../database.ts';
import type { DurableCapacityWorkdayRun } from '../../../../repositories/capacity/workdays/workday-run.ts';
import type { ProviderSynthesisExecutionProvider } from '../../../providers/provider-synthesis-context-service.ts';

export type LivingAllocationInputs = Record<string, { measurements: AllocationMeasurement[]; constraints: AssignmentAllocationConstraint[] }>;

/** Read existing graph/reservation/usage authority; no performance or allocation store. */
export async function livingAllocationInputs(store: CapacityGovernanceDatabase, input: {
	run: DurableCapacityWorkdayRun; runs: DurableCapacityWorkdayRun[]; providers: ProviderSynthesisExecutionProvider[]; capacityProviderId: string;
	capabilityId: string; agentClass: string; activity: string; now: string;
}): Promise<LivingAllocationInputs> {
	const result: LivingAllocationInputs = {};
	for (const provider of input.providers) {
		const limits = provider.accountingLimits, observed = provider.accountingObservation;
		const capability = limits?.capabilityLimits[input.capabilityId];
		if (!limits || !observed || !capability) continue;
		const remaining = (cap: number, observation: typeof observed.modelUsage | undefined) => observation
			? remainingCapabilitySeconds({ now: input.now, maximumObservationAgeSeconds: 90, dailyLimitSeconds: cap,
				observation, ledgerActiveSeconds: 0, ledgerReservedSeconds: 0 }).availableSeconds : 0;
		const supply = Math.min(remaining(limits.dailyActiveSecondsLimit, observed.modelUsage),
			remaining(capability.dailyActiveSecondsLimit, observed.capabilityUsage[input.capabilityId]));
		const commitments = await store.all(`SELECT reservation.work_day_id,reservation.mode,reservation.state,
			reservation.reserved_seconds,reservation.active_seconds FROM capacity_reservations reservation
			JOIN capacity_provider_assignments assignment ON assignment.id=reservation.assignment_id
			WHERE reservation.capacity_provider_id=? AND reservation.created_at>=?
			AND assignment.assignment_attempt_json::jsonb->'provider'->>'modelConfigurationId'=?
			AND assignment.assignment_attempt_json::jsonb->'provider'->>'executionCapabilityId'=?`,
			[input.capacityProviderId, `${input.now.slice(0, 10)}T00:00:00.000Z`, limits.modelConfigurationId, input.capabilityId]);
		const workdays = [];
		for (const run of input.runs) {
			const parsed = appliedWorkdaySchema.safeParse(run.parameters.appliedPlan);
			if (!parsed.success) continue;
			const plan = parsed.data, phase = workdayPhase(plan, input.now);
			const readiness = await store.first(`SELECT COUNT(*) AS ready_count FROM execution_nodes
				WHERE team_id=? AND workday_id=? AND status='ready' AND required_capabilities_json::jsonb @> ?::jsonb
				AND ${phase === 'planning' ? "kind IN ('planning','estimating','communication')" : "kind NOT IN ('planning','estimating')"}`,
				[run.teamId, run.id, JSON.stringify([input.capabilityId])]);
			const usage = commitments.filter(row => row.work_day_id === run.id).map(row => ({ planning: row.mode === 'planning',
				seconds: ['reserved', 'consuming'].includes(String(row.state)) ? Math.max(Number(row.reserved_seconds), Number(row.active_seconds)) : Number(row.active_seconds) }));
			workdays.push({ plan, committedSeconds: usage.reduce((sum, row) => sum + row.seconds, 0),
				planningCommittedSeconds: usage.filter(row => row.planning).reduce((sum, row) => sum + row.seconds, 0),
				maximumAdditionalSeconds: Number(readiness?.ready_count) > 0
					? Math.max(0, (Date.parse(plan.endsAt) - Date.parse(input.now)) / 1000) * plan.policySnapshot.maximumConcurrency : 0 });
		}
		const shares = allocateWorkdayCapacity({ remainingSeconds: supply, now: input.now, workdays });
		const rows = await store.all(`SELECT usage.id,usage.created_at,usage.active_seconds,assignment.status,assignment.lifecycle_code,
			assignment.assignment_attempt_json::jsonb->'estimate'->>'expectedSeconds' AS expected_seconds,
			assignment.assignment_attempt_json::jsonb->'limits'->>'maximumSeconds' AS allocated_seconds
			FROM capacity_usage_actuals usage JOIN capacity_provider_assignments assignment ON assignment.id=usage.assignment_id
			JOIN execution_nodes node ON node.team_id=assignment.team_id AND node.id=assignment.execution_node_id
			WHERE assignment.capacity_provider_id=? AND assignment.execution_provider_id=? AND node.agent_class=?
			AND assignment.assignment_attempt_json::jsonb->'provider'->>'modelConfigurationId'=?
			AND assignment.assignment_attempt_json::jsonb->'provider'->>'executionCapabilityId'=?
			AND assignment.assignment_attempt_json::jsonb->'effectiveProfile'->>'activity'=?
			AND usage.accounting_mode='aggregate' AND (assignment.status='completed' OR assignment.status='expired')
			ORDER BY usage.created_at DESC,usage.id DESC LIMIT 20`,
			[input.capacityProviderId, provider.id, input.agentClass, limits.modelConfigurationId, input.capabilityId, input.activity]);
		const closing = appliedWorkdaySchema.parse(input.run.parameters.appliedPlan).state === 'closing';
		result[provider.id] = { constraints: closing ? [] : [{ id: 'workday-phase-share', remainingSeconds: shares[input.run.id]?.availableSeconds ?? 0 }],
			measurements: rows.map(row => ({ id: String(row.id), completedAt: String(row.created_at), expectedSeconds: Number(row.expected_seconds),
				allocatedSeconds: Number(row.allocated_seconds), activeSeconds: Number(row.active_seconds), outcome: row.status === 'completed' ? 'completed' : 'expired' })) };
	}
	return result;
}
