import * as path from 'path';
import {
    AgentRole,
    RoleExecutorBindings
} from './agentExecutors';
import { readJsonFile, writeJsonFileAtomic } from './jsonFile';

export interface InteractiveExecutorConfig {
    type: 'interactive';
}

export type ExecutorConfig = InteractiveExecutorConfig;

export interface ExecutorRegistry {
    [name: string]: ExecutorConfig;
}

export interface InteractiveRoleConfig {
    executor: string;
    instructions: string;
}

export interface VerifierRoleConfig {
    executor: 'command';
    commands: string[];
}

export interface AgentRolesConfig {
    planner: InteractiveRoleConfig;
    coder: InteractiveRoleConfig;
    verifier: VerifierRoleConfig;
    reviewer: InteractiveRoleConfig;
}

export interface AgentLimitsConfig {
    maxIterations: number;
    timeoutSeconds: number;
}

export interface Config {
    defaultExecutor: string;
    executors: ExecutorRegistry;
    roles: AgentRolesConfig;
    limits: AgentLimitsConfig;
}

interface StoredRoleConfig {
    executor?: unknown;
    model?: unknown;
    instructions?: unknown;
    command?: unknown;
}

interface StoredConfig {
    defaultExecutor?: unknown;
    executors?: Record<string, { type?: unknown }>;
    roles?: {
        planner?: StoredRoleConfig;
        coder?: StoredRoleConfig;
        verifier?: Partial<VerifierRoleConfig>;
        reviewer?: StoredRoleConfig;
    };
    limits?: Partial<AgentLimitsConfig>;
    // Legacy model-based configuration fields.
    defaultModel?: unknown;
    models?: Record<string, {
        executor?: unknown;
        command?: unknown;
        model?: unknown;
    }>;
}

export function createDefaultConfig(): Config {
    return {
        defaultExecutor: 'codex',
        executors: {
            codex: {
                type: 'interactive'
            },
            antigravity: {
                type: 'interactive'
            }
        },
        roles: {
            planner: {
                executor: 'default',
                instructions:
                    '목표를 구현 가능한 작업과 명확한 완료 조건으로 분해합니다.'
            },
            coder: {
                executor: 'antigravity',
                instructions:
                    '계획과 완료 조건을 따르고 실제 프로젝트 파일을 수정합니다.'
            },
            verifier: {
                executor: 'command',
                commands: [
                    'npm run check-types',
                    'npm run lint'
                ]
            },
            reviewer: {
                executor: 'default',
                instructions:
                    '원래 목표, 완료 조건, 변경 내용, 테스트 결과만으로 독립적으로 검토합니다.'
            }
        },
        limits: {
            maxIterations: 3,
            timeoutSeconds: 600
        }
    };
}

function nonEmptyString(value: unknown, fallback: string): string {
    return typeof value === 'string' && value.trim()
        ? value.trim()
        : fallback;
}

function positiveInteger(value: unknown, fallback: number): number {
    return typeof value === 'number' &&
        Number.isInteger(value) &&
        value > 0
        ? value
        : fallback;
}

function migrateExecutorName(value: unknown): string {
    if (typeof value !== 'string') {
        return '';
    }

    const name = value.trim();

    if (name === 'gemini' || name === 'gemini-cli') {
        return 'antigravity';
    }

    return name;
}

function normalizeExecutors(
    stored: StoredConfig,
    defaults: Config
): ExecutorRegistry {
    const executors: ExecutorRegistry = { ...defaults.executors };

    for (const [name, candidate] of Object.entries(
        stored.executors ?? {}
    )) {
        if (
            name.trim() &&
            candidate &&
            typeof candidate === 'object' &&
            candidate.type === 'interactive'
        ) {
            executors[name.trim()] = { type: 'interactive' };
        }
    }

    return executors;
}

function normalizeRoleExecutor(
    role: AgentRole,
    stored: StoredConfig,
    executors: ExecutorRegistry,
    defaults: Config
): string {
    const candidate = stored.roles?.[role];
    const requested = migrateExecutorName(
        candidate?.executor ?? candidate?.model
    );

    if (requested === 'default') {
        return requested;
    }
    if (requested && executors[requested]) {
        return requested;
    }
    if (candidate?.executor === 'current-chat' && executors.codex) {
        return 'codex';
    }

    return defaults.roles[role].executor;
}

function getConfigPath(projectRoot: string): string {
    return path.join(projectRoot, '.llm-co-op', 'config.json');
}

export function normalizeConfig(stored: StoredConfig): Config {
    const defaults = createDefaultConfig();
    const roles = stored.roles ?? {};
    const limits = stored.limits ?? {};
    const executors = normalizeExecutors(stored, defaults);
    const requestedDefault = migrateExecutorName(
        stored.defaultExecutor ?? stored.defaultModel
    );
    const defaultExecutor = requestedDefault && executors[requestedDefault]
        ? requestedDefault
        : defaults.defaultExecutor;
    const verificationCommands = Array.isArray(
        roles.verifier?.commands
    )
        ? roles.verifier.commands.filter(command =>
            typeof command === 'string' && command.trim()
        )
        : defaults.roles.verifier.commands;

    return {
        defaultExecutor,
        executors,
        roles: {
            planner: {
                executor: normalizeRoleExecutor(
                    'planner',
                    stored,
                    executors,
                    defaults
                ),
                instructions: nonEmptyString(
                    roles.planner?.instructions,
                    defaults.roles.planner.instructions
                )
            },
            coder: {
                executor: normalizeRoleExecutor(
                    'coder',
                    stored,
                    executors,
                    defaults
                ),
                instructions: nonEmptyString(
                    roles.coder?.instructions,
                    defaults.roles.coder.instructions
                )
            },
            verifier: {
                executor: 'command',
                commands: verificationCommands.length > 0
                    ? verificationCommands
                    : defaults.roles.verifier.commands
            },
            reviewer: {
                executor: normalizeRoleExecutor(
                    'reviewer',
                    stored,
                    executors,
                    defaults
                ),
                instructions: nonEmptyString(
                    roles.reviewer?.instructions,
                    defaults.roles.reviewer.instructions
                )
            }
        },
        limits: {
            maxIterations: positiveInteger(
                limits.maxIterations,
                defaults.limits.maxIterations
            ),
            timeoutSeconds: positiveInteger(
                limits.timeoutSeconds,
                defaults.limits.timeoutSeconds
            )
        }
    };
}

export function getRoleExecutorBindings(
    config: Config
): RoleExecutorBindings {
    return {
        planner: config.roles.planner.executor,
        coder: config.roles.coder.executor,
        reviewer: config.roles.reviewer.executor
    };
}

export function readConfig(projectRoot: string): Config | null {
    const stored = readJsonFile<StoredConfig>(getConfigPath(projectRoot));
    return stored ? normalizeConfig(stored) : null;
}

export function readConfigOrDefault(projectRoot: string): Config {
    return readConfig(projectRoot) ?? createDefaultConfig();
}

export function writeConfig(
    projectRoot: string,
    config: Config
): void {
    writeJsonFileAtomic(
        getConfigPath(projectRoot),
        normalizeConfig(config)
    );
}
