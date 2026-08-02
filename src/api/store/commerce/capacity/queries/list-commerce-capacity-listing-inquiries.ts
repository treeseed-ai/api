import { MarketControlPlaneStore,principalIsAdmin,serializeCommerceCapacityListingInquiry } from "../../../../persistence/store.ts";
export async function listCommerceCapacityListingInquiriesMethod(this: MarketControlPlaneStore, principal, filters: any = {}) {
    await this.ensureInitialized();
    const clauses = [];
    const params = [];
    for (const [key, column] of [
        ['listingId', 'listing_id'],
        ['productId', 'product_id'],
        ['vendorId', 'vendor_id'],
        ['sellerTeamId', 'seller_team_id'],
        ['buyerTeamId', 'buyer_team_id'],
        ['buyerUserId', 'buyer_user_id'],
        ['status', 'status'],
    ]) {
        if (filters[key]) {
            clauses.push(`${column} = ?`);
            params.push(filters[key]);
        }
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = await this.all(`SELECT * FROM commerce_capacity_listing_inquiries ${where} ORDER BY updated_at DESC, created_at DESC`, params);
    const teamIds = await this.teamIdsForPrincipal(principal);
    return rows
        .map((row) => {
        const sellerVisible = principalIsAdmin(principal) || teamIds.includes(row.seller_team_id);
        const buyerVisible = (row.buyer_team_id && teamIds.includes(row.buyer_team_id)) || (row.buyer_user_id && row.buyer_user_id === principal?.id);
        if (sellerVisible || buyerVisible)
            return serializeCommerceCapacityListingInquiry(row, { publicSafe: !sellerVisible });
        return null;
    })
        .filter(Boolean);
}
