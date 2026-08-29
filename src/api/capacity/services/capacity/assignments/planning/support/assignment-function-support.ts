import { createHash } from 'node:crypto';

export type AssignmentJsonRecord = Record<string, unknown>;

export function assignmentRecord(value: unknown): AssignmentJsonRecord {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as AssignmentJsonRecord : {};
}

export function assignmentText(value: unknown, fallback = ''): string {
	return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

export function deterministicAssignmentId(demandId: string, generation: number): string {
	return `assignment_${createHash('sha256').update(`${demandId}:${generation}`).digest('base64url').slice(0, 32)}`;
}

export function assignmentErrorCode(error: unknown): string {
	return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
		? error.code : 'capacity_admission_denied';
}
