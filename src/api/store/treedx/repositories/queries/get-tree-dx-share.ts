import { ControlPlaneStore,serializeTreeDxShare } from '../../../../persistence/store.ts';

export async function getTreeDxShareMethod(this: ControlPlaneStore, shareId: string) {
	await this.ensureInitialized();
	return serializeTreeDxShare(await this.first('SELECT * FROM treedx_shares WHERE id = ? LIMIT 1', [shareId]));
}
