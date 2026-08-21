#!/usr/bin/env node

import { resolveApiConfig } from '../configuration/runtime-config.ts';
import type { Server } from 'node:http';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createPlatformApiApp } from './app.js';
import { createControlPlanePostgresDatabase } from './control-plane-postgres.js';

function hasRequestBody(method) {
	return method !== 'GET' && method !== 'HEAD';
}

async function honoNodeHandler(app, request, response) {
	const req = request;
	const res = response;
	const requestController = new AbortController();
	req.once('aborted', () => requestController.abort());
	res.once('close', () => requestController.abort());
	const origin = req.headers.host ? `http://${req.headers.host}` : 'http://127.0.0.1';
	const url = new URL(req.url ?? '/', origin);
	const requestInit: RequestInit & { duplex: 'half' } = {
		method: req.method,
		headers: req.headers,
		body: hasRequestBody(req.method) ? req : undefined,
		duplex: 'half',
		signal: requestController.signal,
	};
	const webRequest = new Request(url, requestInit);

	const webResponse = await app.fetch(webRequest);
	res.statusCode = webResponse.status;
	webResponse.headers.forEach((value, key) => {
		res.setHeader(key, value);
	});

	if (!webResponse.body) {
		res.end();
		return;
	}

	Readable.fromWeb(webResponse.body).pipe(res);
}

export type ApiServerInstance = {
	app: ReturnType<typeof createPlatformApiApp>;
	config: ReturnType<typeof resolveApiConfig>;
	server: Server;
	url: string;
	close(): Promise<void>;
};

export async function createApiServer(options: any = {}): Promise<ApiServerInstance> {
	const config = {
		...resolveApiConfig(),
		...(options.config ?? {}),
	};
	const ownedDatabase = options.db
		? null
		: createControlPlanePostgresDatabase(config.apiDatabaseUrl ?? process.env.TREESEED_DATABASE_URL);
	const db = options.db ?? ownedDatabase;
	await db.migrate();
	const app = createPlatformApiApp({
		...options,
		config,
		db,
	});
	const server = createServer((req, res) => {
		void honoNodeHandler(app, req, res).catch((error) => {
			if (req.aborted || res.destroyed) return;
			console.error('[api] Unhandled request failure', error);
			res.statusCode = 500;
			res.end('Internal Server Error');
		});
	});

	await new Promise<void>((resolvePromise) => {
		server.listen(config.port, config.host, () => resolvePromise());
	});

	return {
		app,
		config,
		server,
		url: config.baseUrl,
		async close() {
			await new Promise<void>((resolvePromise, rejectPromise) => {
				server.close((error) => (error ? rejectPromise(error) : resolvePromise()));
			});
			if (ownedDatabase) await ownedDatabase.close();
		},
	};
}

const currentFile = fileURLToPath(import.meta.url);
const entryFile = process.argv[1] ?? '';

if (entryFile === currentFile) {
	const instance = await createApiServer();
	process.stdout.write(`Treeseed API listening on ${instance.url}\n`);
}
