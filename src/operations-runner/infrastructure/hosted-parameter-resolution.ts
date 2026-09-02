type Parameter = { literal: string | number | boolean } | { input: string } | { artifact: string } |
	{ resourceOutput: { resourceId: string; output: string } };

export function resolveHostedParameter(parameter: Parameter | undefined, context: {
	config: Record<string, string | number | boolean>;
	artifacts: Record<string, { digest: string; source: string }>;
	outputs?: Record<string, Record<string, string>>;
}) {
	if (!parameter) return undefined;
	if ('literal' in parameter) return parameter.literal;
	if ('input' in parameter) {
		const value = context.config[parameter.input];
		if (value === undefined) throw new Error(`Hosted runtime input ${parameter.input} is unavailable.`);
		return value;
	}
	if ('artifact' in parameter) {
		const artifact = context.artifacts[parameter.artifact];
		if (!artifact) throw new Error(`Hosted artifact ${parameter.artifact} is unavailable.`);
		return artifact;
	}
	const value = context.outputs?.[parameter.resourceOutput.resourceId]?.[parameter.resourceOutput.output];
	if (!value) throw new Error(`Hosted resource output ${parameter.resourceOutput.resourceId}.${parameter.resourceOutput.output} is unavailable.`);
	return value;
}

export function requiredString(value: unknown, label: string) {
	if (typeof value !== 'string' || !value.trim()) throw new Error(`Hosted resource parameter ${label} is required.`);
	return value.trim();
}
