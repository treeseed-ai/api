import { MarketControlPlaneStore,principalIsAdmin,serializeCommerceProduct } from "../../../../../persistence/store.ts";
export async function listCommerceProductsMethod(this: MarketControlPlaneStore, principal, filters: any = {}) {
    await this.ensureInitialized();
    const clauses = [];
    const params = [];
    if (filters.teamId) {
        clauses.push('seller_team_id = ?');
        params.push(filters.teamId);
    }
    if (filters.vendorId) {
        clauses.push('vendor_id = ?');
        params.push(filters.vendorId);
    }
    if (filters.kind) {
        clauses.push('kind = ?');
        params.push(filters.kind);
    }
    if (filters.status) {
        clauses.push('status = ?');
        params.push(filters.status);
    }
    if (filters.slug) {
        clauses.push('slug = ?');
        params.push(filters.slug);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = await this.all(`SELECT * FROM commerce_products ${where} ORDER BY updated_at DESC, created_at DESC`, params);
    const teamIds = await this.teamIdsForPrincipal(principal);
    return rows
        .map(serializeCommerceProduct)
        .filter((product) => (product.visibility === 'public' && product.status === 'approved')
        || principalIsAdmin(principal)
        || teamIds.includes(product.sellerTeamId));
}
