import { CapacityGovernanceError } from '../../database.ts';

const DEFAULT_VALIDITY_SECONDS = 15 * 60;
const MAX_VALIDITY_SECONDS = 7 * 24 * 60 * 60;

export function accessTokenValiditySeconds(requested: number | undefined) {
	if (requested === undefined) return DEFAULT_VALIDITY_SECONDS;
	if (!Number.isInteger(requested) || requested < 60 || requested > MAX_VALIDITY_SECONDS) {
		throw new CapacityGovernanceError('provider_access_token_validity_invalid', 'Requested access-token validity must be a whole number of seconds between 60 and seven days.', 400);
	}
	return requested;
}
