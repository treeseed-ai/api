import { MarketControlPlaneStore } from "../../../../persistence/store.ts";
export async function submitCommerceOwnershipTransferMethod(this: MarketControlPlaneStore, transferId, input: any = {}) {
    return this.updateCommerceOwnershipTransferState(transferId, 'submitted', input);
}
