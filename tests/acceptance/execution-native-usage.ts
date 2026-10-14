import assert from 'node:assert/strict';
type Row = Record<string, unknown>;
const label = 'ACCEPTANCE_NATIVE_USAGE';
function row(value: unknown): Row {
	assert.ok(value && typeof value === 'object' && !Array.isArray(value), label);
	return value as Row;
}
function measured(value: unknown): number {
	assert.ok(typeof value === 'number' && Number.isFinite(value) && value >= 0, label);
	return value;
}
/** Compare original executor observations; never synthesize measurements from receipts. */
export function verifyNativeModelUsage(contextValue: unknown, resultValue: unknown): void {
	const context = row(contextValue), result = row(resultValue), actual = row(result.usage);
	assert.ok(Array.isArray(context.usage) && context.usage.length === 1, label);
	const observed = row(context.usage[0]), native = row(observed.nativeUsage), canonical = row(actual.native);
	assert.equal(observed.provenance, 'execution-provider', label);
	assert.ok(Object.keys(native).length > 0, label);
	for (const [key, value] of Object.entries(native)) assert.equal(canonical[key], measured(value), label);
	const expected = new Set(Object.keys(native));
	for (const [key, value] of Object.entries(observed)) {
		if (['provenance', 'nativeUsage'].includes(key)) continue;
		measured(value);
		if (Object.hasOwn(native, key)) assert.equal(value, native[key], label);
		if (!['elapsedSeconds', 'inputTokens', 'outputTokens'].includes(key)) { expected.add(key); assert.equal(canonical[key], value, label); }
	}
	assert.deepEqual(Object.keys(canonical).sort(), [...expected].sort(), label);
	assert.equal(observed.elapsedSeconds, native.elapsedSeconds, label);
	assert.equal(row(context.timing).elapsedSeconds, native.elapsedSeconds, label);
	assert.equal(actual.elapsedSeconds, Math.ceil(measured(native.elapsedSeconds)), label);
	for (const [raw, normalized, output] of [['input_tokens', 'inputTokens', 'modelInputTokens'], ['output_tokens', 'outputTokens', 'modelOutputTokens']]) {
		assert.ok(Number.isSafeInteger(native[raw!]) && measured(native[raw!]) >= 0, label);
		assert.equal(observed[normalized!], native[raw!], label); assert.equal(actual[output!], native[raw!], label);
	}
	assert.ok(measured(native.activeSeconds) <= measured(native.elapsedSeconds), label);
	for (const field of ['cpuUserMicros', 'cpuSystemMicros', 'peakRssBytes']) {
		assert.equal(row(context.resources)[field], measured(native[field]), label);
	}
}
/** Decrypted original provider counters remain a separate authority from result views. */
export function verifyNativeProviderUsage(contextValue: unknown, protectedValue: unknown): void {
	const context = row(contextValue), protectedPayload = row(protectedValue);
	assert.ok(Array.isArray(context.usage) && context.usage.length === 1, label);
	const native = row(row(context.usage[0]).nativeUsage);
	assert.ok(Array.isArray(protectedPayload.providerEvents) && protectedPayload.providerEvents.length > 0, label);
	// The owning guest retains the last native completed event's original usage.
	const completed = [...protectedPayload.providerEvents].reverse().map(row).find(event => typeof event.type === 'string' && event.type.includes('completed'));
	assert.ok(completed, label); const provider = row(completed.usage);
	assert.ok(Object.keys(provider).length > 0, label);
	for (const [key, value] of Object.entries(provider)) assert.equal(native[key], measured(value), label);
	const measuredFields = ['activeSeconds', 'elapsedSeconds', 'cpuUserMicros', 'cpuSystemMicros', 'peakRssBytes'];
	assert.deepEqual(Object.keys(native).sort(), [...new Set([...Object.keys(provider), ...measuredFields])].sort(), label);
}
