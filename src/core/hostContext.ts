const HOST_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

export function normalizeHostName(value: string): string {
    const host = value.trim().toLowerCase();

    if (!host || !HOST_NAME_PATTERN.test(host)) {
        throw new Error(
            '실행자 이름은 영문자, 숫자, 밑줄, 하이픈만 사용할 수 있습니다.'
        );
    }

    return host;
}

export function resolveCurrentHost(
    args: string[] = process.argv.slice(2),
    environment: NodeJS.ProcessEnv = process.env
): string {
    const hostIndex = args.indexOf('--host');
    const argumentHost = hostIndex >= 0
        ? args[hostIndex + 1]
        : undefined;
    const configuredHost = argumentHost ?? environment.LLM_CO_OP_HOST;

    if (!configuredHost || configuredHost.startsWith('--')) {
        throw new Error(
            '--host <name> 또는 LLM_CO_OP_HOST가 필요합니다.'
        );
    }

    return normalizeHostName(configuredHost);
}
