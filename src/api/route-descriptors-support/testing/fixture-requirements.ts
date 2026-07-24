

export function fixtureRequirements(path) {
    const required = [];
    for (const match of path.matchAll(/:([A-Za-z0-9_]+)/gu)) {
        required.push(match[1]);
    }
    return required;
}
