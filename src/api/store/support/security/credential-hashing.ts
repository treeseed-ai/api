import { createHash,timingSafeEqual } from 'node:crypto';

export function stableHash(value: string, secret: string): string {
	return createHash('sha256').update(`${secret}:${value}`).digest('hex');
}

export function equalHash(left: string, right: string): boolean {
	const leftBuffer = Buffer.from(left);
	const rightBuffer = Buffer.from(right);
	return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function tokenPrefix(token: string): string {
	return token.slice(0, 16);
}
