import { ControlPlaneStore } from "../../../../persistence/store.ts";
export async function getTeamByNameMethod(this: ControlPlaneStore, name: unknown) {
    return this.getTeamBySlug(name);
}
