import { CONTROL_PLANE_OPERATION_SCHEMA_VERSION } from '@treeseed/sdk/operator-contracts';
import { z } from 'zod';
import { ControlPlaneOperationError, type BoundOperation } from './operation-registry.ts';

const projectRecord = z.record(z.string(), z.unknown());
const projectsListInput = z.object({ teamId: z.string().min(1).optional() }).strict();
const projectsListOutput = z.object({ projects: z.array(projectRecord) });

export interface ProjectOperationDependencies {
	store: {
		listProjectsForPrincipal(principal: Record<string, unknown>): Promise<Array<Record<string, any>>>;
		listTeamProjects(teamId: string): Promise<Array<Record<string, any>>>;
		principalCanAccessTeam(principal: Record<string, unknown>, teamId: string): Promise<boolean>;
	};
}

function visibleProjects(projects: Array<Record<string, any>>) {
	return projects.filter((project) => project.metadata?.inventory?.status !== 'archived');
}

export function createProjectsListOperation(dependencies: ProjectOperationDependencies): BoundOperation<z.infer<typeof projectsListInput>, z.infer<typeof projectsListOutput>> {
	return {
		descriptor: {
			schemaVersion: CONTROL_PLANE_OPERATION_SCHEMA_VERSION,
			operationId: 'projects.list',
			description: 'List projects visible to the authenticated principal, optionally within one team.',
			rest: { method: 'GET', path: '/v1/projects' },
			schemas: { input: 'treeseed.projects.list.input/v1', output: 'treeseed.projects.list.output/v1', errors: 'treeseed.problem/v1' },
			capability: 'projects.read', oauthScopes: ['treeseed:read'], kind: 'read', riskClass: 'ordinary', confirmation: 'never',
			idempotency: { required: false, header: 'Idempotency-Key' },
			concurrency: { required: false, readHeader: 'ETag', writeHeader: 'If-Match' },
			surfaces: ['rest', 'cli', 'mcp_tool'], cacheScope: 'principal', pagination: 'cursor', audited: true, receipt: false, redactedPaths: [],
		},
		inputSchema: projectsListInput,
		outputSchema: projectsListOutput,
		async handler(input, context) {
			const principal = context.principal;
			if (!principal) throw new ControlPlaneOperationError(401, 'authentication_required', 'Authentication is required.');
			if (!input.teamId) return { projects: visibleProjects(await dependencies.store.listProjectsForPrincipal(principal)) };
			const administrator = principal.roles?.some((role) => role === 'admin' || role === 'platform_admin')
				|| principal.permissions?.includes('*:*:*');
			if (!administrator && !await dependencies.store.principalCanAccessTeam(principal, input.teamId)) {
				throw new ControlPlaneOperationError(403, 'team_access_denied', 'The principal cannot access this team.');
			}
			if (principal.roles?.includes('team_api_key')
				&& !principal.permissions?.some((permission) => permission === '*:*:*' || permission === 'projects:read:team')) {
				throw new ControlPlaneOperationError(403, 'team_permission_denied', 'The credential cannot read team projects.');
			}
			return { projects: visibleProjects(await dependencies.store.listTeamProjects(input.teamId)) };
		},
	};
}
