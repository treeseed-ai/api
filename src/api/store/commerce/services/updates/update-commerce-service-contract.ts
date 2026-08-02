import { COMMERCE_SERVICE_CONTRACT_STATUS_SET,enumValue,isoNow,MarketControlPlaneStore } from "../../../../persistence/store.ts";
export async function updateCommerceServiceContractMethod(this: MarketControlPlaneStore, contractId, input: any = {}) {
    await this.ensureInitialized();
    const existing = await this.getCommerceServiceContract(contractId);
    if (!existing)
        return null;
    await this.run(`UPDATE commerce_service_contracts
			 SET status = ?, order_id = ?, order_item_id = ?, payment_group_id = ?, entitlement_id = ?,
			     related_project_id = ?, related_workday_id = ?, fulfillment_summary = ?, metadata_json = ?, updated_at = ?
			 WHERE id = ?`, [
        enumValue(input.status, COMMERCE_SERVICE_CONTRACT_STATUS_SET, existing.status),
        input.orderId === undefined ? existing.orderId : input.orderId,
        input.orderItemId === undefined ? existing.orderItemId : input.orderItemId,
        input.paymentGroupId === undefined ? existing.paymentGroupId : input.paymentGroupId,
        input.entitlementId === undefined ? existing.entitlementId : input.entitlementId,
        input.relatedProjectId === undefined ? existing.relatedProjectId : input.relatedProjectId,
        input.relatedWorkdayId === undefined ? existing.relatedWorkdayId : input.relatedWorkdayId,
        input.fulfillmentSummary === undefined ? existing.fulfillmentSummary : input.fulfillmentSummary,
        JSON.stringify(input.metadata ?? existing.metadata ?? {}),
        isoNow(),
        contractId,
    ]);
    return this.getCommerceServiceContract(contractId);
}
