import { type GovernanceTone } from '../governance-projection.js';

export function safeArray<T = any>(value: unknown): T[] {
    return Array.isArray(value) ? value as T[] : [];
}

export function compact(value: unknown, fallback = ''): string {
    return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

export function latestDate(...values: unknown[]): string | null {
    return values.map((value) => compact(value, '')).find(Boolean) ?? null;
}

export function anchorPart(value: unknown): string {
    return compact(value, 'item').replace(/[^a-zA-Z0-9_-]+/gu, '-');
}

export function titleFromKind(value: unknown, fallback = 'Operational event') {
    const text = compact(value, fallback)
        .replace(/([a-z])([A-Z])/gu, '$1 $2')
        .replace(/[_:-]+/gu, ' ')
        .trim();
    return text.replace(/\b\w/gu, (match) => match.toUpperCase());
}

export function describeState(state: unknown, fallback = 'not recorded'): string {
    return compact(state, fallback).replaceAll('_', ' ');
}

export function toneForSeverity(severity: unknown, state: unknown): GovernanceTone {
    const stateValue = compact(state).toLowerCase();
    if (['approved', 'completed', 'published'].includes(stateValue))
        return 'success';
    if (['rejected', 'failed', 'expired'].includes(stateValue))
        return 'danger';
    const severityValue = compact(severity).toLowerCase();
    if (['critical', 'high'].includes(severityValue))
        return 'danger';
    if (['moderate', 'medium', 'pending'].includes(severityValue))
        return 'warning';
    return 'default';
}

export function toneForState(state: unknown): GovernanceTone {
    const value = compact(state).toLowerCase();
    if (['completed', 'approved', 'published', 'succeeded', 'success', 'active', 'ready', 'selected'].includes(value))
        return 'success';
    if (['pending', 'queued', 'waiting', 'waiting_for_approval', 'under_review', 'approval_required', 'waiting_for_budget'].includes(value))
        return 'warning';
    if (['failed', 'rejected', 'blocked', 'critical', 'expired', 'paused_by_policy'].includes(value))
        return 'danger';
    if (['paused', 'escalated', 'running', 'executing', 'verifying'].includes(value))
        return 'info';
    return 'default';
}
