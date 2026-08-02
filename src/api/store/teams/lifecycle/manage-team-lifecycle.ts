import type { MarketControlPlaneStore } from '../../../persistence/store.ts';

const RESTORE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const ARCHIVE_BLOCKER_CODES = new Set([
	'active_job',
	'active_deployment',
	'active_workday',
	'active_assignment',
	'capacity_reservation',
	'commerce_obligation',
]);

export async function archiveTeamMethod(
	this: MarketControlPlaneStore,
	teamId: string,
	input: { actorId: string; lifecycleVersion: number; now?: Date },
) {
	await this.ensureInitialized();
	const blockers = await this.evaluateTeamDeletionBlockers(teamId);
	const activeBlockers = blockers.filter((blocker: { code?: string }) => ARCHIVE_BLOCKER_CODES.has(String(blocker.code)));
	if (activeBlockers.length > 0) return { ok: false, code: 'blocked', message: 'Resolve active team operations before archiving.', blockers: activeBlockers };
	const now = input.now ?? new Date();
	const archivedAt = now.toISOString();
	const restoreDeadlineAt = new Date(now.getTime() + RESTORE_WINDOW_MS).toISOString();
	await this.run(`UPDATE teams
		SET status = 'archived', archived_at = ?, archived_by_user_id = ?, restore_deadline_at = ?,
			lifecycle_version = lifecycle_version + 1, updated_at = ?
		WHERE id = ? AND status = 'active' AND lifecycle_version = ?`, [
		archivedAt,
		input.actorId,
		restoreDeadlineAt,
		archivedAt,
		teamId,
		input.lifecycleVersion,
	]);
	const updated = await this.getTeam(teamId);
	if (updated?.status !== 'archived' || updated.lifecycleVersion !== input.lifecycleVersion + 1) {
		return { ok: false, code: 'stale', message: 'The team changed. Reload and try again.' };
	}
	await this.run(`UPDATE team_invites SET status = 'revoked', updated_at = ? WHERE team_id = ? AND status = 'pending'`, [archivedAt, teamId]);
	return { ok: true, team: await this.getTeam(teamId) };
}

export async function restoreTeamMethod(
	this: MarketControlPlaneStore,
	teamId: string,
	input: { lifecycleVersion: number; now?: Date },
) {
	await this.ensureInitialized();
	const now = (input.now ?? new Date()).toISOString();
	await this.run(`UPDATE teams
		SET status = 'active', archived_at = NULL, archived_by_user_id = NULL, restore_deadline_at = NULL,
			lifecycle_version = lifecycle_version + 1, updated_at = ?
		WHERE id = ? AND status = 'archived' AND lifecycle_version = ? AND restore_deadline_at > ?`, [
		now,
		teamId,
		input.lifecycleVersion,
		now,
	]);
	const updated = await this.getTeam(teamId);
	if (updated?.status !== 'active' || updated.lifecycleVersion !== input.lifecycleVersion + 1) {
		return { ok: false, code: 'stale_or_expired', message: 'The team cannot be restored in its current state.' };
	}
	return { ok: true, team: await this.getTeam(teamId) };
}

export async function getTeamDeletionReadinessMethod(this: MarketControlPlaneStore, teamId: string) {
	await this.ensureInitialized();
	const team = await this.getTeam(teamId);
	if (!team) return { ok: false, code: 'missing', message: 'Team not found.' };
	const blockers = await this.evaluateTeamDeletionBlockers(teamId);
	const archiveBlockers = blockers.filter((blocker: { code?: string }) => ARCHIVE_BLOCKER_CODES.has(String(blocker.code)));
	return {
		ok: true,
		ready: blockers.length === 0,
		team,
		blockers,
		archiveBlockers,
	};
}
