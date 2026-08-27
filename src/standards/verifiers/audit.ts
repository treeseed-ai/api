import pg from 'pg';

const REQUIRED_USER_EVENTS = [
	'auth.user.registered', 'auth.email.verified', 'auth.session_issued', 'auth.session.revoked',
	'auth.password.reset', 'account.preferences.updated', 'account.deleted',
];
const REQUIRED_TEAM_EVENTS = [
	'team.created', 'team.updated', 'team.invitation.created', 'team.invitation.accepted',
	'team.member.role_changed', 'team.archived', 'team.restored', 'team.member.removed', 'team.deleted',
];

export async function verifyAuditEvidence(userId: string, teamId: string) {
	const connectionString = process.env.TREESEED_DATABASE_URL;
	if (!connectionString) throw new Error('API verifier requires its component-owned database connection.');
	const pool = new pg.Pool({ connectionString, max: 1 });
	try {
		const result = await pool.query<{ event_type: string }>(`SELECT event_type FROM audit_events
			WHERE (target_type = 'user' AND target_id = $1)
			   OR (target_type = 'team' AND target_id = $2)
			   OR actor_id = $1`, [userId, teamId]);
		const observed = new Set(result.rows.map((row) => row.event_type));
		const missing = [...REQUIRED_USER_EVENTS, ...REQUIRED_TEAM_EVENTS].filter((event) => !observed.has(event));
		if (missing.length) throw new Error(`Durable audit evidence omitted: ${missing.join(', ')}.`);
	} finally {
		await pool.end();
	}
}
