/** Bound decoded bytes while streaming; a missing or dishonest length header is not trusted. */
export async function boundedResponseBytes(response: Response, maximum: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maximum) || maximum < 0) throw new Error('Invalid object read limit.');
  const length = response.headers.get('content-length');
  if (length !== null && /^\d+$/u.test(length) && Number(length) > maximum) {
    await response.body?.cancel();
    throw new Error('Object exceeds bounded read limit.');
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) throw new Error('Object exceeds bounded read limit.');
      chunks.push(value);
    }
    const result = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return result;
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally { reader.releaseLock(); }
}
