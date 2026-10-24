import { createHash } from 'node:crypto';
import type { AgentDefinition, ExactEntityReference } from '@treeseed/sdk/agent-capacity';

const stable = (value: unknown): string => {
	if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
	if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
		.map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
	return JSON.stringify(value);
};

/** Fingerprint of the existing SQL projection's agent; native YAML is read at admission. */
export const agentProfileReference = (definition: AgentDefinition): ExactEntityReference => ({
	store: 'postgresql', model: 'agent', id: definition.id,
	digest: `sha256:${createHash('sha256').update(stable(definition)).digest('hex')}`,
});
