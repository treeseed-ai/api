import { randomUUID } from 'node:crypto';
import { PostgresAuthStore,isoNow,stableHash } from "../../postgres-store.ts";
export async function upsertServiceCredentialMethod(this: PostgresAuthStore, input: {
    serviceId: string;
    name: string;
    secret: string;
    roles?: string[];
    permissions?: string[];
}) {
    const nowIso = isoNow();
    const existing = await this.first<{
        id: string;
    }>(`SELECT id FROM service_credentials WHERE service_id = ?`, [input.serviceId]);
    const secretHash = stableHash(input.secret, this.config.authSecret);
    if (existing) {
        await this.run(`UPDATE service_credentials
				 SET name = ?, secret_hash = ?, roles_json = ?, permissions_json = ?, revoked_at = NULL, updated_at = ?
				 WHERE id = ?`, [input.name, secretHash, JSON.stringify(input.roles ?? []), JSON.stringify(input.permissions ?? []), nowIso, existing.id]);
        return existing.id;
    }
    const id = randomUUID();
    await this.run(`INSERT INTO service_credentials (id, service_id, name, secret_hash, roles_json, permissions_json, revoked_at, last_used_at, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`, [id, input.serviceId, input.name, secretHash, JSON.stringify(input.roles ?? []), JSON.stringify(input.permissions ?? []), nowIso, nowIso]);
    return id;
}

