import { randomBytes } from 'node:crypto';

export function nextOpaqueToken(prefix: string) {
	return `${prefix}_${randomBytes(24).toString('base64url')}`;
}
