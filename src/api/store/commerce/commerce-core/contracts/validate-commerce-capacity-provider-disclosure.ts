import { MarketControlPlaneStore } from "../../../../persistence/store.ts";
export async function validateCommerceCapacityProviderDisclosureMethod(this: MarketControlPlaneStore, product, input: any = {}, capacity) {
    if (!input.capacityProviderId && !input.executionProviderId)
        return;
    if (!input.capacityProviderId) {
        const error: Error & Record<string, any> = new Error('capacityProviderId is required when linking an execution provider.');
        error.status = 400;
        throw error;
    }
    const provider = await capacity.getCapacityProvider(product.sellerTeamId, input.capacityProviderId);
    if (!provider && !input.marketAdmin) {
        const error: Error & Record<string, any> = new Error('Capacity provider must be controlled by the seller team.');
        error.status = 403;
        throw error;
    }
    if (input.executionProviderId) {
        const executionProvider = (await capacity.listProviderExecutionSnapshots(product.sellerTeamId, input.capacityProviderId))
            .find((entry) => entry.id === input.executionProviderId);
        if (!executionProvider) {
            const error: Error & Record<string, any> = new Error('Execution provider must be declared by an active availability session for the linked provider.');
            error.status = 400;
            throw error;
        }
    }
}
