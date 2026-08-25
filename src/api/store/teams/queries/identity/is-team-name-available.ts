import { ControlPlaneStore,validateTeamName } from "../../../../persistence/store.ts";
export async function isTeamNameAvailableMethod(this: ControlPlaneStore, name, excludeTeamId = null) {
    await this.ensureInitialized();
    const validation = validateTeamName(name);
    if (!validation.ok)
        return false;
    const row = await this.first(`SELECT id FROM teams WHERE LOWER(name) = LOWER(?) ${excludeTeamId ? 'AND id != ?' : ''} LIMIT 1`, excludeTeamId ? [validation.name, excludeTeamId] : [validation.name]);
    if (row?.id)
        return false;
    return !(await this.publicUsernameExists(validation.name));
}
