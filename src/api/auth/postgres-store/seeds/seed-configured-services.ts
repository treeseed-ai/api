import { PostgresAuthStore } from "../../postgres-store.ts";
export async function seedConfiguredServicesMethod(this: PostgresAuthStore) {
    if (!this.config.webServiceSecret)
        return;
    await this.upsertServiceCredential({
        serviceId: this.config.webServiceId,
        name: 'Trusted web tier',
        secret: this.config.webServiceSecret,
        roles: ['platform_operator'],
        permissions: ['services:impersonate:global'],
    });
}
