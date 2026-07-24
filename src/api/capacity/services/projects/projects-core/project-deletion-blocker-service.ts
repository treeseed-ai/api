type Row = Record<string, unknown>;

interface DeletionBlockerStore {
	getProject(projectId: string): Promise<Row | null>;
	all(sql: string, values?: unknown[]): Promise<Row[]>;
}

export async function listProjectDeletionBlockers(store: DeletionBlockerStore, projectId: string) {
	const project = await store.getProject(projectId);
	if (!project) return [{ code: 'missing', id: projectId, label: 'Project not found.' }];
	const [jobs, workdays, reservations, approvals] = await Promise.all([
		store.all(
			`SELECT id, namespace, operation, status FROM remote_jobs
			 WHERE project_id = ? AND status IN ('pending', 'claimed', 'running', 'waiting_for_approval')
			 ORDER BY created_at ASC LIMIT 20`,
			[projectId],
		),
		store.all(
			`SELECT id, status, started_at FROM workday_capacity_envelopes
			 WHERE project_id = ? AND status IN ('draft', 'queued', 'active', 'paused')
			 ORDER BY updated_at DESC LIMIT 20`,
			[projectId],
		),
		store.all(
			`SELECT id, state, reserved_credits, consumed_credits FROM capacity_reservations
			 WHERE project_id = ? AND state IN ('reserved', 'consuming', 'overran_pending_approval')
			 ORDER BY created_at DESC LIMIT 20`,
			[projectId],
		),
		store.all(
			`SELECT id, kind, state, title FROM approval_requests
			 WHERE project_id = ? AND state = 'pending'
			 ORDER BY created_at DESC LIMIT 20`,
			[projectId],
		),
	]);
	return [
		...jobs.map((row) => ({ code: 'active_job', id: row.id, label: `${row.namespace}:${row.operation} ${row.status}`, href: '/app/work/objectives' })),
		...workdays.map((row) => ({ code: 'active_workday', id: row.id, label: `Workday ${row.id} ${row.status}`, href: `/app/work/objectives#work-${row.id}` })),
		...reservations.map((row) => ({ code: 'capacity_reservation', id: row.id, label: `${row.state} ${row.reserved_credits ?? 0} credits`, href: '/app/capacity' })),
		...approvals.map((row) => ({ code: 'pending_approval', id: row.id, label: row.title ?? row.kind, href: `/app/work/decisions#approval-${row.id}` })),
	];
}
