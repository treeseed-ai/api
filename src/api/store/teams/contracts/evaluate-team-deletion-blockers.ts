import { ControlPlaneStore,parseJson } from "../../../persistence/store.ts";
export async function evaluateTeamDeletionBlockersMethod(this: ControlPlaneStore, teamId) {
    await this.ensureInitialized();
    const [
        projectRows,
        jobs,
        services,
        workdays,
        assignments,
        reservations,
        pendingInvites,
    ] = await Promise.all([
        this.all(`SELECT id, slug, name, metadata_json FROM projects WHERE team_id = ? ORDER BY created_at ASC LIMIT 20`, [teamId]),
        this.all(`SELECT remote_jobs.id, remote_jobs.operation, remote_jobs.status, projects.slug AS project_slug, projects.name AS project_name
				 FROM remote_jobs
				 INNER JOIN projects ON projects.id = remote_jobs.project_id
				 WHERE projects.team_id = ? AND remote_jobs.status IN ('pending', 'claimed', 'running', 'waiting_for_approval')
				 ORDER BY remote_jobs.created_at ASC LIMIT 20`, [teamId]),
        this.all(`SELECT id, display_name, status FROM team_service_connections
                 WHERE team_id = ? ORDER BY created_at ASC LIMIT 20`, [teamId]),
        this.all(`SELECT id, scenario_id, status FROM capacity_workday_runs
                 WHERE team_id = ? AND status NOT IN ('completed', 'cancelled', 'failed', 'degraded')
                 ORDER BY created_at ASC LIMIT 20`, [teamId]),
        this.all(`SELECT id, project_id, status FROM capacity_provider_assignments
                 WHERE team_id = ? AND status IN ('pending', 'leased', 'running', 'returned')
                 ORDER BY created_at ASC LIMIT 20`, [teamId]),
        this.all(`SELECT id, project_id, state FROM capacity_reservations
                 WHERE team_id = ? AND state IN ('reserved', 'consuming', 'overran_pending_approval', 'continuation_required')
                 ORDER BY created_at ASC LIMIT 20`, [teamId]),
        this.all(`SELECT id, email, status FROM team_invites
                 WHERE team_id = ? AND status = 'pending' ORDER BY created_at ASC LIMIT 20`, [teamId]),
    ]);
    const deletedProjectIds = new Set(projectRows
        .filter((row) => parseJson(row.metadata_json, {})?.deletion?.status === 'succeeded')
        .map((row) => row.id));
    const projects = projectRows.filter((row) => !deletedProjectIds.has(row.id));
    return [
        ...projects.map((row) => ({ code: 'project', id: row.id, label: row.name, href: `/app/projects/${row.id}/settings` })),
        ...services.map((row) => ({ code: 'service_connection', id: row.id, label: row.display_name, href: '/app/services' })),
        ...workdays.map((row) => ({ code: 'active_workday', id: row.id, label: row.scenario_id ?? row.id, href: '/app/work/workdays' })),
        ...assignments.map((row) => ({ code: 'active_assignment', id: row.id, label: `${row.project_id}: ${row.status}`, href: '/app/capacity/assignments' })),
        ...reservations.map((row) => ({ code: 'capacity_reservation', id: row.id, label: `${row.project_id}: ${row.state}`, href: '/app/capacity/usage' })),
        ...jobs.map((row) => ({ code: 'active_job', id: row.id, label: `${row.project_name}: ${row.operation}`, href: '/app/work/objectives' })),
        ...pendingInvites.map((row) => ({ code: 'pending_invitation', id: row.id, label: row.email, href: `/app/teams/${teamId}/members` })),
    ];
}
