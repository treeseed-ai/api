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

/**
 * Identifies an availability projection that still relies on the temporary
 * v4 capability bridge. Native v5 providers must publish negotiated offers;
 * only a provider that actually declared a translatable legacy capability may
 * bypass offer negotiation during the migration window.
 */
export function usesLegacyCapabilityCompatibility(values: unknown): boolean {
	const declared = Array.isArray(values) ? values.map(String).map((value) => value.trim()).filter(Boolean) : [];
	return declared.some((value) => {
		const resolved = resolveLegacyCapability(value);
		return Boolean(resolved && resolved !== value);
	});
}
