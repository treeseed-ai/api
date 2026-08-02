import { MarketControlPlaneStore,principalIsAdmin,serializeCommerceCapacityListing } from "../../../../persistence/store.ts";
export async function listCommerceCapacityListingsMethod(this: MarketControlPlaneStore, principal, filters: any = {}) {
    await this.ensureInitialized();
    const clauses = [];
    const params = [];
    for (const [key, column] of [
        ['productId', 'product_id'],
        ['vendorId', 'vendor_id'],
        ['sellerTeamId', 'seller_team_id'],
        ['status', 'status'],
        ['accessLevel', 'access_level'],
    ]) {
        if (filters[key]) {
            clauses.push(`${column} = ?`);
            params.push(filters[key]);
        }
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = await this.all(`SELECT * FROM commerce_capacity_listings ${where} ORDER BY updated_at DESC, created_at DESC`, params);
    const teamIds = await this.teamIdsForPrincipal(principal);
    return rows
        .map((row) => {
        const sellerVisible = principalIsAdmin(principal) || teamIds.includes(row.seller_team_id);
        if (sellerVisible)
            return serializeCommerceCapacityListing(row);
        if (row.status === 'approved' && row.access_level === 'public_summary')
            return serializeCommerceCapacityListing(row, { publicSafe: true });
        return null;
    })
        .filter(Boolean);
}
