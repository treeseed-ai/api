import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { ControlPlaneOperationError, type BoundOperation } from './operation-registry.ts';

export interface ProjectOperationDependencies {
	capacity: {
		evaluateProjectDeletionBlockers(projectId: string): Promise<Array<Record<string, unknown>>>;
	};
	store: {
		listProjectsForPrincipal(principal: Record<string, unknown>): Promise<Array<Record<string, any>>>;
		listTeamProjects(teamId: string): Promise<Array<Record<string, any>>>;
		principalCanAccessTeam(principal: Record<string, unknown>, teamId: string): Promise<boolean>;
		getProjectDetails(projectId: string): Promise<Record<string, any> | null>;
		getProjectByTeamAndSlug(teamId: string, slug: string): Promise<Record<string, any> | null>;
		getProjectAccessSummary(projectId: string, principal: Record<string, unknown>): Promise<Record<string, unknown>>;
		getProjectSummary(projectId: string, principal: Record<string, unknown>): Promise<Record<string, unknown>>;
		principalCanManageTeam(principal: Record<string, unknown>, teamId: string): Promise<boolean>;
		createProject(teamId: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
		updateProject(projectId: string, input: Record<string, unknown>): Promise<Record<string, any> | null>;
		run(query: string, parameters?: unknown[]): Promise<unknown>;
		recordAuditEvent(event: Record<string, unknown>): Promise<unknown>;
	};
}

function visibleProjects(projects: Array<Record<string, any>>) {
	return projects.filter((project) => project.metadata?.inventory?.status !== 'archived');
}

async function projectAccess(dependencies: ProjectOperationDependencies, projectId: string, context: { principal?: Record<string, any> }) {
	const principal = context.principal;
	if (!principal) throw new ControlPlaneOperationError(401, 'authentication_required', 'Authentication is required.');
	const details = await dependencies.store.getProjectDetails(projectId);
	if (!details?.project) throw new ControlPlaneOperationError(404, 'project_not_found', 'The project was not found.');
	const administrator = principal.roles?.some((role: string) => role === 'admin' || role === 'platform_admin')
		|| principal.permissions?.includes('*:*:*');
	if (!administrator && !await dependencies.store.principalCanAccessTeam(principal, details.project.teamId)) {
		throw new ControlPlaneOperationError(403, 'project_access_denied', 'The principal cannot access this project.');
	}
	if (principal.roles?.includes('team_api_key')
		&& !principal.permissions?.some((permission: string) => permission === '*:*:*' || permission === 'projects:read:team')) {
		throw new ControlPlaneOperationError(403, 'project_permission_denied', 'The credential cannot read this project.');
	}
	return { principal, details };
}

async function teamManageAccess(dependencies: ProjectOperationDependencies, teamId: string, context: { principal?: Record<string, any> }) {
	const principal = context.principal;
	if (!principal) throw new ControlPlaneOperationError(401, 'authentication_required', 'Authentication is required.');
	const administrator = principal.roles?.some((role: string) => role === 'admin' || role === 'platform_admin')
		|| principal.permissions?.includes('*:*:*');
	if (!administrator && !await dependencies.store.principalCanAccessTeam(principal, teamId)) {
		throw new ControlPlaneOperationError(403, 'team_access_denied', 'The principal cannot access this team.');
	}
	if (principal.roles?.includes('team_api_key')) {
		if (!principal.permissions?.some((permission: string) => permission === '*:*:*' || permission === 'projects:manage:team')) {
			throw new ControlPlaneOperationError(403, 'team_permission_denied', 'The credential cannot manage projects.');
		}
	} else if (!administrator && !await dependencies.store.principalCanManageTeam(principal, teamId)) {
		throw new ControlPlaneOperationError(403, 'team_management_denied', 'The principal cannot manage this team.');
	}
	return principal;
}

async function projectManageAccess(dependencies: ProjectOperationDependencies, projectId: string, context: { principal?: Record<string, any> }) {
	const access = await projectAccess(dependencies, projectId, context);
	await teamManageAccess(dependencies, access.details.project.teamId, context);
	return access;
}

export function createProjectShowOperation(dependencies: ProjectOperationDependencies): BoundOperation<typeof CONTROL_PLANE_OPERATIONS.projects.show> {
	return {
		binding: CONTROL_PLANE_OPERATIONS.projects.show,
		async handler(input, context) {
			return (await projectAccess(dependencies, input.path.projectId, context)).details;
		},
	};
}

export function createProjectAccessOperation(dependencies: ProjectOperationDependencies): BoundOperation<typeof CONTROL_PLANE_OPERATIONS.projects.access> {
	return {
		binding: CONTROL_PLANE_OPERATIONS.projects.access,
		async handler(input, context) {
			const access = await projectAccess(dependencies, input.path.projectId, context);
			return dependencies.store.getProjectAccessSummary(input.path.projectId, access.principal);
		},
	};
}

export function createProjectSummaryOperation(dependencies: ProjectOperationDependencies): BoundOperation<typeof CONTROL_PLANE_OPERATIONS.projects.summary> {
	return {
		binding: CONTROL_PLANE_OPERATIONS.projects.summary,
		async handler(input, context) {
			const access = await projectAccess(dependencies, input.path.projectId, context);
			return dependencies.store.getProjectSummary(input.path.projectId, access.principal);
		},
	};
}

export function createProjectCreateOperation(dependencies: ProjectOperationDependencies): BoundOperation<typeof CONTROL_PLANE_OPERATIONS.projects.create> {
	return {
		binding: CONTROL_PLANE_OPERATIONS.projects.create,
		async handler(input, context) {
			await teamManageAccess(dependencies, input.path.teamId, context);
			const body = input.body as Record<string, unknown>;
			const slug = String(body.slug ?? '').trim();
			const name = String(body.name ?? '').trim();
			if (!slug || !name) throw new ControlPlaneOperationError(400, 'project_input_invalid', 'Project slug and name are required.');
			try {
				return await dependencies.store.createProject(input.path.teamId, {
					...(typeof body.id === 'string' ? { id: body.id } : {}), slug, name,
					description: typeof body.description === 'string' ? body.description : null,
					metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : {},
					entitlementTier: typeof body.entitlementTier === 'string' ? body.entitlementTier : 'free',
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : 'The project could not be created.';
				throw new ControlPlaneOperationError(/already in use/u.test(message) ? 409 : 400, /already in use/u.test(message) ? 'project_slug_taken' : 'project_input_invalid', message);
			}
		},
	};
}

function projectSlug(value: unknown) {
	const slug = String(value ?? '').trim().toLowerCase();
	if (!slug || slug.length > 80 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(slug)) {
		throw new ControlPlaneOperationError(400, 'project_slug_invalid', 'Project slugs use 1-80 lowercase letters, numbers, or single hyphens.');
	}
	return slug;
}

export function createProjectUpdateOperation(dependencies: ProjectOperationDependencies): BoundOperation<typeof CONTROL_PLANE_OPERATIONS.projects.update> {
	return {
		binding: CONTROL_PLANE_OPERATIONS.projects.update,
		async handler(input, context) {
			const access = await projectManageAccess(dependencies, input.path.projectId, context);
			const currentRevision = String(access.details.project.updatedAt ?? '');
			if (currentRevision !== context.ifMatch) throw new ControlPlaneOperationError(412, 'project_revision_changed', 'The project changed since it was read.');
			const body = input.body as Record<string, unknown>;
			const slug = body.slug === undefined ? access.details.project.slug : projectSlug(body.slug);
			const name = body.name === undefined ? access.details.project.name : String(body.name).trim();
			if (!name) throw new ControlPlaneOperationError(400, 'project_name_required', 'Project name is required.');
			const duplicate = slug === access.details.project.slug ? null : await dependencies.store.getProjectByTeamAndSlug(access.details.project.teamId, slug);
			if (duplicate && duplicate.id !== input.path.projectId) throw new ControlPlaneOperationError(409, 'project_slug_taken', 'That project slug is already in use for this team.');
			const metadata = body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata) ? body.metadata as Record<string, unknown> : access.details.project.metadata ?? {};
			if ('coreObjective' in body || 'coreObjective' in metadata) throw new ControlPlaneOperationError(409, 'treedx_changeset_required', 'Core objective content must be updated through an atomic TreeDX changeset.');
			const updated = await dependencies.store.updateProject(input.path.projectId, { slug, name,
				description: typeof body.description === 'string' ? body.description.trim() || null : access.details.project.description ?? null,
				metadata, expectedRevision: context.ifMatch });
			if (!updated) throw new ControlPlaneOperationError(412, 'project_revision_changed', 'The project changed while it was being updated.');
			await dependencies.store.recordAuditEvent({ actorType: 'user', actorId: access.principal.id, eventType: 'project.updated', targetType: 'project', targetId: input.path.projectId });
			return updated;
		},
	};
}

function projectInventoryOperation(
	binding: typeof CONTROL_PLANE_OPERATIONS.projects.archive | typeof CONTROL_PLANE_OPERATIONS.projects.restore,
	status: 'active' | 'archived',
): (dependencies: ProjectOperationDependencies) => BoundOperation<any> {
	return (dependencies) => ({
		binding,
		async handler(input, context) {
			const access = await projectManageAccess(dependencies, input.path.projectId, context);
			if (status === 'archived') {
				const blockers = await dependencies.capacity.evaluateProjectDeletionBlockers(input.path.projectId);
				if (blockers.length) throw new ControlPlaneOperationError(409, 'project_blocked', 'The project still has active work and cannot be archived.');
			}
			const now = new Date().toISOString();
			const updated = await dependencies.store.updateProject(input.path.projectId, {
				metadata: { ...access.details.project.metadata, inventory: status === 'archived'
					? { status, archivedAt: now, archivedBy: access.principal.id }
					: { status, restoredAt: now, restoredBy: access.principal.id } },
				expectedRevision: context.ifMatch,
			});
			if (!updated) throw new ControlPlaneOperationError(412, 'project_revision_changed', 'The project changed while its lifecycle state was being updated.');
			await dependencies.store.recordAuditEvent({ actorType: 'user', actorId: access.principal.id,
				eventType: `project.${status === 'archived' ? 'archived' : 'restored'}`, targetType: 'project', targetId: input.path.projectId });
			return updated;
		},
	});
}

export const createProjectArchiveOperation = projectInventoryOperation(CONTROL_PLANE_OPERATIONS.projects.archive, 'archived');
export const createProjectRestoreOperation = projectInventoryOperation(CONTROL_PLANE_OPERATIONS.projects.restore, 'active');

export function createProjectDeletionBlockersOperation(dependencies: ProjectOperationDependencies): BoundOperation<typeof CONTROL_PLANE_OPERATIONS.projects.deletionBlockers> {
	return {
		binding: CONTROL_PLANE_OPERATIONS.projects.deletionBlockers,
		async handler(input, context) {
			await projectManageAccess(dependencies, input.path.projectId, context);
			return { blockers: await dependencies.capacity.evaluateProjectDeletionBlockers(input.path.projectId) };
		},
	};
}

export function createProjectDeleteOperation(dependencies: ProjectOperationDependencies): BoundOperation<typeof CONTROL_PLANE_OPERATIONS.projects.remove> {
	return {
		binding: CONTROL_PLANE_OPERATIONS.projects.remove,
		async handler(input, context) {
			const access = await projectManageAccess(dependencies, input.path.projectId, context);
			const expected = `DELETE ${access.details.project.slug}`;
			if ((input.body as Record<string, unknown>).confirmation !== expected) {
				throw new ControlPlaneOperationError(400, 'confirmation_invalid', `Type ${expected} to confirm.`);
			}
			const blockers = await dependencies.capacity.evaluateProjectDeletionBlockers(input.path.projectId);
			if (blockers.length) throw new ControlPlaneOperationError(409, 'project_blocked', 'The project still has active work and cannot be deleted.');
			await dependencies.store.run('DELETE FROM projects WHERE id = ?', [input.path.projectId]);
			await dependencies.store.recordAuditEvent({ actorType: 'user', actorId: access.principal.id,
				eventType: 'project.deleted', targetType: 'project', targetId: input.path.projectId });
			return { id: input.path.projectId, deleted: true };
		},
	};
}

export function createProjectsListOperation(dependencies: ProjectOperationDependencies): BoundOperation<typeof CONTROL_PLANE_OPERATIONS.projects.list> {
	return {
		binding: CONTROL_PLANE_OPERATIONS.projects.list,
		async handler(input, context) {
			const principal = context.principal;
			if (!principal) throw new ControlPlaneOperationError(401, 'authentication_required', 'Authentication is required.');
			if (!input.query.teamId) return { projects: visibleProjects(await dependencies.store.listProjectsForPrincipal(principal)) };
			const administrator = principal.roles?.some((role) => role === 'admin' || role === 'platform_admin')
				|| principal.permissions?.includes('*:*:*');
			if (!administrator && !await dependencies.store.principalCanAccessTeam(principal, input.query.teamId)) {
				throw new ControlPlaneOperationError(403, 'team_access_denied', 'The principal cannot access this team.');
			}
			if (principal.roles?.includes('team_api_key')
				&& !principal.permissions?.some((permission) => permission === '*:*:*' || permission === 'projects:read:team')) {
				throw new ControlPlaneOperationError(403, 'team_permission_denied', 'The credential cannot read team projects.');
			}
			return { projects: visibleProjects(await dependencies.store.listTeamProjects(input.query.teamId)) };
		},
	};
}
