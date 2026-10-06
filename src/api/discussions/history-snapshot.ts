import { createHash } from 'node:crypto';

type Message = { path?: unknown; body?: unknown; immutableRef?: unknown; frontmatter?: Record<string, unknown> };
const text = (value: unknown) => typeof value === 'string' ? value : '';

/** Authorized TreeDX results only. This is conversation evidence, never instructions. */
export function discussionHistorySnapshot(messages: Message[], discussionId: string, currentPath: string) {
	const prefix = `discussion-messages/${discussionId}/`;
	const candidates = messages.filter(message => text(message.path).startsWith(prefix)
		&& text(message.path) !== currentPath && !text(message.path).split('/').includes('..'))
		.sort((a, b) => text(a.frontmatter?.createdAt).localeCompare(text(b.frontmatter?.createdAt)) || text(a.path).localeCompare(text(b.path)));
	let remaining = 8_192;
	const selected = [];
	for (const message of candidates.slice(-6).reverse()) {
		const source = text(message.body), bytes = Buffer.from(source), ref = text(message.immutableRef);
		if (!/^[a-f0-9]{40}$/u.test(ref)) throw new Error('Discussion history omitted exact TreeDX commit provenance.');
		const limit = Math.min(remaining, 2_048);
		if (limit <= 0) break;
		const body = bytes.subarray(0, limit).toString('utf8').replace(/\uFFFD$/u, '');
		remaining -= Buffer.byteLength(body);
		selected.push({ path: text(message.path), immutableRef: ref, createdAt: text(message.frontmatter?.createdAt),
			author: text(message.frontmatter?.author).slice(0, 128) || null, body, truncated: Buffer.byteLength(body) < bytes.length,
			sourceDigest: `sha256:${createHash('sha256').update(source).digest('hex')}` });
	}
	return { kind: 'prior-discussion-messages', messages: selected.reverse(), omittedCount: candidates.length - selected.length };
}
