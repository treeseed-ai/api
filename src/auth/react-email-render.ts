import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

type ReactEmailRender = (
	element: unknown,
	options?: { plainText?: boolean },
) => Promise<string> | string;

const reactEmailRender = require('@react-email/render') as { render: ReactEmailRender };

export const render = reactEmailRender.render;
