const operationalCollections = ['books', 'decisions', 'notes', 'objectives', 'proposals', 'questions', 'docs', 'knowledge_packs'];
export async function loadKnowledgeContentEntries() {
    const content = await import(/* @vite-ignore */ 'astro:content').catch(() => null);
    if (!content?.getCollection)
        return [];
    const { getCollection } = content;
    const loader = getCollection;
    const groups = await Promise.all(operationalCollections.map(async (collection) => {
        try {
            const entries = await loader(collection, ({ data }) => !data?.draft);
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
function slugFromId(id) {
    return String(id ?? 'entry').replace(/^.*\//u, '').replace(/[^a-zA-Z0-9_-]+/gu, '-').toLowerCase();
}
