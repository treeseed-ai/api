import { resolve } from 'node:path';
import { fetchWithTimeout } from './index.js';

export function mailpitMessages(value) {
    if (!value || typeof value !== 'object')
        return [];
    const record = value;
    const messages = record.messages ?? record.Messages;
    return Array.isArray(messages) ? messages : [];
}

export function mailpitMessageSubject(value) {
    if (!value || typeof value !== 'object')
        return '';
    const record = value;
    return String(record.Subject ?? record.subject ?? '');
}

export function mailpitMessageRecipients(value) {
    if (!value || typeof value !== 'object')
        return [];
    const record = value;
    const recipients = record.To ?? record.to ?? record.Recipients ?? record.recipients;
    if (!Array.isArray(recipients))
        return [];
    return recipients.map((recipient) => {
        if (typeof recipient === 'string')
            return recipient;
        if (!recipient || typeof recipient !== 'object')
            return '';
        const entry = recipient;
        return String(entry.Address ?? entry.address ?? entry.Email ?? entry.email ?? '');
    }).filter(Boolean);
}

export async function assertMailpitExpectation(expectation, environment = 'local') {
    if (!expectation)
        return [];
    if (environment !== 'local')
        return [];
    const url = String(expectation.url ?? process.env.TREESEED_MAILPIT_URL ?? 'http://127.0.0.1:8025').replace(/\/+$/u, '');
    const to = String(expectation.to ?? '').toLowerCase();
    const subjectIncludes = expectation.subjectIncludes ? String(expectation.subjectIncludes).toLowerCase() : '';
    const timeoutMs = Number(expectation.timeoutMs ?? 5000);
    const started = Date.now();
    let lastError = '';
    while (Date.now() - started <= timeoutMs) {
        try {
            const response = await fetchWithTimeout(`${url}/api/v1/messages`, {}, 'GET Mailpit messages');
            if (!response.ok) {
                lastError = `Mailpit returned HTTP ${response.status}`;
            }
            else {
                const list = await response.json();
                const found = mailpitMessages(list).some((message) => {
                    const recipients = mailpitMessageRecipients(message).map((entry) => entry.toLowerCase());
                    const subject = mailpitMessageSubject(message).toLowerCase();
                    return (!to || recipients.includes(to)) && (!subjectIncludes || subject.includes(subjectIncludes));
                });
                if (found)
                    return [];
                lastError = `No Mailpit message found${to ? ` for ${to}` : ''}.`;
            }
        }
        catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return [`Mailpit expectation failed: ${lastError}`];
}
