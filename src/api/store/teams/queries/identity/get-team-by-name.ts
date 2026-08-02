import { MarketControlPlaneStore } from "../../../../persistence/store.ts";
export async function getTeamByNameMethod(this: MarketControlPlaneStore, name) {
    return this.getTeamBySlug(name);
}
