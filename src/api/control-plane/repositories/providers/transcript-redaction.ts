type JsonRecord = Record<string, unknown>;

const SENSITIVE_KEY = /(?:authorization|cookie|credential|password|private[_-]?key|secret|(?:access|auth|refresh|api|session)[_-]?token|token$)/iu;

export function redactTranscriptValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(redactTranscriptValue);
	if (!value || typeof value !== 'object') return value;
	return Object.fromEntries(Object.entries(value as JsonRecord).map(([key, entry]) => {
		if (SENSITIVE_KEY.test(key)) return [key, '<redacted>'];
		if (key.endsWith('_json') && typeof entry === 'string') {
			try {
				return [key, redactTranscriptValue(JSON.parse(entry))];
			} catch {
				return [key, '<invalid-json>'];
			}
		}
		return [key, redactTranscriptValue(entry)];
	}));
}
