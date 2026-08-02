import { randomUUID } from 'node:crypto';
import { COMMERCE_CHECKOUT_STATUS_SET,enumValue,isoNow,MarketControlPlaneStore } from "../../../../persistence/store.ts";
export async function createCommerceCheckoutMethod(this: MarketControlPlaneStore, input: any = {}) {
    await this.ensureInitialized();
    const timestamp = isoNow();
    const id = input.id ?? randomUUID();
    await this.run(`INSERT INTO commerce_checkouts (
				id, cart_id, buyer_team_id, buyer_user_id, status, checkout_mode, group_count, completed_group_count,
				metadata_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        id,
        input.cartId,
        input.buyerTeamId ?? null,
        input.buyerUserId ?? null,
        enumValue(input.status, COMMERCE_CHECKOUT_STATUS_SET, 'draft'),
        'stripe_elements_grouped_vendor',
        Number(input.groupCount ?? 0),
        Number(input.completedGroupCount ?? 0),
        JSON.stringify(input.metadata ?? {}),
        timestamp,
        timestamp,
    ]);
    await this.recordCommerceGovernanceEvent({
        actorType: input.actorType ?? 'user',
        actorId: input.actorId ?? input.buyerUserId ?? null,
        action: 'commerce_checkout.created',
        objectType: 'commerce_checkout',
        objectId: id,
        nextState: 'draft',
        relatedTeamId: input.buyerTeamId ?? null,
    });
    return this.getCommerceCheckout(id);
}
