import { MarketControlPlaneStore } from "../../../../persistence/store.ts";
export async function submitCommerceProductVersionMethod(this: MarketControlPlaneStore, versionId, input: any = {}) {
    return this.transitionCommerceProductVersion(versionId, 'submitted', input);
}
