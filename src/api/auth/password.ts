import { pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto';

export function validateControlPlanePassword(value: unknown) {
	return typeof value === 'string' && value.length >= 12;
}

export function hashControlPlanePassword(password: string) {
	const salt = randomBytes(16).toString('base64url');
	const iterations = 210000;
	const digest = pbkdf2Sync(password, salt, iterations, 32, 'sha256').toString('base64url');
	return `pbkdf2-sha256$${iterations}$${salt}$${digest}`;
}

export function verifyControlPlanePassword(password: string, envelope: unknown) {
	const [algorithm, iterationsValue, salt, expected] = String(envelope ?? '').split('$');
	if (algorithm !== 'pbkdf2-sha256' || !iterationsValue || !salt || !expected) return false;
	const iterations = Number(iterationsValue);
	if (!Number.isInteger(iterations) || iterations <= 0) return false;
	const actual = pbkdf2Sync(password, salt, iterations, 32, 'sha256').toString('base64url');
	const left = Buffer.from(actual);
	const right = Buffer.from(expected);
	return left.length === right.length && timingSafeEqual(left, right);
}
