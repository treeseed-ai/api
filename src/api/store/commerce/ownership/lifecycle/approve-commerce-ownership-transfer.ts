import { MarketControlPlaneStore } from "../../../../persistence/store.ts";
export async function approveCommerceOwnershipTransferMethod(this: MarketControlPlaneStore, transferId, input: any = {}) {
    return this.updateCommerceOwnershipTransferState(transferId, 'approved', input);
}
