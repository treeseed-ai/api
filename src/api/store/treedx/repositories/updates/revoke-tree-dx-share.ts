import { isoNow,ControlPlaneStore,serializeTreeDxShare } from '../../../../persistence/store.ts';

export async function revokeTreeDxShareMethod(this: ControlPlaneStore, teamId: string, shareId: string) {
	await this.ensureInitialized();
	const timestamp=isoNow();
	await this.run(`UPDATE treedx_shares SET status = 'revoked', revoked_at = ?, updated_at = ?
		WHERE id = ? AND team_id = ? AND status = 'active'`,[timestamp,timestamp,shareId,teamId]);
	return serializeTreeDxShare(await this.first('SELECT * FROM treedx_shares WHERE id = ? AND team_id = ? LIMIT 1',[shareId,teamId]));
}
