import { redactSensitiveValue } from "../../../../../security/redact-sensitive-value.ts";
import { isoNow,MarketControlPlaneStore,objectValue,serializeTreeDxDeployment } from "../../../../persistence/store.ts";
export async function updateTreeDxDeploymentMethod(this: MarketControlPlaneStore, deploymentId, patch: any = {}) {
    await this.ensureInitialized();
    const existing = serializeTreeDxDeployment(await this.first(`SELECT * FROM treedx_deployments WHERE id = ? LIMIT 1`, [deploymentId]));
    if (!existing)
        return null;
    const timestamp = isoNow();
    const status = patch.status ?? existing.status;
    const terminal = ['succeeded', 'failed', 'cancelled', 'timed_out'].includes(status);
    await this.run(`UPDATE treedx_deployments
			 SET status = ?,
			     image_ref = ?,
			     volume_mount_path = ?,
			     service_refs_json = ?,
			     result_json = ?,
			     error_json = ?,
			     updated_at = ?,
			     completed_at = ?
			 WHERE id = ?`, [
        status,
        patch.imageRef ?? existing.imageRef,
        patch.volumeMountPath ?? existing.volumeMountPath,
        JSON.stringify({
            ...(existing.serviceRefs ?? {}),
            ...(objectValue(patch.serviceRefs, {}) ?? {}),
        }),
        JSON.stringify({
            ...(existing.result ?? {}),
            ...(objectValue(patch.result, {}) ?? {}),
        }),
        patch.error ? JSON.stringify(redactSensitiveValue(patch.error)) : (patch.clearError ? null : JSON.stringify(existing.error ?? {})),
        timestamp,
        terminal ? patch.completedAt ?? timestamp : patch.completedAt ?? existing.completedAt ?? null,
        deploymentId,
    ]);
    return serializeTreeDxDeployment(await this.first(`SELECT * FROM treedx_deployments WHERE id = ? LIMIT 1`, [deploymentId]));
}
