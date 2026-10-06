import { timingSafeEqual } from 'node:crypto';
import { SENSITIVE_QUERY_PARAM_PATTERN } from './index.ts';
import type { Context } from 'hono';
import { controlPlaneErrorStatus } from '../../control-plane/catalog/operation-registry.ts';
export function jsonError(c: Context, status: unknown, error: unknown, details: unknown = {}) {
    return c.json(Object.assign({
        ok: false,
        error,
    }, details), { status: controlPlaneErrorStatus(status) });
}
export function jsonThrownError(c: Context, error: unknown, fallbackStatus: unknown = 500) {
    const failure = error && (typeof error === 'object' || typeof error === 'function') ? error as Record<string, unknown> : {};
    const status = controlPlaneErrorStatus(failure.status ?? fallbackStatus);
    const message = error instanceof Error ? error.message : String(error ?? 'Request failed.');
    return jsonError(c, status, message, {
        code: failure.code ?? 'request_failed',
        details: failure.details,
    });
}
export function redactedRequestTarget(requestUrl: string | URL) {
    const url = new URL(requestUrl);
    const query = [...url.searchParams.entries()]
        .map(([key, value]) => {
        const safeValue = SENSITIVE_QUERY_PARAM_PATTERN.test(key) ? '[redacted]' : encodeURIComponent(value);
        return `${encodeURIComponent(key)}=${safeValue}`;
    })
        .join('&');
    return `${url.pathname}${query ? `?${query}` : ''}`;
}
export function safeTokenEquals(left: unknown, right: unknown) {
    if (!left || !right)
        return false;
    const leftBuffer = Buffer.from(String(left));
    const rightBuffer = Buffer.from(String(right));
    return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
