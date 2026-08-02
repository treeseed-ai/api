import { randomUUID } from 'node:crypto';
import { isoNow,MarketControlPlaneStore,safeIdPart,stringValue } from "../../../../persistence/store.ts";
export async function requestCommerceVendorMethod(this: MarketControlPlaneStore, teamId, input: any = {}) {
    await this.ensureInitialized();
    const team = await this.getTeam(teamId);
    if (!team) {
        const error: Error & Record<string, any> = new Error(`Unknown team "${teamId}".`);
        error.status = 404;
        throw error;
    }
    const existing = await this.getCommerceVendorForTeam(teamId);
    if (existing)
        return existing;
    const timestamp = isoNow();
    const id = input.id ?? randomUUID();
    const displayName = stringValue(input.displayName, team.displayName ?? team.name ?? team.slug ?? 'Commerce Vendor');
    const slug = safeIdPart(input.slug ?? team.slug ?? team.name ?? id, id);
    await this.run(`INSERT INTO commerce_vendors (
				id, team_id, display_name, slug, status, trust_level, professional_entitlement_id, stripe_account_id,
				sales_enabled, service_sales_enabled, capacity_listings_enabled, metadata_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        id,
        teamId,
        displayName,
        slug,
        'submitted',
        'public_publisher',
        input.professionalEntitlementId ?? null,
        null,
        0,
        0,
        0,
        JSON.stringify(input.metadata ?? {}),
        timestamp,
        timestamp,
    ]);
    await this.recordCommerceGovernanceEvent({
        actorType: input.actorType ?? 'user',
        actorId: input.actorId ?? null,
        action: 'vendor.request',
        objectType: 'commerce_vendor',
        objectId: id,
        priorState: null,
        nextState: 'submitted',
        reason: input.reason ?? null,
        evidence: input.evidence ?? {},
        relatedTeamId: teamId,
    });
    return this.getCommerceVendor(id);
}
