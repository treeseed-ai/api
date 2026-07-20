import type { CapacityAllocationSetV2 } from '@treeseed/sdk/agent-capacity/allocation';
import { CapacityGovernanceError } from '../database.ts';

function exactlyOne(
	allocation: CapacityAllocationSetV2,
	scope: CapacityAllocationSetV2['slices'][number]['scope'],
	targetId: string,
	parentSliceId: string | null,
) {
	const matches = allocation.slices.filter((slice) => slice.scope === scope
		&& slice.targetId === targetId
		&& (slice.parentSliceId ?? null) === parentSliceId);
	if (matches.length > 1) {
		throw new CapacityGovernanceError('capacity_allocation_path_ambiguous', `Allocation ${allocation.id} contains duplicate ${scope} slices for ${targetId}.`, 409, {
			allocationSetId: allocation.id, scope, targetId, parentSliceId,
		});
	}
	return matches[0] ?? null;
}

export function resolveCapacityAllocationPath(
	allocation: CapacityAllocationSetV2,
	request: { projectId: string; projectAgentClassId: string; mode: 'planning' | 'acting' },
): string[] {
	const project = exactlyOne(allocation, 'project', request.projectId, null);
	if (!project) {
		throw new CapacityGovernanceError('capacity_allocation_project_missing', 'Active allocation does not contain the requested project.', 409, {
			allocationSetId: allocation.id, projectId: request.projectId,
		});
	}
	const path = [project.id];
	const agentClass = exactlyOne(allocation, 'agent-class', request.projectAgentClassId, project.id);
	if (!agentClass) {
		if (allocation.slices.some((slice) => slice.scope === 'agent-class' && slice.parentSliceId === project.id)) {
			throw new CapacityGovernanceError('capacity_allocation_agent_class_missing', 'Active allocation does not contain the requested agent class under its project.', 409, {
				allocationSetId: allocation.id, projectId: request.projectId, projectAgentClassId: request.projectAgentClassId,
			});
		}
		return path;
	}
	path.push(agentClass.id);
	const mode = exactlyOne(allocation, 'mode', request.mode, agentClass.id);
	if (!mode && allocation.slices.some((slice) => slice.scope === 'mode' && slice.parentSliceId === agentClass.id)) {
		throw new CapacityGovernanceError('capacity_allocation_mode_missing', 'Active allocation does not contain the requested mode under its agent class.', 409, {
			allocationSetId: allocation.id, projectAgentClassId: request.projectAgentClassId, mode: request.mode,
		});
	}
	if (mode) path.push(mode.id);
	return path;
}
