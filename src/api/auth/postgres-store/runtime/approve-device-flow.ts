import type { DeviceCodeApproveRequest } from "../../../types.ts";
import { PostgresAuthStore,DeviceCodeRow,isoNow } from "../../postgres-store.ts";
export async function approveDeviceFlowMethod(this: PostgresAuthStore, request: DeviceCodeApproveRequest): Promise<{
    ok: true;
}> {
    await this.ensureInitialized();
    const row = await this.first<DeviceCodeRow>(`SELECT * FROM device_codes WHERE user_code = ?`, [request.userCode]);
    if (!row || new Date(row.expires_at).getTime() <= Date.now()) {
        throw new Error('Device code approval failed because the user code is unknown or expired.');
    }
    let userId = request.principalId;
    if (!(await this.loadUser(userId))) {
        const createdAt = isoNow();
        await this.run(`INSERT INTO users (id, email, display_name, status, metadata_json, created_at, updated_at)
				 VALUES (?, NULL, ?, 'active', ?, ?, ?)`, [userId, request.displayName ?? null, JSON.stringify(request.metadata ?? {}), createdAt, createdAt]);
        await this.assignRole(userId, 'member');
    }
    await this.run(`UPDATE device_codes SET status = 'approved', user_id = ?, updated_at = ? WHERE id = ?`, [userId, isoNow(), row.id]);
    await this.writeAuditEvent({
        actorType: 'user',
        actorId: userId,
        eventType: 'auth.device_approved',
        targetType: 'device_code',
        targetId: row.id,
    });
    return { ok: true };
}

