#!/usr/bin/env node
// @ts-nocheck

import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { resolveApiConfig } from '@treeseed/sdk/api';
import type { Hono } from 'hono';
import { createApiApp } from './app.js';
import { createMarketPostgresDatabase } from './market-postgres.js';

function hasRequestBody(method) {
	return method !== 'GET' && method !== 'HEAD';
}

async function honoNodeHandler(app, request, response) {
	const req = request;
	const res = response;
	const origin = req.headers.host ? `http://${req.headers.host}` : 'http://127.0.0.1';
	const url = new URL(req.url ?? '/', origin);
	const webRequest = new Request(url, {
		method: req.method,
		headers: req.headers,
		body: hasRequestBody(req.method) ? req : undefined,
		duplex: 'half',
	});

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
	app: Hono;
	config: ReturnType<typeof resolveApiConfig>;
	server: Server;
	url: string;
	close(): Promise<void>;
};

export async function createApiServer(options = {}): Promise<ApiServerInstance> {
	const config = {
		...resolveApiConfig(),
		...(options.config ?? {}),
	};
	const ownedDatabase = options.db
		? null
		: createMarketPostgresDatabase(config.apiDatabaseUrl ?? process.env.TREESEED_DATABASE_URL);
	const db = options.db ?? ownedDatabase;
	await db.migrate();
	const app = createApiApp({
		...options,
		config,
		db,
	});
	const server = createServer((req, res) => {
		void honoNodeHandler(app, req, res);
	});

	await new Promise((resolvePromise) => {
		server.listen(config.port, config.host, () => resolvePromise());
	});

	return {
		app,
		config,
		server,
		url: config.baseUrl,
		async close() {
			await new Promise((resolvePromise, rejectPromise) => {
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
