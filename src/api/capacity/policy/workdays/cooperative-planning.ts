import type { AgentPlanningGraph } from './planning-graph.ts';

export const COOPERATIVE_PLANNING_STAGES = ['discovery', 'synthesis', 'deliberation', 'evaluation', 'revision', 'closeout'] as const;
export type CooperativePlanningStage = typeof COOPERATIVE_PLANNING_STAGES[number];

export interface PlanningParticipant {
	agentId: string;
	nodeId: string;
	projectAgentClassId: string;
	timeboxSeconds: number;
}

export interface PlanningWave {
	round: number;
	wave: number;
	stage: CooperativePlanningStage;
	participantNodeIds: string[];
	requestedSeconds: number;
}

export function expandSignalDependencyClosure(graph: AgentPlanningGraph, targetNodeIds: string[]): string[] {
	const selected = new Set(targetNodeIds);
	const queue = [...targetNodeIds];
	while (queue.length) {
		const target = queue.shift() as string;
		for (const edge of graph.edges.filter((entry) => entry.toNodeId === target)) {
			if (selected.has(edge.fromNodeId)) continue;
			selected.add(edge.fromNodeId);
			queue.push(edge.fromNodeId);
		}
	}
	return [...selected].sort();
}

function stageFor(nodeStage: string | null): CooperativePlanningStage {
	if (COOPERATIVE_PLANNING_STAGES.includes(nodeStage as CooperativePlanningStage)) return nodeStage as CooperativePlanningStage;
	return 'deliberation';
}

export function compileCooperativePlanningWaves(input: {
	graph: AgentPlanningGraph;
	participants: PlanningParticipant[];
	rounds: number;
	maxConcurrentAssignments: number;
	allocatedSeconds: number;
}): { waves: PlanningWave[]; requiredSeconds: number; fits: boolean } {
	const concurrency = Math.max(1, Math.floor(input.maxConcurrentAssignments));
	const rounds = Math.max(1, Math.floor(input.rounds));
	const byNode = new Map(input.participants.map((entry) => [entry.nodeId, entry]));
	const waves: PlanningWave[] = [];
	let requiredSeconds = 0;
	const roundFor = (stage: CooperativePlanningStage) => stage === 'discovery' || stage === 'synthesis' ? 1
		: stage === 'deliberation' || stage === 'evaluation' ? Math.min(2, rounds)
			: stage === 'revision' ? rounds : rounds + 1;
	for (let round = 1; round <= rounds + 1; round += 1) {
		const ordered = input.graph.nodes.filter((entry) => byNode.has(entry.id) && roundFor(stageFor(entry.stage)) === round).sort((left, right) => {
			const stage = COOPERATIVE_PLANNING_STAGES.indexOf(stageFor(left.stage)) - COOPERATIVE_PLANNING_STAGES.indexOf(stageFor(right.stage));
			return stage || left.id.localeCompare(right.id);
		});
		let waveIndex = 0;
		for (const stage of COOPERATIVE_PLANNING_STAGES) {
			const stageNodes = ordered.filter((entry) => stageFor(entry.stage) === stage);
			for (let cursor = 0; cursor < stageNodes.length; cursor += concurrency) {
				const cohort = stageNodes.slice(cursor, cursor + concurrency);
				const requestedSeconds = cohort.reduce((sum, entry) => sum + (byNode.get(entry.id)?.timeboxSeconds ?? 0), 0);
				requiredSeconds += requestedSeconds;
				waves.push({ round, wave: ++waveIndex, stage, participantNodeIds: cohort.map((entry) => entry.id), requestedSeconds });
			}
		}
	}
	return { waves, requiredSeconds, fits: requiredSeconds <= input.allocatedSeconds };
}
