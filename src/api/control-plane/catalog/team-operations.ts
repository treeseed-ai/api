import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { ControlPlaneOperationError, type BoundOperation } from './operation-registry.ts';

export interface TeamOperationDependencies {
	store: {
		listTeamsForPrincipal(principal: Record<string, unknown>): Promise<Array<Record<string, unknown>>>;
		loadTeamProfileByName(name: string, principal: Record<string, unknown>): Promise<Record<string, unknown> | null>;
	};
}

export function createTeamsListOperation(
	dependencies: TeamOperationDependencies,
): BoundOperation<typeof CONTROL_PLANE_OPERATIONS.teams.list> {
	return {
		binding: CONTROL_PLANE_OPERATIONS.teams.list,
		async handler(_input, context) {
			if (!context.principal) throw new ControlPlaneOperationError(401, 'authentication_required', 'Authentication is required.');
			return { teams: await dependencies.store.listTeamsForPrincipal(context.principal) };
		},
	};
}

export function createTeamProfileOperation(
	dependencies: TeamOperationDependencies,
): BoundOperation<typeof CONTROL_PLANE_OPERATIONS.teams.profile> {
	return {
		binding: CONTROL_PLANE_OPERATIONS.teams.profile,
		async handler(input, context) {
			if (!context.principal) throw new ControlPlaneOperationError(401, 'authentication_required', 'Authentication is required.');
			const profile = await dependencies.store.loadTeamProfileByName(input.path.name, context.principal);
			if (!profile) throw new ControlPlaneOperationError(404, 'team_profile_not_found', 'The team profile was not found.');
			return profile;
		},
	};
}
