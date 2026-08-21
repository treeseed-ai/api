import {
	TREESEED_COMMAND_TREE_V1,
	listCommandPaths,
	validateCommandTree,
} from '@treeseed/sdk/operator-contracts';

export type ApiCommandAccess = 'team-read' | 'team-manage';

export interface ApiCommandAuthorityBinding {
	commandPath: string;
	access: ApiCommandAccess;
	apiRouteIds: readonly string[];
}

/**
 * API-owned authorization projection for the canonical operator tree.
 *
 * The SDK defines portable command semantics. The API, rather than a client
 * capability matrix, owns which HTTP resources implement those semantics and
 * which permission class governs them.
 */
export const API_COMMAND_AUTHORITY = [
	{ commandPath: 'capacity status', access: 'team-read', apiRouteIds: ['get.v1.teams.teamId.capacity.usage'] },
	{ commandPath: 'capacity explain', access: 'team-read', apiRouteIds: ['get.v1.teams.teamId.capacity.ledger'] },
	{ commandPath: 'capacity usage', access: 'team-read', apiRouteIds: ['get.v1.teams.teamId.capacity.usage'] },
	{ commandPath: 'capacity ledger', access: 'team-read', apiRouteIds: ['get.v1.teams.teamId.capacity.ledger'] },
	{ commandPath: 'capacity audit', access: 'team-read', apiRouteIds: ['get.v1.teams.teamId.capacity-audit-events'] },
	{ commandPath: 'plans list', access: 'team-read', apiRouteIds: ['get.v1.decisions.decisionId.capacity-plans'] },
	{ commandPath: 'plans show', access: 'team-read', apiRouteIds: ['get.v1.capacity-plans.capacityPlanId'] },
	{ commandPath: 'workdays plan', access: 'team-manage', apiRouteIds: ['post.v1.teams.teamId.workday-runs.preflight'] },
	{ commandPath: 'workdays start', access: 'team-manage', apiRouteIds: ['post.v1.teams.teamId.workday-runs'] },
	{ commandPath: 'workdays list', access: 'team-read', apiRouteIds: ['get.v1.teams.teamId.workday-runs'] },
	{ commandPath: 'workdays show', access: 'team-read', apiRouteIds: ['get.v1.teams.teamId.workday-runs.runId'] },
	{ commandPath: 'workdays watch', access: 'team-read', apiRouteIds: ['get.v1.teams.teamId.workday-runs.runId.activity.stream'] },
	{ commandPath: 'assignments list', access: 'team-read', apiRouteIds: ['get.v1.teams.teamId.capacity.assignments'] },
	{ commandPath: 'assignments show', access: 'team-read', apiRouteIds: ['get.v1.teams.teamId.capacity.assignments.assignmentId'] },
	{ commandPath: 'assignments explain', access: 'team-read', apiRouteIds: ['get.v1.teams.teamId.capacity.assignments.assignmentId.explanation'] },
	{ commandPath: 'assignments retry', access: 'team-manage', apiRouteIds: ['post.v1.teams.teamId.capacity.assignments.assignmentId.requeue'] },
	{ commandPath: 'assignments cancel', access: 'team-manage', apiRouteIds: ['post.v1.teams.teamId.capacity.assignments.assignmentId.cancel'] },
] as const satisfies readonly ApiCommandAuthorityBinding[];

export function validateApiCommandAuthority(routeIds: ReadonlySet<string>): string[] {
	const diagnostics = validateCommandTree(TREESEED_COMMAND_TREE_V1).map((entry) => `${entry.code}:${entry.path}`);
	const commandPaths = new Set(listCommandPaths(TREESEED_COMMAND_TREE_V1));
	const seen = new Set<string>();
	for (const binding of API_COMMAND_AUTHORITY) {
		if (!commandPaths.has(binding.commandPath)) diagnostics.push(`unknown_command:${binding.commandPath}`);
		if (seen.has(binding.commandPath)) diagnostics.push(`duplicate_command:${binding.commandPath}`);
		seen.add(binding.commandPath);
		for (const routeId of binding.apiRouteIds) if (!routeIds.has(routeId)) diagnostics.push(`unknown_route:${binding.commandPath}:${routeId}`);
	}
	return diagnostics;
}
