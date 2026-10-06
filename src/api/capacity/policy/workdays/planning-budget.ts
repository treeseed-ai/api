import { CapacityGovernanceError } from '../../database.ts';

/** Profile durations are maxima, not mandatory reservations. Max-min allocation
 * preserves every participant and keeps rounding deterministic across replays. */
export function boundedPlanningParticipants<T extends { nodeId: string; timeboxSeconds: number }>(participants: T[], allocatedSeconds: number): T[] {
	if (!Number.isSafeInteger(allocatedSeconds) || allocatedSeconds < 0
		|| new Set(participants.map(item => item.nodeId)).size !== participants.length
		|| participants.some(item => !Number.isSafeInteger(item.timeboxSeconds) || item.timeboxSeconds < 1))
		throw new CapacityGovernanceError('capacity_planning_budget_invalid', 'Planning requires finite integer budgets and unique participants.', 409);
	if (allocatedSeconds < participants.length) throw new CapacityGovernanceError(
		'capacity_planning_session_time_insufficient', 'Planning needs at least one productive second per participant; increase the planning budget or explicitly narrow the selected profiles.',
		409, { requiredSeconds: participants.length, allocatedSeconds, participants: participants.length });
	const ordered = [...participants].sort((a, b) => a.nodeId.localeCompare(b.nodeId));
	const assigned = new Map(ordered.map(item => [item.nodeId, 0]));
	let remaining = allocatedSeconds;
	let pending = ordered;
	while (remaining && pending.length) {
		const share = Math.max(1, Math.floor(remaining / pending.length));
		for (const item of pending) {
			const current = assigned.get(item.nodeId)!;
			const amount = Math.min(share, item.timeboxSeconds - current, remaining);
			assigned.set(item.nodeId, current + amount); remaining -= amount;
		}
		pending = pending.filter(item => assigned.get(item.nodeId)! < item.timeboxSeconds);
	}
	return participants.map(item => ({ ...item, timeboxSeconds: assigned.get(item.nodeId)! }));
}

export function planningInstanceTimebox(nodeBudget: number, instances: number): number {
	if (!Number.isSafeInteger(nodeBudget) || !Number.isSafeInteger(instances) || instances < 1 || nodeBudget < instances)
		throw new CapacityGovernanceError('capacity_planning_instance_budget_insufficient', 'Planning node budget cannot fund its selected instances.', 409);
	return Math.floor(nodeBudget / instances);
}
