import { MarketControlPlaneStore } from "../../../../persistence/store.ts";
export async function rejectCommerceOwnershipTransferMethod(this: MarketControlPlaneStore, transferId, input: any = {}) {
    return this.updateCommerceOwnershipTransferState(transferId, 'rejected', input);
}
