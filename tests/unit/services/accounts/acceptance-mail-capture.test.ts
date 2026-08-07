import { connect } from 'node:net';
import { afterEach,describe,expect,it } from 'vitest';
import { startAcceptanceMailCapture } from '../../../../scripts/packages/acceptance-mail-capture.ts';

const captures: Array<Awaited<ReturnType<typeof startAcceptanceMailCapture>>> = [];

type MessageList = {
	messages: Array<{ ID: string; Subject: string; To: Array<{ Address: string }> }>;
};

type MessageDetail = {
	Text: string;
};

afterEach(async () => {
	await Promise.all(captures.splice(0).map((capture) => capture.close()));
});

describe('isolated acceptance mail capture', () => {
	it('accepts SMTP and exposes Mailpit-compatible message APIs', async () => {
		const capture = await startAcceptanceMailCapture();
		captures.push(capture);
		const socket = connect(capture.smtpPort, '127.0.0.1');
		socket.setEncoding('utf8');
		await new Promise<void>((resolvePromise, rejectPromise) => {
			socket.once('error', rejectPromise);
			socket.once('data', () => resolvePromise());
		});
		socket.write('EHLO localhost\r\nMAIL FROM:<auth@treeseed.local>\r\nRCPT TO:<person@example.com>\r\nDATA\r\n');
		await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
		socket.write('Subject: Confirm account\r\nTo: person@example.com\r\n\r\nVisit http://127.0.0.1:4321/auth/confirm-email?token=test\r\n.\r\n');
		await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
		socket.end();

		const list = await fetch(`${capture.httpUrl}/api/v1/messages`).then((response) => response.json()) as MessageList;
		expect(list.messages).toHaveLength(1);
		expect(list.messages[0]).toMatchObject({ Subject: 'Confirm account', To: [{ Address: 'person@example.com' }] });
		const message = await fetch(`${capture.httpUrl}/api/v1/message/${list.messages[0].ID}`).then((response) => response.json()) as MessageDetail;
		expect(message.Text).toContain('/auth/confirm-email?token=test');
	});
});
