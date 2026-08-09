import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';

type CapturedMessage = {
	ID: string;
	Subject: string;
	To: Array<{ Address: string }>;
	Text: string;
	HTML: string;
};

function header(message: string, name: string) {
	const match = message.match(new RegExp(`^${name}:\\s*(.+)$`, 'imu'));
	return match?.[1]?.trim() ?? '';
}

function address(value: string) {
	return value.match(/<([^>]+)>/u)?.[1] ?? value.trim();
}

function listen(server: ReturnType<typeof createHttpServer> | ReturnType<typeof createNetServer>) {
	return new Promise<number>((resolvePromise, rejectPromise) => {
		server.once('error', rejectPromise);
		server.listen(0, '127.0.0.1', () => {
			server.off('error', rejectPromise);
			const bound = server.address();
			if (!bound || typeof bound === 'string') rejectPromise(new Error('Acceptance mail capture address is unavailable.'));
			else resolvePromise(bound.port);
		});
	});
}

function close(server: ReturnType<typeof createHttpServer> | ReturnType<typeof createNetServer>) {
	return new Promise<void>((resolvePromise, rejectPromise) => {
		server.close((error) => error ? rejectPromise(error) : resolvePromise());
	});
}

export async function startAcceptanceMailCapture() {
	const messages: CapturedMessage[] = [];
	let nextId = 1;
	const smtp = createNetServer((socket) => {
		let buffer = '';
		let dataMode = false;
		let recipient = '';
		socket.setEncoding('utf8');
		socket.write('220 acceptance-mail-capture ESMTP\r\n');
		socket.on('data', (chunk) => {
			buffer += chunk;
			while (buffer) {
				if (dataMode) {
					const end = buffer.indexOf('\r\n.\r\n');
					if (end < 0) return;
					const raw = buffer.slice(0, end);
					buffer = buffer.slice(end + 5);
					const to = recipient || address(header(raw, 'To'));
					messages.unshift({
						ID: String(nextId++),
						Subject: header(raw, 'Subject'),
						To: to ? [{ Address: to }] : [],
						Text: raw,
						HTML: raw,
					});
					dataMode = false;
					socket.write('250 2.0.0 accepted\r\n');
					continue;
				}
				const end = buffer.indexOf('\r\n');
				if (end < 0) return;
				const command = buffer.slice(0, end);
				buffer = buffer.slice(end + 2);
				if (/^(?:EHLO|HELO)\b/iu.test(command)) socket.write('250-acceptance-mail-capture\r\n250 OK\r\n');
				else if (/^RCPT TO:/iu.test(command)) {
					recipient = address(command.slice(command.indexOf(':') + 1));
					socket.write('250 2.1.5 accepted\r\n');
				} else if (/^DATA$/iu.test(command)) {
					dataMode = true;
					socket.write('354 End data with <CRLF>.<CRLF>\r\n');
				} else if (/^QUIT$/iu.test(command)) {
					socket.end('221 2.0.0 closing connection\r\n');
				} else socket.write('250 2.0.0 OK\r\n');
			}
		});
	});
	const smtpPort = await listen(smtp);
	const http = createHttpServer((request, response) => {
		response.setHeader('content-type', 'application/json');
		if (request.url === '/api/v1/messages') {
			response.end(JSON.stringify({ messages }));
			return;
		}
		const id = request.url?.match(/^\/api\/v1\/message\/([^/?]+)/u)?.[1];
		const message = id ? messages.find((entry) => entry.ID === decodeURIComponent(id)) : null;
		response.statusCode = message ? 200 : 404;
		response.end(JSON.stringify(message ?? { error: 'message_not_found' }));
	});
	let httpPort: number;
	try {
		httpPort = await listen(http);
	} catch (error) {
		await close(smtp);
		throw error;
	}
	return {
		smtpPort,
		httpUrl: `http://127.0.0.1:${httpPort}`,
		async close() {
			await Promise.all([close(http), close(smtp)]);
		},
	};
}
