import { MarketControlPlaneStore,signAssertionPayload } from "../../../persistence/store.ts";
export function createTrustedUserAssertionMethod(this: MarketControlPlaneStore, claims) {
    const secret = typeof this.config.assertionSecret === 'string' ? this.config.assertionSecret.trim() : '';
    if (!secret)
        return null;
    const encodedPayload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return `${encodedPayload}.${signAssertionPayload(encodedPayload, secret)}`;
}
