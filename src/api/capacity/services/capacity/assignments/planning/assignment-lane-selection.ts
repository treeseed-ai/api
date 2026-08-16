import type { ProviderSynthesisExecutionProvider } from '../../providers/provider-synthesis-context-service.ts';

export function selectAssignmentLane(
	executionKind: 'workday' | 'conversation' | 'simulation' | 'recovery',
	lanes: ProviderSynthesisExecutionProvider['lanes'],
	laneLoads: ReadonlyMap<string, number>,
) {
	const requestedPurpose = executionKind === 'conversation' ? 'communication' as const : 'operation' as const;
	let lane = lanes.find((candidate) => candidate.purpose === requestedPurpose && Number(laneLoads.get(candidate.id) ?? 0) < candidate.maxConcurrentRunners);
	let communicationOverflow = false;
	if (!lane && requestedPurpose === 'communication') {
		lane = lanes.find((candidate) => candidate.purpose === 'operation' && Number(laneLoads.get(candidate.id) ?? 0) < candidate.maxConcurrentRunners);
		communicationOverflow = Boolean(lane);
	}
	return { requestedPurpose, lane, communicationOverflow };
}
