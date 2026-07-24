import { runOnce, runLoop, parseRunnerOptions, packageVersion, loadConfig } from './index.js';

export async function main() {
    const command = process.argv[2] ?? 'help';
    const runnerOptions = parseRunnerOptions();
    if (runnerOptions.once) {
        await runOnce(runnerOptions);
        return;
    }
    if (runnerOptions.watch) {
        await runLoop();
        return;
    }
    if (command === 'version') {
        console.log(JSON.stringify({
            ok: true,
            name: 'operations-runner',
            version: await packageVersion(),
        }));
        return;
    }
    if (command === 'healthcheck') {
        const config = await loadConfig({ requireSecrets: false });
        console.log(JSON.stringify({
            ok: true,
            service: 'operations-runner',
            dataDir: config.dataDir,
        }));
        return;
    }
    if (command === 'once') {
        await runOnce(runnerOptions);
        return;
    }
    if (command === 'run') {
        await runLoop();
        return;
    }
    console.error('Usage: operations-runner <version|healthcheck|once|run>');
    process.exitCode = 2;
}
