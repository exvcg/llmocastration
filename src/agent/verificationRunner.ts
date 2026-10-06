import { VerificationResult } from '../core/runManager';
import { runShellCommand } from './processRunner';

export async function runVerificationCommands(
    projectRoot: string,
    commands: string[],
    timeoutSeconds: number
): Promise<VerificationResult> {
    const results = [];

    for (const command of commands) {
        const result = await runShellCommand(command, {
            cwd: projectRoot,
            timeoutSeconds
        });

        results.push({
            command,
            ...result
        });
    }

    return {
        success: results.length > 0 &&
            results.every(result => result.success),
        commands: results,
        completedAt: new Date().toISOString()
    };
}
