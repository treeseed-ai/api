import { resolveLegacyCapability } from '@treeseed/sdk/capacity-provider';

/**
 * Preserve the provider's declared capability while adding the exact ontology
 * identity for legacy v4 advertisements. Exact v5 capability identities pass
 * through unchanged.
 */
export function providerCapabilityCompatibility(values: unknown): string[] {
	const declared = Array.isArray(values) ? values.map(String).map((value) => value.trim()).filter(Boolean) : [];
	return [...new Set(declared.flatMap((value) => {
		const resolved = resolveLegacyCapability(value);
		return resolved && resolved !== value ? [value, resolved] : [value];
	}))];
}
