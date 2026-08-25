const SENSITIVE_FIELD_PATTERN = /(?:secret|token|password|apiKey|privateKey|credential|ciphertext|passphrase)/iu;
const SENSITIVE_VALUE_PATTERN = /(?:runner-token-secret|capacity-provider-secret|secret-token|github_pat_|ghp_|sk-[a-z0-9_-]{8,}|tsp_[a-z0-9_-]+|prjrun_|tsk_)/iu;

export function redactSensitiveValue<T>(value: T): T {
	if (Array.isArray(value)) {
		return value.map((entry) => redactSensitiveValue(entry)) as T;
	}
	if (typeof value === 'string' && SENSITIVE_VALUE_PATTERN.test(value)) {
		return '[redacted]' as T;
	}
	if (!value || typeof value !== 'object') {
		return value;
	}
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>)
			.filter(([key]) => !SENSITIVE_FIELD_PATTERN.test(key))
			.map(([key, entry]) => [key, redactSensitiveValue(entry)]),
	) as T;
}
