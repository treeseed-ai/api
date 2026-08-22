import { randomUUID } from 'node:crypto';
import type { DeviceCodePollRequest,DeviceCodePollResponse } from "../../../types.ts";
import { addSeconds,PostgresAuthStore,DeviceCodeRow,isoNow,now,parseJson,stableHash } from "../../postgres-store.ts";
import { nextOpaqueToken } from "../../tokens.ts";
export async function pollDeviceFlowMethod(this: PostgresAuthStore, request: DeviceCodePollRequest): Promise<DeviceCodePollResponse> {
    await this.ensureInitialized();
    const row = await this.first<DeviceCodeRow>(`SELECT * FROM device_codes WHERE device_code_hash = ?`, [stableHash(request.deviceCode, this.config.authSecret)]);
    if (!row) {
        return { ok: false, status: 'invalid', error: 'Unknown device code.' };
    }
    if (new Date(row.expires_at).getTime() <= Date.now()) {
        return { ok: false, status: 'expired', error: 'Device code expired.' };
    }
    if (row.status === 'pending' || !row.user_id) {
        return { ok: true, status: 'pending', intervalSeconds: row.interval_seconds };
    }
    if (row.status === 'used') {
        return { ok: false, status: 'already_used', error: 'Device code already used.' };
    }
    const consumed = await this.first<{ id: string }>(`UPDATE device_codes SET status = 'used', updated_at = ? WHERE id = ? AND status = 'approved' RETURNING id`, [isoNow(), row.id]);
    if (!consumed) return { ok: false, status: 'already_used', error: 'Device code already used.' };
    const principalRecord = await this.principalForUser(row.user_id);
    const refreshToken = nextOpaqueToken('refresh');
    const accessToken = nextOpaqueToken('access');
    const sessionId = randomUUID();
    const refreshTokenHash = stableHash(refreshToken, this.config.authSecret);
    const accessTokenHash = stableHash(accessToken, this.config.authSecret);
    const expiresAt = addSeconds(now(), this.config.accessTokenTtlSeconds);
    const refreshExpiresAt = addSeconds(now(), this.config.refreshTokenTtlSeconds);
    await this.run(`INSERT INTO auth_sessions (id, user_id, session_type, access_token_hash, access_expires_at, refresh_token_hash, scopes_json, expires_at, revoked_at, data_json, created_at, updated_at)
			 VALUES (?, ?, 'device', ?, ?, ?, ?, ?, NULL, ?, ?, ?)`, [
        sessionId,
        row.user_id,
        accessTokenHash,
        expiresAt.toISOString(),
        refreshTokenHash,
        row.requested_scopes_json,
        refreshExpiresAt.toISOString(),
        JSON.stringify({ deviceCodeId: row.id, clientId: row.client_id }),
        isoNow(),
        isoNow(),
    ]);
    const requestedScopes = parseJson<string[]>(row.requested_scopes_json, principalRecord.principal.scopes);
    return {
        ok: true,
        status: 'approved',
        accessToken,
        refreshToken,
        tokenType: 'Bearer',
        expiresAt: expiresAt.toISOString(),
        expiresInSeconds: this.config.accessTokenTtlSeconds,
        principal: {
            ...principalRecord.principal,
            scopes: requestedScopes,
            metadata: {
                ...principalRecord.principal.metadata,
                sessionId,
            },
        },
    };
}
