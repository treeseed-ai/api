import { ControlPlaneStore } from "../../../../persistence/store.ts";
export async function getTeamByNameMethod(this: ControlPlaneStore, name) {
    return this.getTeamBySlug(name);
}
