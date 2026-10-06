import { describe, expect, it } from 'vitest';
import { discussionHistorySnapshot } from '../../../../src/api/discussions/history-snapshot.ts';

const ref = 'a'.repeat(40);
const message = (id: string, body: string, createdAt = id) => ({ path: `discussion-messages/topic/${id}.mdx`, body, immutableRef: ref, frontmatter: { createdAt, author: 'architect' } });
describe('chat history snapshot', () => {
	it('preserves prior turns chronologically with exact provenance, excluding current and other discussions', () => {
		const result = discussionHistorySnapshot([message('2', '2 + 2 = 4'), message('1', 'What is 2 + 2?'), message('3', 'What was that result?'), { ...message('4', 'not authorized here'), path: 'discussion-messages/elsewhere/4.mdx' }], 'topic', 'discussion-messages/topic/3.mdx');
		expect(result.messages.map(entry => entry.body)).toEqual(['What is 2 + 2?', '2 + 2 = 4']);
		expect(result.messages.every(entry => entry.immutableRef === ref && /^sha256:[a-f0-9]{64}$/u.test(entry.sourceDigest))).toBe(true);
		expect(result.omittedCount).toBe(0);
	});
	it('bounds history by count and UTF-8 bytes and reports omissions and truncation', () => {
		const result = discussionHistorySnapshot(Array.from({ length: 12 }, (_, index) => message(String(index).padStart(2, '0'), '🙂'.repeat(3000))), 'topic', 'current');
		expect(result.messages.length).toBeLessThanOrEqual(6);
		expect(result.messages.reduce((sum, entry) => sum + Buffer.byteLength(entry.body), 0)).toBeLessThanOrEqual(8192);
		expect(result.messages.every(entry => entry.truncated && !entry.body.includes('\uFFFD'))).toBe(true);
		expect(result.messages.at(-1)?.path).toBe('discussion-messages/topic/11.mdx');
		expect(result.omittedCount).toBe(12 - result.messages.length);
	});
	it('fails closed without immutable source provenance', () => {
		expect(() => discussionHistorySnapshot([{ ...message('1', 'prior'), immutableRef: 'staging' }], 'topic', 'current')).toThrow('exact TreeDX commit');
	});
});
