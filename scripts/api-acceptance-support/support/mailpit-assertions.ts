import { fetchWithTimeout } from '../index.js';

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

function mailpitMessageId(value) {
    if (!value || typeof value !== 'object')
        return '';
    return String(value.ID ?? value.Id ?? value.id ?? '');
}

function mailpitMessageBody(value) {
    if (!value || typeof value !== 'object')
        return '';
    return `${value.HTML ?? value.Html ?? value.html ?? ''}\n${value.Text ?? value.text ?? ''}`.replace(/&amp;/gu, '&');
}

function deliveredLinkOrigin(value) {
    const link = value.match(/https?:\/\/[^"' <>\n]+(?:\/auth\/(?:confirm-email|reset-password)\?[^"' <>\n]+|\/team-invites\/[^"' <>\n]+\/accept)/u)?.[0];
    return link ? new URL(link).origin : '';
}

export async function assertMailpitExpectation(expectation, environment = 'local') {
    if (!expectation)
        return [];
    if (environment !== 'local')
        return [];
    const url = String(expectation.url ?? process.env.TREESEED_MAILPIT_URL ?? 'http://127.0.0.1:8025').replace(/\/+$/u, '');
    const to = String(expectation.to ?? '').toLowerCase();
    const subjectIncludes = expectation.subjectIncludes ? String(expectation.subjectIncludes).toLowerCase() : '';
    const linkOrigin = expectation.linkOrigin ? new URL(String(expectation.linkOrigin)).origin : '';
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
                const found = mailpitMessages(list).find((message) => {
                    const recipients = mailpitMessageRecipients(message).map((entry) => entry.toLowerCase());
                    const subject = mailpitMessageSubject(message).toLowerCase();
                    return (!to || recipients.includes(to)) && (!subjectIncludes || subject.includes(subjectIncludes));
                });
                if (found && !linkOrigin)
                    return [];
                if (found) {
                    const id = mailpitMessageId(found);
                    const messageResponse = await fetchWithTimeout(`${url}/api/v1/message/${encodeURIComponent(id)}`, {}, `GET Mailpit message ${id}`);
                    if (messageResponse.ok) {
                        const message = await messageResponse.json();
                        const actualOrigin = deliveredLinkOrigin(mailpitMessageBody(message));
                        if (actualOrigin === linkOrigin)
                            return [];
                        lastError = actualOrigin
                            ? `Mailpit link origin ${actualOrigin} does not match ${linkOrigin}.`
                            : 'Mailpit message does not contain a supported absolute service link.';
                    }
                    else {
                        lastError = `Mailpit message ${id} returned HTTP ${messageResponse.status}.`;
                    }
                }
                else {
                    lastError = `No Mailpit message found${to ? ` for ${to}` : ''}.`;
                }
            }
        }
        catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return [`Mailpit expectation failed: ${lastError}`];
}
