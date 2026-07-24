

export function junit(report) {
    const failures = report.results.filter((result) => !result.ok);
    const escape = (value) => String(value ?? '').replace(/[<>&"']/gu, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[char]));
    return [
        `<?xml version="1.0" encoding="UTF-8"?>`,
        `<testsuite name="api-acceptance" tests="${report.results.length}" failures="${failures.length}">`,
        ...report.results.map((result) => result.ok
            ? `  <testcase classname="market.acceptance" name="${escape(result.id)}" time="${result.durationMs / 1000}" />`
            : `  <testcase classname="market.acceptance" name="${escape(result.id)}" time="${result.durationMs / 1000}"><failure>${escape(result.failures.join('\\n'))}</failure></testcase>`),
        `</testsuite>`,
    ].join('\n');
}
