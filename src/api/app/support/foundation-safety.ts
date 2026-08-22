import { timingSafeEqual } from 'node:crypto';
import { SENSITIVE_QUERY_PARAM_PATTERN } from './index.ts';
export function jsonError(c, status, error, details: any = {}) {
    return c.json({
        ok: false,
        error,
        ...details,
    }, { status });
}
export function jsonThrownError(c, error, fallbackStatus = 500) {
    const status = Number(error?.status ?? fallbackStatus);
    const message = error instanceof Error ? error.message : String(error ?? 'Request failed.');
    return jsonError(c, status >= 400 && status < 600 ? status : fallbackStatus, message, {
        code: error?.code ?? 'request_failed',
        details: error?.details,
    });
}
export function redactedRequestTarget(requestUrl) {
    const url = new URL(requestUrl);
    const query = [...url.searchParams.entries()]
        .map(([key, value]) => {
        const safeValue = SENSITIVE_QUERY_PARAM_PATTERN.test(key) ? '[redacted]' : encodeURIComponent(value);
        return `${encodeURIComponent(key)}=${safeValue}`;
    })
        .join('&');
    return `${url.pathname}${query ? `?${query}` : ''}`;
}
export function safeTokenEquals(left, right) {
    if (!left || !right)
        return false;
    const leftBuffer = Buffer.from(String(left));
    const rightBuffer = Buffer.from(String(right));
    return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
