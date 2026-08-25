import type { ProviderSynthesisExecutionProvider } from '../../providers/provider-synthesis-context-service.ts';

export function selectAssignmentLane(
	executionKind: 'workday' | 'conversation' | 'simulation' | 'recovery',
	lanes: ProviderSynthesisExecutionProvider['lanes'],
	laneLoads: ReadonlyMap<string, number>,
	requestedLanePurpose?: 'communication' | 'platform' | 'workday',
) {
	const requestedPurpose = requestedLanePurpose ?? (executionKind === 'conversation' ? 'communication' as const : 'workday' as const);
	let lane = lanes.find((candidate) => candidate.purpose === requestedPurpose && Number(laneLoads.get(candidate.id) ?? 0) < candidate.maxConcurrentRunners);
	return { requestedPurpose, lane, communicationOverflow: false };
}
