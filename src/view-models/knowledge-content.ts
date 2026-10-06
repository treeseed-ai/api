const operationalCollections = ['books', 'decisions', 'notes', 'objectives', 'proposals', 'questions', 'docs'];
export async function loadKnowledgeContentEntries() {
    const moduleId = 'astro:content';
    const content: any = await import(/* @vite-ignore */ moduleId).catch(() => null);
    if (!content?.getCollection)
        return [];
    const { getCollection } = content;
    const loader = getCollection;
    const groups = await Promise.all(operationalCollections.map(async (collection) => {
        try {
            const entries: Array<Record<string, unknown> & { id?: unknown; slug?: unknown }> = await loader(collection, ({ data }: { data?: Record<string, unknown> }) => !data?.draft);
            return entries.map((entry) => ({
                ...entry,
                collection,
                sourceCollection: collection,
                slug: entry.slug ?? slugFromId(entry.id),
            }));
        }
        catch {
            return [];
        }
    }));
    return groups.flat();
}
function slugFromId(id: unknown) {
    return String(id ?? 'entry').replace(/^.*\//u, '').replace(/[^a-zA-Z0-9_-]+/gu, '-').toLowerCase();
}
