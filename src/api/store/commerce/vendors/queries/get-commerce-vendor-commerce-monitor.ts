import { isoNow,MarketControlPlaneStore } from "../../../../persistence/store.ts";
export async function getCommerceVendorCommerceMonitorMethod(this: MarketControlPlaneStore, teamId, filters: any = {}) {
    await this.ensureInitialized();
    const vendor = await this.getCommerceVendorForTeam(teamId);
    const stripeAccount = vendor
        ? await this.first(`SELECT * FROM commerce_vendor_stripe_accounts WHERE vendor_id = ? ORDER BY updated_at DESC LIMIT 1`, [vendor.id])
        : null;
    const [blockedSync, driftedSync, pendingFulfillment, failedRefunds, failedWebhooks, pendingServices, pendingCapacity, pendingTransfers,] = await Promise.all([
        this.first(`SELECT COUNT(*) AS count
				 FROM commerce_prices p
				 JOIN commerce_offers o ON o.id = p.offer_id
				 WHERE o.seller_team_id = ? AND p.stripe_sync_status = 'blocked'`, [teamId]),
        this.first(`SELECT COUNT(*) AS count
				 FROM commerce_prices p
				 JOIN commerce_offers o ON o.id = p.offer_id
				 WHERE o.seller_team_id = ? AND p.stripe_sync_status = 'drifted'`, [teamId]),
        this.first(`SELECT COUNT(*) AS count FROM commerce_order_items WHERE seller_team_id = ? AND status = 'paid'`, [teamId]),
        this.first(`SELECT COUNT(*) AS count FROM commerce_refunds WHERE seller_team_id = ? AND status = 'failed'`, [teamId]),
        this.first(`SELECT COUNT(*) AS count FROM commerce_webhook_events WHERE status = 'failed'`, []),
        this.first(`SELECT COUNT(*) AS count FROM commerce_service_requests WHERE seller_team_id = ? AND status IN ('requested', 'scoping', 'quoted', 'buyer_approved', 'checkout_pending')`, [teamId]),
        this.first(`SELECT COUNT(*) AS count FROM commerce_capacity_listing_inquiries WHERE seller_team_id = ? AND status IN ('requested', 'reviewing')`, [teamId]),
        this.first(`SELECT COUNT(*) AS count FROM commerce_ownership_transfers WHERE product_id IN (SELECT id FROM commerce_products WHERE seller_team_id = ?) AND status IN ('draft', 'submitted')`, [teamId]),
    ]);
    return {
        vendorId: vendor?.id ?? null,
        sellerTeamId: teamId,
        stripeReady: Boolean(stripeAccount?.account_status === 'enabled' && stripeAccount?.charges_enabled),
        blockedStripeSyncCount: Number(blockedSync?.count ?? 0),
        driftedStripeSyncCount: Number(driftedSync?.count ?? 0),
        pendingFulfillmentCount: Number(pendingFulfillment?.count ?? 0),
        failedRefundCount: Number(failedRefunds?.count ?? 0),
        failedWebhookCount: Number(failedWebhooks?.count ?? 0),
        pendingServiceRequestCount: Number(pendingServices?.count ?? 0),
        pendingCapacityInquiryCount: Number(pendingCapacity?.count ?? 0),
        pendingGovernanceTransferCount: Number(pendingTransfers?.count ?? 0),
        recentGovernanceEvents: await this.listCommerceGovernanceEvents({ teamId }).then((events) => events.slice(0, 8)),
        updatedAt: isoNow(),
    };
}
