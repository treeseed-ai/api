import { existsSync } from 'node:fs';
import { mkdir,readFile,rm,writeFile } from 'node:fs/promises';
import { isAbsolute,relative,resolve,sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { contentRelationPolicy } from '../../../../market/content/content-relations.js';
import { enumValue,LOCAL_DECISION_TYPE_VALUES,optionalTrimmedString,unwrapOperationPayload,yamlLines,yamlScalar } from '../index.ts';
export const LOCAL_CONTENT_COLLECTIONS = new Set(['objectives', 'questions', 'notes', 'proposals', 'decisions', 'agents']);
export const LOCAL_WORK_CONTENT_COLLECTIONS = new Set(['objectives', 'questions', 'notes', 'proposals', 'decisions']);
export const LOCAL_CONTENT_DEFAULTS = {
    objectives: {
        idPrefix: 'objective',
        extension: 'mdx',
        fields: { timeHorizon: 'near-term', motivation: '', primaryContributor: 'market-steward', relatedQuestions: [], relatedBooks: [] },
        body: 'Describe the objective, expected outcome, and the evidence that should update it over time.',
    },
    questions: {
        idPrefix: 'question',
        extension: 'mdx',
        fields: { questionType: 'strategy', motivation: '', primaryContributor: 'market-steward', relatedObjectives: [], relatedBooks: [] },
        body: 'Describe what needs to be learned and what evidence would make the answer useful.',
    },
    notes: {
        idPrefix: 'note',
        extension: 'mdx',
        fields: { author: 'market-steward', relatedObjectives: [], relatedQuestions: [], relatedProposals: [], relatedBooks: [] },
        body: 'Capture the useful context, evidence, and follow-up links for this note.',
    },
    proposals: {
        idPrefix: 'proposal',
        extension: 'mdx',
        fields: { proposalType: 'implementation', motivation: '', primaryContributor: 'market-steward', relatedObjectives: [], relatedQuestions: [], relatedNotes: [], relatedBooks: [], decision: '', supersedes: [] },
        body: 'Describe the proposed change, why it matters, what it affects, and how a reviewer should evaluate it.',
    },
    decisions: {
        idPrefix: 'decision',
        extension: 'mdx',
        fields: { decisionType: 'approved', rationale: '', authority: 'TreeSeed Treeseed Team', primaryContributor: 'market-steward', relatedObjectives: [], relatedQuestions: [], relatedNotes: [], relatedProposals: [], relatedBooks: [], supersedes: [], implements: [] },
        body: 'Record what was decided, why it was decided, and which proposals or evidence it closes.',
    },
    agents: {
        idPrefix: 'agent',
        extension: 'mdx',
        fields: {
            name: '',
            handler: 'writer',
            enabled: true,
            operator: 'TreeSeed platform',
            runtimeStatus: 'active',
            capabilities: [],
            tags: ['agent'],
            systemPrompt: 'Use the core objective as the first context message. Keep work observable, governed, and grounded in project content.',
            persona: 'Helpful, careful, and accountable.',
            triggers: [{ type: 'message', messageTypes: [] }],
            permissions: [],
            execution: { provider: 'codex', model: 'gpt-5.5', approvalPolicy: 'never', sandboxMode: 'read_only', reasoningEffort: 'medium' },
            outputs: {},
        },
        body: 'Describe this agent role, operating boundaries, and expected outputs.',
    },
};
export function slugifyContent(value) {
    return String(value ?? '')
        .toLowerCase()
        .trim()
        .replace(/['"]/gu, '')
        .replace(/[^a-z0-9]+/gu, '-')
        .replace(/^-+|-+$/gu, '')
        .slice(0, 96);
}
export function serializeFrontmatter(data) {
    const lines = ['---'];
    for (const [key, value] of Object.entries(data)) {
        if (Array.isArray(value) || (value && typeof value === 'object')) {
            const nested = yamlLines(value, 2);
            lines.push(`${key}:`);
            lines.push(...nested);
        }
        else {
            lines.push(`${key}: ${yamlScalar(value)}`);
        }
    }
    lines.push('---');
    return lines.join('\n');
}
export function normalizeRelationArray(value) {
    if (Array.isArray(value))
        return value.map((entry) => String(entry).trim()).filter(Boolean);
    if (typeof value === 'string')
        return value.split(/[\n,]/u).map((entry) => entry.trim()).filter(Boolean);
    return [];
}
export function uniqueRelationArray(value) {
    return [...new Set(normalizeRelationArray(value))];
}
export function addRelationValue(frontmatter, field, value, single = false) {
    const ref = String(value ?? '').trim();
    if (!field || !ref)
        return;
    if (single) {
        frontmatter[field] = ref;
        return;
    }
    frontmatter[field] = uniqueRelationArray([...(normalizeRelationArray(frontmatter[field])), ref]);
}
export function normalizeLocalContentInput(collection, body) {
    const defaults = LOCAL_CONTENT_DEFAULTS[collection];
    const title = optionalTrimmedString(body.title);
    if (!title)
        return { error: 'title is required.' };
    const slug = slugifyContent(body.slug || title);
    if (!slug)
        return { error: 'A safe slug is required.' };
    const today = new Date().toISOString().slice(0, 10);
    const summary = optionalTrimmedString(body.summary) ?? optionalTrimmedString(body.description) ?? title;
    const description = optionalTrimmedString(body.description) ?? summary;
    const frontmatter = {
        id: optionalTrimmedString(body.id) ?? `${defaults.idPrefix}:${slug}`,
        title,
        description,
        date: optionalTrimmedString(body.date) ?? today,
        summary,
        status: enumValue(body.status, ['recorded', 'live', 'in progress', 'exploratory', 'planned', 'speculative'], 'planned'),
        ...defaults.fields,
    };
    if (collection === 'agents') {
        frontmatter.name = optionalTrimmedString(body.name) ?? title;
        frontmatter.slug = slug;
        frontmatter.description = description;
        frontmatter.summary = summary;
        frontmatter.handler = optionalTrimmedString(body.handler) ?? frontmatter.handler;
        frontmatter.systemPrompt = optionalTrimmedString(body.systemPrompt) ?? frontmatter.systemPrompt;
        frontmatter.runtimeStatus = enumValue(body.runtimeStatus, ['active', 'experimental', 'dormant'], frontmatter.runtimeStatus);
        delete frontmatter.date;
        delete frontmatter.status;
    }
    else if (collection === 'notes') {
        frontmatter.author = optionalTrimmedString(body.author) ?? frontmatter.author;
        frontmatter.relatedObjectives = normalizeRelationArray(body.relatedObjectives);
        frontmatter.relatedQuestions = normalizeRelationArray(body.relatedQuestions);
        frontmatter.relatedProposals = normalizeRelationArray(body.relatedProposals);
    }
    else if (collection === 'objectives') {
        frontmatter.primaryContributor = optionalTrimmedString(body.primaryContributor) ?? frontmatter.primaryContributor;
        frontmatter.timeHorizon = enumValue(body.timeHorizon, ['near-term', 'mid-term', 'long-term'], frontmatter.timeHorizon);
        frontmatter.motivation = optionalTrimmedString(body.motivation) ?? description;
        frontmatter.relatedQuestions = normalizeRelationArray(body.relatedQuestions);
    }
    else if (collection === 'questions') {
        frontmatter.primaryContributor = optionalTrimmedString(body.primaryContributor) ?? frontmatter.primaryContributor;
        frontmatter.questionType = enumValue(body.questionType, ['research', 'implementation', 'strategy', 'evaluation'], frontmatter.questionType);
        frontmatter.motivation = optionalTrimmedString(body.motivation) ?? description;
        frontmatter.relatedObjectives = normalizeRelationArray(body.relatedObjectives);
    }
    else if (collection === 'proposals') {
        frontmatter.primaryContributor = optionalTrimmedString(body.primaryContributor) ?? frontmatter.primaryContributor;
        frontmatter.proposalType = enumValue(body.proposalType, ['strategy', 'policy', 'implementation', 'research'], frontmatter.proposalType);
        frontmatter.motivation = optionalTrimmedString(body.motivation) ?? description;
        frontmatter.relatedObjectives = normalizeRelationArray(body.relatedObjectives);
        frontmatter.relatedQuestions = normalizeRelationArray(body.relatedQuestions);
        frontmatter.relatedNotes = normalizeRelationArray(body.relatedNotes);
        frontmatter.decision = optionalTrimmedString(body.decision) ?? undefined;
    }
    else if (collection === 'decisions') {
        frontmatter.primaryContributor = optionalTrimmedString(body.primaryContributor) ?? frontmatter.primaryContributor;
        frontmatter.decisionType = enumValue(body.decisionType, LOCAL_DECISION_TYPE_VALUES, frontmatter.decisionType);
        frontmatter.rationale = optionalTrimmedString(body.rationale) ?? description;
        frontmatter.authority = optionalTrimmedString(body.authority) ?? frontmatter.authority;
        frontmatter.relatedObjectives = normalizeRelationArray(body.relatedObjectives);
        frontmatter.relatedQuestions = normalizeRelationArray(body.relatedQuestions);
        frontmatter.relatedNotes = normalizeRelationArray(body.relatedNotes);
        frontmatter.relatedProposals = normalizeRelationArray(body.relatedProposals);
    }
    return {
        slug,
        extension: defaults.extension,
        frontmatter: Object.fromEntries(Object.entries(frontmatter).filter(([, value]) => value !== undefined)),
        body: optionalTrimmedString(body.body) ?? defaults.body,
    };
}
export async function writeLocalContentRecord(collection, input) {
    if (!LOCAL_CONTENT_COLLECTIONS.has(collection)) {
        return { error: 'Unsupported content collection.' };
    }
    const normalized = normalizeLocalContentInput(collection, input);
    if (normalized.error)
        return normalized;
    const root = resolve(process.cwd(), 'src', 'content', collection);
    const existingTarget = input.overwrite === true
        ? [`${normalized.slug}.mdx`, `${normalized.slug}.md`]
            .map((file) => resolve(root, file))
            .find((candidate) => existsSync(candidate))
        : null;
    const target = existingTarget ?? resolve(root, `${normalized.slug}.${normalized.extension}`);
    const relativeTarget = relative(root, target);
    if (relativeTarget === '..' || relativeTarget.startsWith(`..${sep}`) || isAbsolute(relativeTarget)) {
        return { error: 'Unsafe content path.' };
    }
    if (existsSync(target) && input.overwrite !== true) {
        return { error: 'A content record with that slug already exists.' };
    }
    await mkdir(root, { recursive: true });
    const content = `${serializeFrontmatter(normalized.frontmatter)}\n\n${normalized.body.trim()}\n`;
    await writeFile(target, content, 'utf8');
    return {
        collection,
        slug: normalized.slug,
        id: normalized.frontmatter.id,
        path: relative(process.cwd(), target),
        href: collection === 'agents'
            ? `/app/projects/${encodeURIComponent(String(input.projectId ?? ''))}/agents/${encodeURIComponent(normalized.slug)}`
            : `/app/work/${collection}/${encodeURIComponent(normalized.slug)}`,
    };
}
export function localContentRoot(collection) {
    return resolve(process.cwd(), 'src', 'content', collection);
}
export function localContentPath(collection, slug, extension = null) {
    const root = localContentRoot(collection);
    const safeSlug = slugifyContent(slug);
    if (!safeSlug || safeSlug !== String(slug ?? '').trim())
        return null;
    const candidates = extension
        ? [resolve(root, `${safeSlug}.${extension}`)]
        : ['mdx', 'md'].map((ext) => resolve(root, `${safeSlug}.${ext}`));
    const target = candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
    const relativeTarget = relative(root, target);
    if (relativeTarget === '..' || relativeTarget.startsWith(`..${sep}`) || isAbsolute(relativeTarget))
        return null;
    return target;
}
export async function readLocalContentRecord(collection, slug) {
    if (!LOCAL_WORK_CONTENT_COLLECTIONS.has(collection))
        return { error: 'Unsupported content collection.' };
    const safeSlug = slugifyContent(slug);
    if (!safeSlug || safeSlug !== String(slug ?? '').trim())
        return { error: 'Unsafe content slug.' };
    const target = localContentPath(collection, safeSlug);
    if (!target || !existsSync(target))
        return { error: 'Parent content record was not found.' };
    const raw = await readFile(target, 'utf8');
    const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/u);
    if (!match)
        return { error: 'Content record is missing frontmatter.' };
    const frontmatter = parseYaml(match[1]) ?? {};
    if (!frontmatter || typeof frontmatter !== 'object' || Array.isArray(frontmatter)) {
        return { error: 'Content frontmatter could not be parsed.' };
    }
    return {
        path: target,
        slug: safeSlug,
        extension: target.endsWith('.md') ? 'md' : 'mdx',
        frontmatter,
        body: match[2] ?? '',
    };
}
export async function writeParsedLocalContentRecord(record) {
    const content = `${serializeFrontmatter(record.frontmatter)}\n\n${String(record.body ?? '').trim()}\n`;
    await writeFile(record.path, content, 'utf8');
}
export async function createRelatedLocalContentRecord(parentCollection, parentSlug, targetCollection, input) {
    if (!LOCAL_WORK_CONTENT_COLLECTIONS.has(parentCollection) || !LOCAL_WORK_CONTENT_COLLECTIONS.has(targetCollection)) {
        return { error: 'Unsupported content relation collection.' };
    }
    const policy = contentRelationPolicy(parentCollection, targetCollection);
    if (!policy)
        return { error: `Cannot create related ${targetCollection} from ${parentCollection}.` };
    const parent = await readLocalContentRecord(parentCollection, parentSlug);
    if (parent.error)
        return parent;
    const normalized = normalizeLocalContentInput(targetCollection, input);
    if (normalized.error)
        return normalized;
    const childTarget = localContentPath(targetCollection, normalized.slug, normalized.extension);
    if (!childTarget)
        return { error: 'Unsafe content path.' };
    if (existsSync(childTarget))
        return { error: 'A content record with that slug already exists.' };
    addRelationValue(parent.frontmatter, policy.sourceField, normalized.slug, policy.sourceSingle);
    addRelationValue(normalized.frontmatter, policy.targetField, parent.slug, policy.targetSingle);
    await mkdir(localContentRoot(targetCollection), { recursive: true });
    const childRecord = {
        path: childTarget,
        frontmatter: normalized.frontmatter,
        body: normalized.body,
    };
    await writeParsedLocalContentRecord(childRecord);
    try {
        await writeParsedLocalContentRecord(parent);
    }
    catch (error) {
        await rm(childTarget, { force: true }).catch(() => { });
        return {
            error: 'Related content could not be linked to the parent record.',
            details: error instanceof Error ? error.message : String(error),
        };
    }
    return {
        parent: {
            collection: parentCollection,
            slug: parent.slug,
            path: relative(process.cwd(), parent.path),
            href: `/app/work/${parentCollection}/${encodeURIComponent(parent.slug)}`,
        },
        child: {
            collection: targetCollection,
            slug: normalized.slug,
            id: normalized.frontmatter.id,
            path: relative(process.cwd(), childTarget),
            href: `/app/work/${targetCollection}/${encodeURIComponent(normalized.slug)}`,
        },
        relation: {
            parentField: policy.sourceField,
            childField: policy.targetField,
        },
    };
}
export async function applyContentPublishResult(store, job, output) {
    const project = await store.getProject(job.projectId);
    if (!project)
        return null;
    const payload = unwrapOperationPayload(output);
    if (!payload || payload.status !== 'published')
        return null;
    const result = payload.result && typeof payload.result === 'object' ? payload.result : {};
    const existing = await store.getHubContentSource(job.projectId);
    const repositories = await store.listHubRepositories(job.projectId);
    const contentRepository = repositories.find((repository) => repository.role === 'content') ?? null;
    const revision = typeof result.revision === 'string' && result.revision.trim()
        ? result.revision.trim()
        : typeof result.previewId === 'string' && result.previewId.trim()
            ? result.previewId.trim()
            : `publish-${job.id}`;
    const r2 = payload.r2 && typeof payload.r2 === 'object' ? payload.r2 : {};
    return store.upsertHubContentSource(job.projectId, {
        teamId: project.teamId,
        contentRepositoryId: existing?.contentRepositoryId ?? contentRepository?.id ?? null,
        productionSource: existing?.productionSource ?? 'r2_published_artifacts',
        overlayPolicy: existing?.overlayPolicy ?? 'src_content_when_present',
        r2BucketName: typeof r2.bucketName === 'string' && r2.bucketName.trim() ? r2.bucketName.trim() : existing?.r2BucketName ?? null,
        r2ManifestKey: typeof result.manifestKey === 'string' && result.manifestKey.trim() ? result.manifestKey.trim() : existing?.r2ManifestKey ?? null,
        r2PublicBaseUrl: typeof r2.publicBaseUrl === 'string' && r2.publicBaseUrl.trim() ? r2.publicBaseUrl.trim() : existing?.r2PublicBaseUrl ?? null,
        latestPublishId: revision,
        latestContentVersion: revision,
        metadata: {
            ...(existing?.metadata ?? {}),
            lastPublish: {
                jobId: job.id,
                scope: payload.scope ?? null,
                mode: result.mode ?? payload.mode ?? null,
                revision,
                previewId: result.previewId ?? null,
                previewUrl: result.previewUrl ?? null,
                target: result.target ?? null,
                contentSource: payload.contentSource ?? null,
                publishedAt: new Date().toISOString(),
            },
        },
    });
}
