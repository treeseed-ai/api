import { randomUUID } from 'node:crypto';
import { PostgresAuthStore,isoNow } from "../../../postgres-store.ts";
export async function createUserMethod(this: PostgresAuthStore, input: {
    email?: string | null;
    username?: string | null;
    displayName?: string | null;
    metadata?: Record<string, unknown>;
}) {
    await this.ensureInitialized();
    const timestamp = isoNow();
    const userId = randomUUID();
    await this.run(`INSERT INTO users (id, email, username, display_name, status, metadata_json, created_at, updated_at)
			 VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`, [
        userId,
        input.email?.trim() || null,
        input.username?.trim().toLowerCase() || null,
        input.displayName?.trim() || null,
        JSON.stringify(input.metadata ?? {}),
        timestamp,
        timestamp,
    ]);
    await this.assignRole(userId, 'member');
    await this.writeAuditEvent({
        actorType: 'service',
        actorId: this.config.webServiceId,
        eventType: 'auth.user_created',
        targetType: 'user',
        targetId: userId,
        data: { source: 'admin' },
    });
    return this.principalForUser(userId);
}

