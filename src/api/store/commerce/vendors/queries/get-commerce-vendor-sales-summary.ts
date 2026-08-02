import { MarketControlPlaneStore } from "../../../../persistence/store.ts";
export async function getCommerceVendorSalesSummaryMethod(this: MarketControlPlaneStore, teamId, filters: any = {}) {
    await this.ensureInitialized();
    const vendor = await this.getCommerceVendorForTeam(teamId);
    if (!vendor)
        return null;
    const orderRows = await this.all<{ status: string; total_amount: number | string | null; refunded_amount: number | string | null; currency: string | null }>(`SELECT * FROM commerce_orders WHERE seller_team_id = ?`, [teamId]);
    const subscriptionRows = await this.all<{ id: string }>(`SELECT * FROM commerce_subscriptions WHERE seller_team_id = ? AND status IN ('active', 'trialing')`, [teamId]);
    const entitlementRows = await this.all<{ id: string }>(`SELECT * FROM commerce_entitlements WHERE seller_team_id = ? AND status = 'active'`, [teamId]);
    const itemRows = await this.all<{ id: string }>(`SELECT * FROM commerce_order_items WHERE seller_team_id = ? AND status = 'paid'`, [teamId]);
    const grossPaidAmount = orderRows
        .filter((row) => ['paid', 'partially_refunded', 'refunded'].includes(row.status))
        .reduce((sum, row) => sum + Number(row.total_amount ?? 0), 0);
    const refundedAmount = orderRows.reduce((sum, row) => sum + Number(row.refunded_amount ?? 0), 0);
    return {
        vendorId: vendor.id,
        sellerTeamId: teamId,
        currency: orderRows[0]?.currency ?? null,
        grossPaidAmount,
        refundedAmount,
        netPaidAmount: Math.max(0, grossPaidAmount - refundedAmount),
        paidOrderCount: orderRows.filter((row) => ['paid', 'partially_refunded', 'refunded'].includes(row.status)).length,
        refundedOrderCount: orderRows.filter((row) => ['partially_refunded', 'refunded'].includes(row.status)).length,
        activeSubscriptionCount: subscriptionRows.length,
        activeEntitlementCount: entitlementRows.length,
        pendingFulfillmentCount: itemRows.length,
    };
}
