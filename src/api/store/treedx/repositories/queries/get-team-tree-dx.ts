import { ControlPlaneStore } from "../../../../persistence/store.ts";
export async function getTeamTreeDxMethod(this: ControlPlaneStore, teamId) {
    await this.ensureInitialized();
    const instance = await this.getPrimaryTreeDxInstance(teamId);
    return {
        instance,
        mirrors: instance ? await this.listTreeDxMirrors(teamId, instance.id) : [],
        shares: await this.listTreeDxShares(teamId),
        deployments: instance ? await this.listTreeDxDeployments(teamId, instance.id) : [],
    };
}
