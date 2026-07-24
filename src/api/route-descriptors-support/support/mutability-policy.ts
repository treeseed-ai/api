

export function mutability(method) {
    if (method === 'get')
        return 'read';
    if (method === 'delete')
        return 'destructive';
    return 'write';
}
