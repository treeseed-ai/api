import { MarketControlPlaneStore,principalIsAdmin,serializeCatalogItem } from "../../../../../persistence/store.ts";
export async function listCatalogItemsMethod(this: MarketControlPlaneStore, principal, filters: any = {}) {
    await this.ensureInitialized();
    const clauses = [];
    const params = [];
    if (filters.kind) {
        clauses.push('kind = ?');
        params.push(filters.kind);
    }
    if (filters.teamId) {
        clauses.push('team_id = ?');
        params.push(filters.teamId);
    }
    if (filters.slug) {
        clauses.push('slug = ?');
        params.push(filters.slug);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = await this.all(`SELECT * FROM catalog_items ${where} ORDER BY updated_at DESC, created_at DESC`, params);
    const teamIds = await this.teamIdsForPrincipal(principal);
    return rows
        .map(serializeCatalogItem)
        .filter((item) => item.visibility === 'public'
        ? item.listingEnabled
        : principalIsAdmin(principal) || teamIds.includes(item.teamId));
}
