import { ControlPlaneStore,parseJson,principalIsAdmin } from "../../../persistence/store.ts";
import { publicUserKnowledgeProfile,publicUserProfileMetadata } from '../../public-profiles/knowledge-profile.ts';
export async function loadUserProfileByUsernameMethod(this: ControlPlaneStore, username, principal = null) {
    await this.ensureInitialized();
    const normalized = String(username ?? '').trim().toLowerCase();
    if (!normalized
        || normalized.length > 39
        || !/^[a-z0-9-]+$/u.test(normalized)
        || normalized.startsWith('-')
        || normalized.endsWith('-')
        || normalized.includes('--')) {
        return null;
    }
    const row = await this.first(`SELECT users.id, users.email, users.username, users.display_name, users.status, users.created_at, users.metadata_json,
			        user_identities.profile_json
			   FROM users
			   LEFT JOIN user_identities ON user_identities.user_id = users.id
			  WHERE LOWER(users.username) = LOWER(?)
			    AND users.status = 'active'
			  ORDER BY user_identities.updated_at DESC
			  LIMIT 1`, [normalized]);
    if (!row?.id || !row.username)
        return null;
    const accountProfile = parseJson(row.metadata_json, {});
    const identityProfile = parseJson(row.profile_json, {});
    const publicMetadata = publicUserProfileMetadata({ ...identityProfile, ...accountProfile });
    return {
        user: {
            username: String(row.username).trim().toLowerCase(),
            displayName: row.display_name ?? null,
            ...(principal?.id === row.id || principalIsAdmin(principal) ? { email: row.email ?? null } : {}),
            image: typeof accountProfile.image === 'string'
                ? accountProfile.image
                : typeof identityProfile.image === 'string' ? identityProfile.image : null,
            joinedAt: row.created_at,
            ...publicMetadata,
        },
        knowledge: await publicUserKnowledgeProfile(this, String(row.id)),
    };
}
