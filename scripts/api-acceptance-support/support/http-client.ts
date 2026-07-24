import { resolve } from 'node:path';

export function acceptanceRequestTimeoutMs() {
    const value = Number.parseInt(process.env.TREESEED_ACCEPTANCE_REQUEST_TIMEOUT_MS ?? '30000', 10);
    return Number.isFinite(value) && value > 0 ? value : 30000;
}

export function acceptanceRequestAttempts() {
    const value = Number.parseInt(process.env.TREESEED_ACCEPTANCE_REQUEST_ATTEMPTS ?? '5', 10);
    return Number.isFinite(value) && value > 0 ? value : 5;
}

export function retryDelayMs(attempt) {
    return Math.min(250 * (2 ** Math.max(0, attempt - 1)), 3000);
}

export function isRetryableFetchError(error) {
    const code = error?.cause?.code ?? error?.code;
    return [
        'UND_ERR_CONNECT_TIMEOUT',
        'UND_ERR_HEADERS_TIMEOUT',
        'UND_ERR_SOCKET',
        'ECONNRESET',
        'ECONNREFUSED',
        'ETIMEDOUT',
        'EAI_AGAIN',
    ].includes(code);
}

export function isRetryableResponse(response) {
    return [408, 425, 429, 500, 502, 503, 504].includes(response.status);
}

export function sanitizeDiagnosticValue(value) {
    if (typeof value === 'string') {
        return value.replace(/([A-Za-z0-9_-]*(?:secret|token|password|credential|api[_-]?key|private[_-]?key)[A-Za-z0-9_-]*["']?\s*[:=]\s*["']?)[^"',\s}]+/giu, '$1[redacted]');
    }
    if (Array.isArray(value))
        return value.map((entry) => sanitizeDiagnosticValue(entry));
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
            key,
            /(?:secret|token|password|credential|api[_-]?key|private[_-]?key|ciphertext)/iu.test(key)
                ? '[redacted]'
                : sanitizeDiagnosticValue(entry),
        ]));
    }
    return value;
}

export async function fetchWithTimeout(url, init: any = {}, label = String(url)) {
    const timeoutMs = acceptanceRequestTimeoutMs();
    const maxAttempts = init.signal ? 1 : acceptanceRequestAttempts();
    let lastError = null;
    let lastResponse = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(new Error(`Acceptance request timed out after ${timeoutMs}ms: ${label}`)), timeoutMs);
        try {
            const response = await fetch(url, {
                ...init,
                signal: init.signal ?? controller.signal,
            });
            if (!isRetryableResponse(response) || attempt >= maxAttempts)
                return response;
            lastResponse = response;
            lastError = null;
        }
        catch (error) {
            lastResponse = null;
            if (controller.signal.aborted) {
                lastError = new Error(`Acceptance request timed out after ${timeoutMs}ms: ${label}`);
            }
            else {
                lastError = error;
            }
            const retryable = controller.signal.aborted || isRetryableFetchError(error);
            if (!retryable || attempt >= maxAttempts)
                break;
        }
        finally {
            clearTimeout(timeout);
        }
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs(attempt)));
    }
    if (lastResponse) {
        throw new Error(`Acceptance request failed for ${label}: retryable HTTP ${lastResponse.status} after ${maxAttempts} attempts.`);
    }
    const cause = lastError?.cause;
    const details = cause?.code || cause?.message
        ? ` (${[cause?.code, cause?.message].filter(Boolean).join(': ')})`
        : '';
    throw new Error(`Acceptance request failed for ${label}: ${lastError?.message ?? String(lastError)}${details}`);
}
