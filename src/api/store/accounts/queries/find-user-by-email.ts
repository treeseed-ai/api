import { ControlPlaneStore } from "../../../persistence/store.ts";
export async function findUserByEmailMethod(this: ControlPlaneStore, email) {
    await this.ensureInitialized();
    const normalized = String(email ?? '').trim().toLowerCase();
    if (!normalized)
        return null;
    const verified = await this.first(`SELECT users.*
			   FROM users
			   INNER JOIN user_email_addresses
			     ON user_email_addresses.user_id = users.id
			    AND user_email_addresses.normalized_email = ?
			    AND user_email_addresses.status = 'verified'
			  WHERE users.status = 'active'
			  LIMIT 1`, [normalized]);
    if (verified)
        return verified;
    const legacy = await this.first(`SELECT * FROM users WHERE LOWER(email) = LOWER(?) AND status = 'active' LIMIT 1`, [normalized]);
    if (!legacy?.id)
        return null;
    const emailRows = await this.first(`SELECT COUNT(*) AS count FROM user_email_addresses WHERE user_id = ?`, [legacy.id]);
    return Number(emailRows?.count ?? 0) === 0 ? legacy : null;
}
