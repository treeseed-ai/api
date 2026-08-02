import { randomUUID } from 'node:crypto';
import { isoNow,MarketControlPlaneStore,serializeCommerceCartItem } from "../../../../persistence/store.ts";
export async function addCommerceCartItemMethod(this: MarketControlPlaneStore, cartId, input: any = {}) {
    await this.ensureInitialized();
    const cart = await this.getCommerceCart(cartId);
    if (!cart) {
        const error: Error & Record<string, any> = new Error(`Unknown commerce cart "${cartId}".`);
        error.status = 404;
        throw error;
    }
    const offer = await this.getCommerceOffer(input.offerId);
    if (!offer) {
        const error: Error & Record<string, any> = new Error(`Unknown commerce offer "${input.offerId}".`);
        error.status = 404;
        throw error;
    }
    const product = await this.getCommerceProduct(offer.productId);
    const price = input.priceId ? await this.getCommercePrice(input.priceId) : (offer.activePriceId ? await this.getCommercePrice(offer.activePriceId) : null);
    const quantity = Math.max(1, Number(input.quantity ?? 1));
    const timestamp = isoNow();
    const id = input.id ?? randomUUID();
    await this.run(`INSERT INTO commerce_cart_items (
				id, cart_id, vendor_id, seller_team_id, product_id, product_version_id, offer_id, price_id,
				quantity, unit_amount, currency, mode, status, metadata_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        id,
        cartId,
        offer.vendorId,
        offer.sellerTeamId,
        offer.productId,
        offer.productVersionId ?? product?.currentVersionId ?? null,
        offer.id,
        price?.id ?? null,
        quantity,
        Number(price?.amount ?? 0),
        price?.currency ?? cart.currency ?? 'usd',
        offer.mode,
        'active',
        JSON.stringify(input.metadata ?? {}),
        timestamp,
        timestamp,
    ]);
    await this.recordCommerceGovernanceEvent({
        actorType: input.actorType ?? 'user',
        actorId: input.actorId ?? cart.buyerUserId,
        action: 'commerce_cart.item_added',
        objectType: 'commerce_cart_item',
        objectId: id,
        nextState: 'active',
        relatedOfferId: offer.id,
        relatedProductId: offer.productId,
        relatedTeamId: cart.buyerTeamId,
    });
    return serializeCommerceCartItem(await this.first(`SELECT * FROM commerce_cart_items WHERE id = ?`, [id]));
}
