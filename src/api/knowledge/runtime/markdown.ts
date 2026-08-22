import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkMdx from 'remark-mdx';
import type { SanitizedKnowledgeHtml } from '@treeseed/sdk/knowledge';

type MarkdownNode = {
	type?: string;
	value?: string;
	url?: string;
	depth?: number;
	ordered?: boolean;
	start?: number | null;
	children?: MarkdownNode[];
	name?: string;
	attributes?: Array<{ type?: string; name?: string; value?: string | null }>;
};

const componentElements: Record<string, { tag: string; className: string }> = {
	Aside: { tag: 'aside', className: 'ts-knowledge-aside' },
	Badge: { tag: 'span', className: 'ts-knowledge-badge' },
	Card: { tag: 'section', className: 'ts-knowledge-card' },
	CardGrid: { tag: 'div', className: 'ts-knowledge-card-grid' },
	Code: { tag: 'code', className: 'ts-knowledge-code' },
	Steps: { tag: 'ol', className: 'ts-knowledge-steps' },
	TabItem: { tag: 'section', className: 'ts-knowledge-tab' },
	Tabs: { tag: 'div', className: 'ts-knowledge-tabs' },
};
const safeMdxComponents = new Set(Object.keys(componentElements));

export function validateKnowledgeMarkdown(markdown: string): string {
	const body = String(markdown ?? '').replaceAll('\r\n', '\n').trim();
	let tree: MarkdownNode;
	try {
		tree = unified().use(remarkParse).use(remarkMdx).parse(body) as MarkdownNode;
	} catch {
		throw new Error('Knowledge Markdown could not be parsed safely.');
	}
	const visit = (node: MarkdownNode) => {
		if (node.type === 'mdxjsEsm') throw new Error('Executable MDX imports and exports are not allowed.');
		if (node.type === 'mdxFlowExpression' || node.type === 'mdxTextExpression') {
			throw new Error('Executable MDX expressions are not allowed.');
		}
		if (node.type === 'html') throw new Error('Raw HTML is not allowed.');
		if ((node.type === 'link' || node.type === 'image') && !safeHref(node.url)) {
			throw new Error('Unsafe URLs are not allowed.');
		}
		if (node.type === 'mdxJsxFlowElement' || node.type === 'mdxJsxTextElement') {
			const name = String(node.name ?? '');
			if (!safeMdxComponents.has(name)) throw new Error(`The MDX component ${name} is not allowed.`);
			for (const attribute of node.attributes ?? []) {
				if (attribute.type !== 'mdxJsxAttribute' || !['title', 'label', 'type'].includes(String(attribute.name))
					|| (attribute.value !== null && typeof attribute.value !== 'string')) {
					throw new Error('Executable or unsupported MDX properties are not allowed.');
				}
			}
		}
		for (const child of node.children ?? []) visit(child);
	};
	visit(tree);
	return body;
}

const escapeHtml = (value: string) => value
	.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
	.replaceAll('"', '&quot;').replaceAll("'", '&#39;');

function safeHref(value: string | undefined) {
	const href = String(value ?? '').trim();
	if (!href || /[\u0000-\u001f\\]/u.test(href) || href.startsWith('//')) return null;
	if (href.startsWith('/') || href.startsWith('#') || !/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(href)) return href;
	try {
		const parsed = new URL(href);
		return ['http:', 'https:', 'mailto:'].includes(parsed.protocol) ? parsed.href : null;
	} catch { return null; }
}

function renderChildren(node: MarkdownNode): string {
	return (node.children ?? []).map(renderNode).join('');
}

function renderMdxComponent(node: MarkdownNode) {
	const element = componentElements[String(node.name ?? '')];
	if (!element) return '';
	const labels = (node.attributes ?? []).filter((attribute) => attribute.type === 'mdxJsxAttribute'
		&& ['title', 'label', 'type'].includes(String(attribute.name)) && typeof attribute.value === 'string')
		.map((attribute) => ` data-${escapeHtml(String(attribute.name))}="${escapeHtml(String(attribute.value))}"`).join('');
	return `<${element.tag} class="${element.className}"${labels}>${renderChildren(node)}</${element.tag}>`;
}

function renderNode(node: MarkdownNode): string {
	switch (node.type) {
		case 'root': return renderChildren(node);
		case 'text': return escapeHtml(node.value ?? '');
		case 'paragraph': return `<p>${renderChildren(node)}</p>`;
		case 'heading': {
			const depth = Math.min(6, Math.max(2, Number(node.depth) || 2));
			return `<h${depth}>${renderChildren(node)}</h${depth}>`;
		}
		case 'strong': return `<strong>${renderChildren(node)}</strong>`;
		case 'emphasis': return `<em>${renderChildren(node)}</em>`;
		case 'delete': return `<del>${renderChildren(node)}</del>`;
		case 'inlineCode': return `<code>${escapeHtml(node.value ?? '')}</code>`;
		case 'code': return `<pre><code>${escapeHtml(node.value ?? '')}</code></pre>`;
		case 'blockquote': return `<blockquote>${renderChildren(node)}</blockquote>`;
		case 'break': return '<br />';
		case 'thematicBreak': return '<hr />';
		case 'list': {
			const tag = node.ordered ? 'ol' : 'ul';
			const start = node.ordered && node.start && node.start !== 1 ? ` start="${Number(node.start)}"` : '';
			return `<${tag}${start}>${(node.children ?? []).map((item) => `<li>${renderChildren(item)}</li>`).join('')}</${tag}>`;
		}
		case 'listItem': return renderChildren(node);
		case 'link': {
			const href = safeHref(node.url);
			if (!href) return renderChildren(node);
			const external = /^https?:/iu.test(href);
			return `<a href="${escapeHtml(href)}"${external ? ' rel="noreferrer noopener" target="_blank"' : ''}>${renderChildren(node)}</a>`;
		}
		case 'mdxJsxFlowElement':
		case 'mdxJsxTextElement': return renderMdxComponent(node);
		case 'mdxFlowExpression':
		case 'mdxTextExpression':
		case 'mdxjsEsm': return '';
		case 'html':
		case 'image':
		case 'imageReference': return '';
		default: return renderChildren(node);
	}
}

export function renderKnowledgeMarkdown(markdown: string): SanitizedKnowledgeHtml {
	const tree = unified().use(remarkParse).use(remarkMdx).parse(String(markdown ?? '')) as MarkdownNode;
	return renderNode(tree) as SanitizedKnowledgeHtml;
}
