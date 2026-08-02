import { MarketControlPlaneStore,missingSchemaError,normalizeTeamName } from "../../../persistence/store.ts";
export async function teamPublicNameExistsMethod(this: MarketControlPlaneStore, name, excludeTeamId = null) {
    await this.ensureInitialized();
    const value = normalizeTeamName(name);
    if (!value)
        return false;
    try {
        const row = await this.first(`SELECT id FROM teams WHERE (LOWER(name) = LOWER(?) OR LOWER(slug) = LOWER(?)) ${excludeTeamId ? 'AND id != ?' : ''} LIMIT 1`, excludeTeamId ? [value, value, excludeTeamId] : [value, value]);
        return Boolean(row?.id);
    }
    catch (error) {
        if (!missingSchemaError(error))
            throw error;
        return false;
    }
}
