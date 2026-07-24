

export function objectValue(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export const SENSITIVE_OUTPUT_KEY_PATTERN = /(?:^|[_-])(?:token|password|passphrase|api[_-]?key|private[_-]?key|credential|secret)(?:$|[_-])|(?:token|password|passphrase|apiKey|privateKey|credential)$/iu;

export const SENSITIVE_OUTPUT_VALUE_PATTERN = /(?:github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9_]{16,}|sk-[A-Za-z0-9_-]{16,}|[A-Za-z0-9+/=]{48,})/gu;

export function redactProjectHostOperationValue(value, key = '') {
    if (SENSITIVE_OUTPUT_KEY_PATTERN.test(key))
        return '[redacted]';
    if (typeof value === 'string')
        return value.replace(SENSITIVE_OUTPUT_VALUE_PATTERN, '[redacted]');
    if (Array.isArray(value))
        return value.map((entry) => redactProjectHostOperationValue(entry));
    if (!value || typeof value !== 'object')
        return value;
    const output = {};
    for (const [entryKey, entryValue] of Object.entries(value)) {
        output[entryKey] = redactProjectHostOperationValue(entryValue, entryKey);
    }
    return output;
}
