#!/usr/bin/env node

import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { resolveApiConfig } from '@treeseed/sdk/api';
import { createMarketApiApp } from './app.js';

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

export async function createMarketApiServer(options = {}) {
	const config = {
		...resolveApiConfig(),
		...(options.config ?? {}),
	};
	const app = createMarketApiApp({
		...options,
		config,
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
		},
	};
}

const currentFile = fileURLToPath(import.meta.url);
const entryFile = process.argv[1] ?? '';

if (entryFile === currentFile) {
	const instance = await createMarketApiServer();
	process.stdout.write(`Treeseed Market API listening on ${instance.url}\n`);
}
