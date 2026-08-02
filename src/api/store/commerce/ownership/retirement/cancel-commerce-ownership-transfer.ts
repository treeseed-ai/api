import { MarketControlPlaneStore } from "../../../../persistence/store.ts";
export async function cancelCommerceOwnershipTransferMethod(this: MarketControlPlaneStore, transferId, input: any = {}) {
    return this.updateCommerceOwnershipTransferState(transferId, 'canceled', input);
}
