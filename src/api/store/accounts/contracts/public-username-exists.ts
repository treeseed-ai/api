import { ControlPlaneStore,missingSchemaError } from "../../../persistence/store.ts";
export async function publicUsernameExistsMethod(this: ControlPlaneStore, username, excludeUserId = null) {
    await this.ensureInitialized();
    const value = String(username ?? '').trim().toLowerCase();
    if (!value)
        return false;
    try {
        const row = await this.first(`SELECT id FROM users WHERE LOWER(username) = LOWER(?) ${excludeUserId ? 'AND id != ?' : ''} LIMIT 1`, excludeUserId ? [value, excludeUserId] : [value]);
        return Boolean(row?.id);
    }
    catch (error) {
        if (!missingSchemaError(error))
            throw error;
        return false;
    }
}
