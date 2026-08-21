import {
	TREESEED_COMMAND_TREE_V1,
	listCommandPaths,
	type CommandNodeDescriptor,
	validateCommandTree,
} from '@treeseed/sdk/operator-contracts';

export type ApiCommandAccess = 'team-read' | 'team-manage';

export interface ApiCommandAuthorityBinding {
	commandPath: string;
	access: ApiCommandAccess;
	apiRouteIds: readonly string[];
}

function commandKinds(nodes: CommandNodeDescriptor[], parent: string[] = [], output = new Map<string, 'read' | 'mutation'>()) {
	for (const node of nodes) {
		const path = [...parent, node.segment];
		if (node.nodeType === 'leaf') output.set(path.join(' '), node.kind);
		else commandKinds(node.children, path, output);
	}
	return output;
}

const kinds = commandKinds(TREESEED_COMMAND_TREE_V1.commands);

/**
 * API-owned authorization projection for the canonical operator tree.
 *
 * The SDK defines portable command semantics. The API, rather than a client
 * capability matrix, owns which HTTP resources implement those semantics and
 * which permission class governs them.
 */
export const API_COMMAND_AUTHORITY = [
	...listCommandPaths(TREESEED_COMMAND_TREE_V1)
		.filter((commandPath) => !commandPath.startsWith('auth ') && !commandPath.startsWith('secrets '))
		.map((commandPath) => ({
			commandPath,
			access: kinds.get(commandPath) === 'mutation' || commandPath === 'workdays plan' ? 'team-manage' as const : 'team-read' as const,
			apiRouteIds: [kinds.get(commandPath) === 'mutation' || commandPath === 'workdays plan' ? 'post.v1.operator.commands.mutations' : 'post.v1.operator.commands.read'],
		})),
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
