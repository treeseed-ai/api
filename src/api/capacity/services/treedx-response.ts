import { CapacityGovernanceError } from '../database.ts';

export const MAX_TREEDX_RESPONSE_BYTES = 256 * 1024;

export async function readBoundedTreeDxJson(response: Response, options: {
	tooLargeCode?: string;
	invalidCode?: string;
	owner?: string;
} = {}): Promise<unknown> {
	const owner = options.owner ?? 'TreeDX response';
	const tooLargeCode = options.tooLargeCode ?? 'treedx_response_too_large';
	const invalidCode = options.invalidCode ?? 'treedx_response_invalid';
	const declared = Number(response.headers.get('content-length'));
	if (Number.isFinite(declared) && declared > MAX_TREEDX_RESPONSE_BYTES) {
		throw new CapacityGovernanceError(tooLargeCode, `${owner} exceeds ${MAX_TREEDX_RESPONSE_BYTES} bytes.`, 502);
	}
	if (!response.body) return {};
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let total = 0;
	let body = '';
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > MAX_TREEDX_RESPONSE_BYTES) {
				await reader.cancel().catch(() => undefined);
				throw new CapacityGovernanceError(tooLargeCode, `${owner} exceeds ${MAX_TREEDX_RESPONSE_BYTES} bytes.`, 502);
			}
			body += decoder.decode(value, { stream: true });
		}
		body += decoder.decode();
	} finally {
		reader.releaseLock();
	}
	if (!body) return {};
	try { return JSON.parse(body); } catch {
		throw new CapacityGovernanceError(invalidCode, `${owner} returned invalid JSON.`, 502);
	}
}
