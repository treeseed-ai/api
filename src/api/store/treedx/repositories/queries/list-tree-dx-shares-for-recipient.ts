import { ControlPlaneStore,serializeTreeDxShare } from '../../../../persistence/store.ts';

export async function listTreeDxSharesForRecipientMethod(this: ControlPlaneStore, targetTeamId: string) {
	await this.ensureInitialized();
	const now=new Date().toISOString();
	const rows=await this.all(`SELECT * FROM treedx_shares WHERE target_team_id = ? AND status = 'active'
		AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at ASC`,[targetTeamId,now]);
	return rows.map(serializeTreeDxShare).filter(Boolean);
}
