export async function mailpitToken(origin: string, email: string, subject: string, parameter: string, timeoutMs = 15_000) {
	const url = await mailpitUrl(origin, email, subject, timeoutMs);
	const found = `${url.search}${url.hash}`.match(new RegExp(`[?&](?:amp;)?${parameter}=([^&\\s<]+)`, 'u'));
	if (!found?.[1]) throw new Error(`${subject} email omitted ${parameter}.`);
	return decodeURIComponent(found[1].replace(/&amp;$/u, ''));
}

export async function mailpitUrl(origin: string, email: string, subject: string, timeoutMs = 15_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const list = await fetch(new URL(`/api/v1/messages?query=${encodeURIComponent(`to:${email}`)}`, origin));
		if (!list.ok) throw new Error(`Mailpit message query returned HTTP ${list.status}.`);
		const payload = await list.json() as { messages?: Array<{ ID?: string; Subject?: string }> };
		const match = payload.messages?.find((entry) => entry.Subject === subject && entry.ID);
		if (match?.ID) {
			const response = await fetch(new URL(`/api/v1/message/${encodeURIComponent(match.ID)}`, origin));
			const message = await response.json() as { Text?: string; HTML?: string };
			const source = `${message.Text ?? ''}\n${message.HTML ?? ''}`.replaceAll('&amp;', '&');
			const found = source.match(/https:\/\/[^\s<"]+/u);
			if (found?.[0]) return new URL(found[0]);
		}
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
	}
	throw new Error(`Timed out waiting for ${subject} email to ${email}.`);
}
