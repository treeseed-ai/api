import { randomUUID } from 'node:crypto';
import { COMMERCE_ORDER_ITEM_STATUS_SET,enumValue,isoNow,MarketControlPlaneStore,serializeCommerceOrderItem,stringValue } from "../../../../persistence/store.ts";
export async function createCommerceOrderItemMethod(this: MarketControlPlaneStore, orderId, input: any = {}) {
    await this.ensureInitialized();
    const timestamp = isoNow();
    const id = input.id ?? randomUUID();
    await this.run(`INSERT INTO commerce_order_items (
				id, order_id, vendor_id, seller_team_id, product_id, product_version_id, offer_id, price_id, mode,
				quantity, unit_amount, total_amount, refunded_amount, refund_status, currency, status, entitlement_id, ownership_snapshot_json,
				access_scope_json, support_scope_json, metadata_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        id,
        orderId,
        input.vendorId,
        input.sellerTeamId,
        input.productId,
        input.productVersionId ?? null,
        input.offerId,
        input.priceId,
        input.mode,
        Number(input.quantity ?? 1),
        Number(input.unitAmount ?? 0),
        Number(input.totalAmount ?? 0),
        Number(input.refundedAmount ?? 0),
        input.refundStatus ?? 'none',
        stringValue(input.currency, 'usd'),
        enumValue(input.status, COMMERCE_ORDER_ITEM_STATUS_SET, 'pending'),
        input.entitlementId ?? null,
        JSON.stringify(input.ownershipSnapshot ?? {}),
        JSON.stringify(input.accessScope ?? {}),
        JSON.stringify(input.supportScope ?? {}),
        JSON.stringify(input.metadata ?? {}),
        timestamp,
        timestamp,
    ]);
    return serializeCommerceOrderItem(await this.first(`SELECT * FROM commerce_order_items WHERE id = ?`, [id]));
}
