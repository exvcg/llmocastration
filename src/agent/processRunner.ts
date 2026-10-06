import { spawn } from 'child_process';

const MAX_OUTPUT_LENGTH = 128_000;

export interface ProcessResult {
    success: boolean;
    exitCode: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
}

export interface ProcessOptions {
    cwd: string;
    timeoutSeconds: number;
    input?: string;
}

function appendOutput(current: string, chunk: Buffer): string {
    const next = current + chunk.toString('utf8');
    return next.length > MAX_OUTPUT_LENGTH
        ? next.slice(-MAX_OUTPUT_LENGTH)
        : next;
}

export function runProcess(
    command: string,
    args: string[],
    options: ProcessOptions
): Promise<ProcessResult> {
    return new Promise(resolve => {
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        let settled = false;

        const child = spawn(command, args, {
            cwd: options.cwd,
            env: process.env,
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe']
        });
        const timeout = setTimeout(() => {
            timedOut = true;
            child.kill();
        }, options.timeoutSeconds * 1000);

        child.stdout.on('data', (chunk: Buffer) => {
            stdout = appendOutput(stdout, chunk);
        });
        child.stderr.on('data', (chunk: Buffer) => {
            stderr = appendOutput(stderr, chunk);
        });
        child.on('error', error => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timeout);
            resolve({
                success: false,
                exitCode: null,
                stdout,
                stderr: `${stderr}${error.message}`,
                timedOut
            });
        });
        child.on('close', exitCode => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timeout);
            resolve({
                success: exitCode === 0 && !timedOut,
                exitCode,
                stdout,
                stderr,
                timedOut
            });
        });

        if (options.input !== undefined) {
            child.stdin.write(options.input);
        }
        child.stdin.end();
    });
}

export function runShellCommand(
    command: string,
    options: ProcessOptions
): Promise<ProcessResult> {
    if (process.platform === 'win32') {
        return runProcess(
            process.env.ComSpec ?? 'cmd.exe',
            ['/d', '/s', '/c', command],
            options
        );
    }

    return runProcess('/bin/sh', ['-lc', command], options);
}
