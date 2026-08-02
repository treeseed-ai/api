import { randomUUID } from 'node:crypto';
import { arrayValue,COMMERCE_STEWARDSHIP_ROLE_SET,enumValue,isoNow,MarketControlPlaneStore,serializeCommerceStewardshipAssignment,stringValue } from "../../../../persistence/store.ts";
export async function createCommerceStewardshipAssignmentMethod(this: MarketControlPlaneStore, productId, input: any = {}) {
    await this.ensureInitialized();
    const product = await this.getCommerceProduct(productId);
    if (!product)
        return null;
    const timestamp = isoNow();
    const ownershipRecordId = input.ownershipRecordId ?? product.ownershipRecordId;
    if (!ownershipRecordId) {
        const error: Error & Record<string, any> = new Error('Ownership record is required for stewardship assignments.');
        error.status = 409;
        throw error;
    }
    const id = input.id ?? randomUUID();
    await this.run(`INSERT INTO commerce_stewardship_assignments (
				id, ownership_record_id, product_id, role, assignee_type, assignee_id, display_name, responsibilities_json,
				visible_to_buyers, starts_at, ends_at, metadata_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        id,
        ownershipRecordId,
        productId,
        enumValue(input.role, COMMERCE_STEWARDSHIP_ROLE_SET, 'governance_steward'),
        stringValue(input.assigneeType, 'team'),
        input.assigneeId ?? product.sellerTeamId,
        input.displayName ?? null,
        JSON.stringify(arrayValue(input.responsibilities)),
        input.visibleToBuyers === false ? 0 : 1,
        input.startsAt ?? timestamp,
        input.endsAt ?? null,
        JSON.stringify(input.metadata ?? {}),
        timestamp,
        timestamp,
    ]);
    return serializeCommerceStewardshipAssignment(await this.first(`SELECT * FROM commerce_stewardship_assignments WHERE id = ?`, [id]));
}
