import type { ControlPlaneStore } from '../../../persistence/store.ts';

export async function deleteHubRepositoryByRoleMethod(this: ControlPlaneStore, hubId: string, role: string) {
	await this.ensureInitialized();
	const result = await this.run('DELETE FROM hub_repositories WHERE hub_id = ? AND role = ?', [hubId, role]);
	return Number((result as { changes?: number }).changes ?? 0);
}
