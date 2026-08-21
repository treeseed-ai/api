import { PostgresAuthStore,parseJson } from "../../postgres-store.ts";
export async function rotateServiceCredentialMethod(this: PostgresAuthStore, serviceId: string) {
    await this.ensureInitialized();
    const row = await this.first<{
        name: string;
        roles_json: string;
        permissions_json: string;
    }>(`SELECT name, roles_json, permissions_json FROM service_credentials WHERE service_id = ? AND revoked_at IS NULL`, [serviceId]);
    if (!row) {
        throw new Error(`Unknown active service credential "${serviceId}".`);
    }
    return this.createServiceCredential({
        serviceId,
        name: row.name,
        roles: parseJson<string[]>(row.roles_json, []),
        permissions: parseJson<string[]>(row.permissions_json, []),
    });
}

