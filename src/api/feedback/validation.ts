import { createHash } from 'node:crypto';
import { FEEDBACK_CAPTURE_VERSION, isFeedbackType, type FeedbackClientContext, type FeedbackSubmissionContext } from '@treeseed/sdk/feedback';

export const MAX_FEEDBACK_MESSAGE_LENGTH = 4000;
export const MAX_FEEDBACK_SCREENSHOT_BYTES = 8 * 1024 * 1024;

export function cleanString(value: unknown, maxLength = 500) {
	return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

export function parseFeedbackBody(body: any) {
	const type = body?.type;
	if (!isFeedbackType(type)) return { error: 'Choose a supported feedback type.', field: 'type' } as const;
	const message = cleanString(body?.message, MAX_FEEDBACK_MESSAGE_LENGTH);
	if (!message) return { error: 'Tell us what happened or what could be better.', field: 'message' } as const;
	const supplied = body?.context && typeof body.context === 'object' ? body.context : {};
	const context: FeedbackSubmissionContext = {
		canonicalPath: cleanString(supplied.canonicalPath, 600) || '/',
		routePattern: cleanString(supplied.routePattern, 300) || undefined,
		capabilityId: cleanString(supplied.capabilityId, 160) || undefined,
		teamId: cleanString(supplied.teamId, 160) || undefined,
		projectId: cleanString(supplied.projectId, 160) || undefined,
		environment: ['local', 'staging', 'production'].includes(supplied.environment) ? supplied.environment : undefined,
		buildId: cleanString(supplied.buildId, 180) || undefined,
		revision: cleanString(supplied.revision, 180) || undefined,
		source: supplied.source === 'help' ? 'help' : 'page',
		knowledgePageId: cleanString(supplied.knowledgePageId, 180) || undefined,
	};
	const viewport = body?.client?.viewport ?? {};
	const client: FeedbackClientContext = {
		userAgent: cleanString(body?.client?.userAgent, 500) || undefined,
		viewport: {
			width: Math.max(0, Math.min(10000, Number(viewport.width) || 0)),
			height: Math.max(0, Math.min(10000, Number(viewport.height) || 0)),
			devicePixelRatio: Math.max(0.5, Math.min(8, Number(viewport.devicePixelRatio) || 1)),
		},
		locale: cleanString(body?.client?.locale, 80) || undefined,
		timeZone: cleanString(body?.client?.timeZone, 120) || undefined,
		theme: cleanString(body?.client?.theme ?? body?.client?.appearance, 120) || undefined,
		reducedMotion: body?.client?.reducedMotion === true,
	};
	return { value: { type, message, allowContact: body?.allowContact === true, context, client, screenshot: body?.screenshot } } as const;
}

export function parseScreenshot(value: any) {
	if (!value) return { value: null } as const;
	if (value.redacted !== true || value.redactionVersion !== FEEDBACK_CAPTURE_VERSION) return { error: 'Capture redaction evidence is invalid.' } as const;
	const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/u.exec(cleanString(value.dataUrl, 12_000_000));
	if (!match) return { error: 'Screenshot must be a redacted PNG capture.' } as const;
	const bytes = Buffer.from(match[1], 'base64');
	if (!bytes.length || bytes.length > MAX_FEEDBACK_SCREENSHOT_BYTES) return { error: 'Screenshot is too large.' } as const;
	const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
	if (!png || bytes.length < 24) return { error: 'Screenshot content is not a valid PNG.' } as const;
	const width = bytes.readUInt32BE(16);
	const height = bytes.readUInt32BE(20);
	if (!width || !height || width > 10000 || height > 10000) return { error: 'Screenshot dimensions are invalid.' } as const;
	const digest = createHash('sha256').update(bytes).digest('hex');
	if (cleanString(value.digest, 64) !== digest) return { error: 'Screenshot digest does not match its content.' } as const;
	return { value: { bytes, width, height, digest, redactionVersion: FEEDBACK_CAPTURE_VERSION, maskedRegionCount: Math.max(0, Number(value.maskedRegionCount) || 0) } } as const;
}

export function derivedCanonicalPath(request: Request, fallback: string) {
	const trustedPath = request.headers.get('x-treeseed-feedback-path');
	if (trustedPath?.startsWith('/') && !trustedPath.startsWith('//')) return trustedPath.slice(0, 600);
	const referer = request.headers.get('referer');
	if (!referer) return fallback.startsWith('/') ? fallback : '/';
	try {
		const source = new URL(referer);
		const target = new URL(request.url);
		return source.origin === target.origin ? `${source.pathname}${source.search}`.slice(0, 600) : fallback;
	} catch { return fallback; }
}
