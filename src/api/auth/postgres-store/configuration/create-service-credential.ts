import { PostgresAuthStore,ServiceCredentialResult } from "../../postgres-store.ts";
import { nextOpaqueToken } from "../../tokens.ts";
export async function createServiceCredentialMethod(this: PostgresAuthStore, input: {
    serviceId: string;
    name: string;
    roles?: string[];
    permissions?: string[];
}): Promise<ServiceCredentialResult> {
    await this.ensureInitialized();
    const secret = nextOpaqueToken('svc');
    const id = await this.upsertServiceCredential({ ...input, secret });
    return { id, serviceId: input.serviceId, secret };
}

