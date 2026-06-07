import type { APIContext } from 'astro';
import { getSiteAuthConfig } from './config.ts';

interface AuthEmailMessage {
	to: string;
	subject: string;
	text: string;
	html?: string;
}

interface SmtpConfig {
	host: string;
	port: number;
	username: string;
	password: string;
	from: string;
	replyTo: string;
	secure?: string;
}

interface StreamSocketContext {
	socket?: {
		startTls?(): {
			readable: ReadableStream<Uint8Array>;
			writable: WritableStream<Uint8Array>;
		};
	};
	reader: ReadableStreamDefaultReader<Uint8Array>;
	writer: WritableStreamDefaultWriter<Uint8Array>;
}

function toEnvelopeAddress(value: string) {
	const match = value.match(/<([^>]+)>/);
	return (match?.[1] ?? value).trim();
}

function normalizeBody(text: string) {
	return text
		.replace(/\r?\n/g, '\r\n')
		.split('\r\n')
		.map((line) => (line.startsWith('.') ? `.${line}` : line))
		.join('\r\n');
}

function buildMessage(message: AuthEmailMessage, smtp: SmtpConfig) {
	const boundary = `treeseed-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
	const headers = [
		`From: ${smtp.from}`,
		`To: ${message.to}`,
		`Subject: ${message.subject}`,
		'MIME-Version: 1.0',
		message.html
			? `Content-Type: multipart/alternative; boundary="${boundary}"`
			: 'Content-Type: text/plain; charset=UTF-8',
		`Date: ${new Date().toUTCString()}`,
	];

	if (smtp.replyTo) {
		headers.push(`Reply-To: ${smtp.replyTo}`);
	}

	if (!message.html) {
		return `${headers.join('\r\n')}\r\n\r\n${normalizeBody(message.text)}\r\n.`;
	}

	const parts = [
		`--${boundary}`,
		'Content-Type: text/plain; charset=UTF-8',
		'Content-Transfer-Encoding: 8bit',
		'',
		normalizeBody(message.text),
		`--${boundary}`,
		'Content-Type: text/html; charset=UTF-8',
		'Content-Transfer-Encoding: 8bit',
		'',
		normalizeBody(message.html),
		`--${boundary}--`,
	];

	return `${headers.join('\r\n')}\r\n\r\n${parts.join('\r\n')}\r\n.`;
}

function assertSmtpConfigured(smtp: SmtpConfig) {
	if (!smtp.host || !smtp.port || !smtp.from || !toEnvelopeAddress(smtp.from)) {
		throw new Error('SMTP is not fully configured for auth email delivery.');
	}
}

function assertSmtpResponse(response: { code: number; raw: string }, acceptedCodes: number[]) {
	if (!acceptedCodes.includes(response.code)) {
		throw new Error(`SMTP command failed: ${response.raw}`);
	}
}

function base64(value: string) {
	return btoa(value);
}

function authPlainPayload(username: string, password: string) {
	return base64(`\0${username}\0${password}`);
}

async function readStreamSmtpResponse(reader: ReadableStreamDefaultReader<Uint8Array>) {
	const decoder = new TextDecoder();
	let buffer = '';

	while (true) {
		const { value, done } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		const lines = buffer.split('\r\n').filter(Boolean);
		const lastLine = lines.at(-1);
		if (lastLine && /^\d{3} /.test(lastLine)) {
			return {
				code: Number.parseInt(lastLine.slice(0, 3), 10),
				raw: buffer,
			};
		}
	}

	throw new Error('SMTP connection closed unexpectedly.');
}

async function sendStreamCommand(context: StreamSocketContext, command: string) {
	await context.writer.write(new TextEncoder().encode(`${command}\r\n`));
	return readStreamSmtpResponse(context.reader);
}

async function authenticateStreamSmtp(context: StreamSocketContext, smtp: SmtpConfig) {
	const plain = await sendStreamCommand(context, `AUTH PLAIN ${authPlainPayload(smtp.username, smtp.password)}`);
	if (plain.code === 235) return;
	if (![500, 502, 504].includes(plain.code)) {
		assertSmtpResponse(plain, [235]);
	}
	assertSmtpResponse(await sendStreamCommand(context, 'AUTH LOGIN'), [334]);
	assertSmtpResponse(await sendStreamCommand(context, base64(smtp.username)), [334]);
	assertSmtpResponse(await sendStreamCommand(context, base64(smtp.password)), [235]);
}

async function sendWithCloudflareSockets(message: AuthEmailMessage, smtp: SmtpConfig, siteUrl: string) {
	const { connect } = await import('cloudflare:sockets');
	const secureMode = String(smtp.secure ?? '').toLowerCase();
	const secureTransport = ['true', '1', 'tls', 'ssl', 'on'].includes(secureMode)
		? 'on'
		: ['starttls', 'required'].includes(secureMode)
			? 'starttls'
			: ['false', '0', 'plain', 'off'].includes(secureMode)
				? 'off'
				: smtp.port === 465 ? 'on' : smtp.port === 587 ? 'starttls' : 'off';
	let socket = connect(
		{ hostname: smtp.host, port: smtp.port },
		{ secureTransport },
	);
	let context: StreamSocketContext = {
		socket,
		reader: socket.readable.getReader(),
		writer: socket.writable.getWriter(),
	};
	const hostname = new URL(siteUrl).hostname || 'localhost';

	assertSmtpResponse(await readStreamSmtpResponse(context.reader), [220]);
	assertSmtpResponse(await sendStreamCommand(context, `EHLO ${hostname}`), [250]);

	if (secureTransport === 'starttls') {
		assertSmtpResponse(await sendStreamCommand(context, 'STARTTLS'), [220]);
		if (!context.socket?.startTls) {
			throw new Error('SMTP socket does not support STARTTLS.');
		}
		context.reader.releaseLock();
		context.writer.releaseLock();
		socket = context.socket.startTls();
		context = {
			socket,
			reader: socket.readable.getReader(),
			writer: socket.writable.getWriter(),
		};
		assertSmtpResponse(await sendStreamCommand(context, `EHLO ${hostname}`), [250]);
	}

	if (smtp.username) {
		await authenticateStreamSmtp(context, smtp);
	}

	assertSmtpResponse(await sendStreamCommand(context, `MAIL FROM:<${toEnvelopeAddress(smtp.from)}>`), [250]);
	assertSmtpResponse(await sendStreamCommand(context, `RCPT TO:<${message.to}>`), [250, 251]);
	assertSmtpResponse(await sendStreamCommand(context, 'DATA'), [354]);
	assertSmtpResponse(await sendStreamCommand(context, buildMessage(message, smtp)), [250]);
	await sendStreamCommand(context, 'QUIT').catch(() => null);
	await context.writer.close().catch(() => null);
}

async function sendWithNodeSockets(message: AuthEmailMessage, smtp: SmtpConfig, siteUrl: string) {
	const netSpecifier = 'node:net';
	const tlsSpecifier = 'node:tls';
	const net = await import(/* @vite-ignore */ netSpecifier) as typeof import('node:net');
	const tls = await import(/* @vite-ignore */ tlsSpecifier) as typeof import('node:tls');
	const secureMode = String(smtp.secure ?? '').toLowerCase();
	const secureTransport = ['true', '1', 'tls', 'ssl', 'on'].includes(secureMode)
		? 'on'
		: ['starttls', 'required'].includes(secureMode)
			? 'starttls'
			: ['false', '0', 'plain', 'off'].includes(secureMode)
				? 'off'
				: smtp.port === 465 ? 'on' : smtp.port === 587 ? 'starttls' : 'off';
	let socket = secureTransport === 'on'
		? tls.connect({ host: smtp.host, port: smtp.port, servername: smtp.host })
		: net.connect({ host: smtp.host, port: smtp.port });
	socket.setEncoding('utf8');
	const pending: Array<(value: { code: number; raw: string }) => void> = [];
	const failures: Array<(error: Error) => void> = [];
	let buffer = '';

	function attachSocketListeners() {
		socket.on('data', (chunk) => {
		buffer += String(chunk);
		const lines = buffer.split('\r\n').filter(Boolean);
		const lastLine = lines.at(-1);
		if (!lastLine || !/^\d{3} /.test(lastLine)) return;
		const response = {
			code: Number.parseInt(lastLine.slice(0, 3), 10),
			raw: buffer,
		};
		buffer = '';
		pending.shift()?.(response);
		});
		socket.on('error', (error) => {
			failures.splice(0).forEach((reject) => reject(error));
		});
	}
	attachSocketListeners();

	function readResponse() {
		return new Promise<{ code: number; raw: string }>((resolve, reject) => {
			pending.push(resolve);
			failures.push(reject);
		});
	}

	async function send(command: string) {
		socket.write(`${command}\r\n`);
		return readResponse();
	}

	async function authenticate() {
		const plain = await send(`AUTH PLAIN ${authPlainPayload(smtp.username, smtp.password)}`);
		if (plain.code === 235) return;
		if (![500, 502, 504].includes(plain.code)) {
			assertSmtpResponse(plain, [235]);
		}
		assertSmtpResponse(await send('AUTH LOGIN'), [334]);
		assertSmtpResponse(await send(base64(smtp.username)), [334]);
		assertSmtpResponse(await send(base64(smtp.password)), [235]);
	}

	const hostname = new URL(siteUrl).hostname || 'localhost';
	assertSmtpResponse(await readResponse(), [220]);
	assertSmtpResponse(await send(`EHLO ${hostname}`), [250]);
	if (secureTransport === 'starttls') {
		assertSmtpResponse(await send('STARTTLS'), [220]);
		socket.removeAllListeners('data');
		socket.removeAllListeners('error');
		socket = tls.connect({ socket, servername: smtp.host });
		socket.setEncoding('utf8');
		buffer = '';
		attachSocketListeners();
		assertSmtpResponse(await send(`EHLO ${hostname}`), [250]);
	}
	if (smtp.username) {
		await authenticate();
	}
	assertSmtpResponse(await send(`MAIL FROM:<${toEnvelopeAddress(smtp.from)}>`), [250]);
	assertSmtpResponse(await send(`RCPT TO:<${message.to}>`), [250, 251]);
	assertSmtpResponse(await send('DATA'), [354]);
	assertSmtpResponse(await send(buildMessage(message, smtp)), [250]);
	await send('QUIT').catch(() => null);
	socket.end();
}

function logConsoleFallback(message: AuthEmailMessage) {
	console.info(`[auth-email] ${message.subject} for ${message.to}\n${message.text}`);
}

function errorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

export function authEmailDeliveryFailureReason(error: unknown) {
	const message = errorMessage(error).toLowerCase();
	if (/not fully configured|must be configured/u.test(message)) return 'not_configured';
	if (/auth|535|credentials|password|username/u.test(message)) return 'auth_failed';
	if (/mail from|sender|550|553/u.test(message)) return 'sender_rejected';
	if (/rcpt to|recipient|relay/u.test(message)) return 'recipient_rejected';
	if (/starttls|tls|certificate/u.test(message)) return 'tls_failed';
	if (/timeout|timed out|connect|closed unexpectedly|network|unreachable/u.test(message)) return 'connection_failed';
	return 'smtp_failed';
}

export function authEmailDeliveryFailureDetail(error: unknown) {
	return errorMessage(error)
		.replace(/[\r\n\t]+/gu, ' ')
		.replace(/\s+/gu, ' ')
		.slice(0, 500);
}

function isLocalAuthUrl(value: string) {
	const hostname = new URL(value).hostname;
	return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0';
}

function isLocalSmtpHost(value: string) {
	return value === 'localhost' || value === '127.0.0.1' || value === '0.0.0.0';
}

export function canDeliverAuthEmail(context: Pick<APIContext, 'locals'> | undefined) {
	const config = getSiteAuthConfig(context);
	const smtp = config.authEmail;
	return Boolean(smtp.host && smtp.port && smtp.from) || isLocalAuthUrl(config.betterAuthBaseUrl);
}

export function authEmailConfigurationMessage() {
	return 'Configure SMTP email before using registration, email verification, or password reset.';
}

export async function sendAuthEmail(context: Pick<APIContext, 'locals'> | undefined, message: AuthEmailMessage) {
	const config = getSiteAuthConfig(context);
	const smtp = config.authEmail;

	if (!smtp.host || !smtp.port || !smtp.from) {
		if (!isLocalAuthUrl(config.betterAuthBaseUrl)) {
			throw new Error('SMTP must be configured before auth email can be delivered outside local development.');
		}
		logConsoleFallback(message);
		return;
	}

	assertSmtpConfigured(smtp);

	if (isLocalAuthUrl(config.betterAuthBaseUrl) && isLocalSmtpHost(smtp.host)) {
		try {
			await sendWithNodeSockets(message, smtp, config.siteBaseUrl);
			return;
		} catch (nodeError) {
			console.info(`[auth-email] Local SMTP unavailable (${errorMessage(nodeError)}); using console fallback.`);
			logConsoleFallback(message);
			return;
		}
	}

	try {
		await sendWithCloudflareSockets(message, smtp, config.siteBaseUrl);
		return;
	} catch (cloudflareError) {
		try {
			await sendWithNodeSockets(message, smtp, config.siteBaseUrl);
			return;
		} catch (nodeError) {
			if (isLocalAuthUrl(config.betterAuthBaseUrl)) {
				console.info(`[auth-email] SMTP delivery failed (${errorMessage(cloudflareError)}; ${errorMessage(nodeError)}); using console fallback.`);
				logConsoleFallback(message);
				return;
			}
			throw new Error(`SMTP delivery failed: ${errorMessage(cloudflareError)}; ${errorMessage(nodeError)}`);
		}
	}
}
