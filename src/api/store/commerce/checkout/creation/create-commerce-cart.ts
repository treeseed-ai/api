import { randomUUID } from 'node:crypto';
import { COMMERCE_CART_STATUS_SET,enumValue,isoNow,MarketControlPlaneStore } from "../../../../persistence/store.ts";
export async function createCommerceCartMethod(this: MarketControlPlaneStore, principal = null, input: any = {}) {
    await this.ensureInitialized();
    const timestamp = isoNow();
    const id = input.id ?? randomUUID();
    const buyerTeamId = input.buyerTeamId ?? null;
    const buyerUserId = input.buyerUserId ?? principal?.id ?? null;
    await this.run(`INSERT INTO commerce_carts (id, buyer_team_id, buyer_user_id, status, currency, metadata_json, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [
        id,
        buyerTeamId,
        buyerUserId,
        enumValue(input.status, COMMERCE_CART_STATUS_SET, 'active'),
        input.currency ?? null,
        JSON.stringify(input.metadata ?? {}),
        timestamp,
        timestamp,
    ]);
    await this.recordCommerceGovernanceEvent({
        actorType: input.actorType ?? 'user',
        actorId: input.actorId ?? principal?.id ?? null,
        action: 'commerce_cart.created',
        objectType: 'commerce_cart',
        objectId: id,
        nextState: 'active',
        relatedTeamId: buyerTeamId,
    });
    return this.getCommerceCart(id);
}
