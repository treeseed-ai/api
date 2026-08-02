import { randomUUID } from 'node:crypto';
import { isoNow,MarketControlPlaneStore,serializeCommerceProductVersion,stringValue } from "../../../../persistence/store.ts";
export async function createCommerceProductVersionMethod(this: MarketControlPlaneStore, productId, input: any = {}) {
    await this.ensureInitialized();
    const product = await this.getCommerceProduct(productId);
    if (!product)
        return null;
    const timestamp = isoNow();
    const version = stringValue(input.version, '');
    if (!version) {
        const error: Error & Record<string, any> = new Error('Product version is required.');
        error.status = 400;
        throw error;
    }
    const id = input.id ?? randomUUID();
    await this.run(`INSERT INTO commerce_product_versions (
				id, product_id, version, status, catalog_artifact_version_id, manifest_key, artifact_key, integrity,
				release_notes, compatibility_json, metadata_json, published_at, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        id,
        productId,
        version,
        'draft',
        null,
        input.manifestKey ?? null,
        input.artifactKey ?? null,
        input.integrity ?? null,
        input.releaseNotes ?? null,
        JSON.stringify(input.compatibility ?? {}),
        JSON.stringify(input.metadata ?? {}),
        null,
        timestamp,
        timestamp,
    ]);
    return serializeCommerceProductVersion(await this.first(`SELECT * FROM commerce_product_versions WHERE id = ?`, [id]));
}
