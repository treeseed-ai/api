import { expect, it, vi } from 'vitest';
import { boundedResponseBytes } from '../../../../../src/api/providers/cloudflare/bounded-response.ts';

it('accepts exact size and empty response', async () => {
  expect(await boundedResponseBytes(new Response('abc'), 3)).toEqual(new TextEncoder().encode('abc'));
  expect(await boundedResponseBytes(new Response(null), 0)).toHaveLength(0);
});
it('rejects oversized declared length before reading', async () => {
  const cancel = vi.fn();
  const response = new Response(new ReadableStream({ cancel }), { headers: { 'content-length': '500' } });
  await expect(boundedResponseBytes(response, 3)).rejects.toThrow('bounded read');
  expect(cancel).toHaveBeenCalledOnce();
});
it.each([undefined, '1'])('bounds streamed bytes regardless of length header %s', async length => {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(2)); c.enqueue(new Uint8Array(2)); }, cancel });
  await expect(boundedResponseBytes(new Response(body, { headers: length ? { 'content-length': length } : {} }), 3)).rejects.toThrow('bounded read');
  expect(cancel).toHaveBeenCalledOnce();
});
it.each([-1, NaN, Infinity, 1.5])('rejects invalid bound %s', async maximum => {
  await expect(boundedResponseBytes(new Response(null), maximum)).rejects.toThrow('Invalid object read limit');
});
