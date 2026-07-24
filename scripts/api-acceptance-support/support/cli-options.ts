

export function parseArgs(argv) {
    const args: Record<string, any> = {
        environment: process.env.TREESEED_ACCEPTANCE_ENVIRONMENT || process.env.TREESEED_ENVIRONMENT || 'local',
        baseUrl: process.env.TREESEED_API_BASE_URL || '',
        spec: 'tests/acceptance/api/base.yaml',
        reportJson: '',
        reportJunit: '',
        expandJson: '',
        caseId: '',
    };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--environment')
            args.environment = argv[++index];
        else if (arg === '--base-url')
            args.baseUrl = argv[++index];
        else if (arg === '--spec')
            args.spec = argv[++index];
        else if (arg === '--report-json')
            args.reportJson = argv[++index];
        else if (arg === '--report-junit')
            args.reportJunit = argv[++index];
        else if (arg === '--expand-json')
            args.expandJson = argv[++index];
        else if (arg === '--case')
            args.caseId = argv[++index];
        else if (arg === '--help' || arg === '-h')
            args.help = true;
    }
    return args;
}

export function isLoopbackAcceptanceUrl(value) {
    try {
        const url = new URL(value);
        return ['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]'].includes(url.hostname);
    }
    catch {
        return false;
    }
}

export function assertAcceptanceTarget(args) {
    const environment = String(args.environment || 'local');
    args.baseUrl = String(args.baseUrl || '').replace(/\/+$/u, '');
    if (!args.baseUrl && environment === 'local') {
        args.baseUrl = 'http://127.0.0.1:3000';
    }
    if (!args.baseUrl) {
        throw new Error(`API acceptance for ${environment} requires --base-url or TREESEED_API_BASE_URL.`);
    }
    if (environment !== 'local' && isLoopbackAcceptanceUrl(args.baseUrl)) {
        throw new Error(`API acceptance for ${environment} must target a live hosted API URL, not ${args.baseUrl}.`);
    }
    if (environment === 'staging' && !/^https:\/\/api\.preview\.treeseed\.dev(?:\/|$)/u.test(args.baseUrl)) {
        throw new Error(`Staging API acceptance must target https://api.preview.treeseed.dev, not ${args.baseUrl}.`);
    }
    if (environment === 'prod' && !/^https:\/\/api\.treeseed\.dev(?:\/|$)/u.test(args.baseUrl)) {
        throw new Error(`Production API acceptance must target https://api.treeseed.dev, not ${args.baseUrl}.`);
    }
}

export function matchesCaseFilter(caseId, candidateId) {
    return !caseId || candidateId === caseId;
}
