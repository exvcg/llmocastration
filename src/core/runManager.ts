import { randomUUID } from 'crypto';
import * as path from 'path';
import {
    AgentRole,
    ExecutorSwitchScope,
    RoleExecutorBindings
} from './agentExecutors';
import { readJsonFile, writeJsonFileAtomic } from './jsonFile';

export enum RunPhase {
    Planning = 'planning',
    Coding = 'coding',
    Verifying = 'verifying',
    Reviewing = 'reviewing',
    Completed = 'completed',
    Failed = 'failed',
    Blocked = 'blocked'
}

export type ReviewVerdict =
    | 'pass'
    | 'implementation_issue'
    | 'plan_gap'
    | 'test_gap'
    | 'needs_human';

export interface VerificationCommandResult {
    command: string;
    success: boolean;
    exitCode: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
}

export interface VerificationResult {
    success: boolean;
    commands: VerificationCommandResult[];
    completedAt: string;
}

export interface ReviewIssue {
    severity: 'critical' | 'major' | 'minor';
    description: string;
    file?: string;
}

export interface ReviewResult {
    verdict: ReviewVerdict;
    summary: string;
    issues: ReviewIssue[];
    completedAt: string;
}

export interface ExecutorSwitchRecord {
    id: string;
    scope: ExecutorSwitchScope;
    executor: string;
    role?: AgentRole;
    phase: RunPhase;
    taskId?: number;
    iteration: number;
    reason: string;
    changedAt: string;
}

export interface RunExecutorSettings {
    defaultExecutor: string;
    roleExecutors: RoleExecutorBindings;
}

export interface ResolvedExecutor {
    executor: string;
    source: 'default' | 'role' | ExecutorSwitchScope;
    overrideId?: string;
}

export interface AgentRun {
    id: string;
    goal: string;
    constraints: string[];
    doneWhen: string[];
    phase: RunPhase;
    taskIds: number[];
    iteration: number;
    maxIterations: number;
    defaultExecutor: string;
    roleExecutors: RoleExecutorBindings;
    executorSwitches: ExecutorSwitchRecord[];
    verification?: VerificationResult;
    review?: ReviewResult;
    lastError?: string;
    createdAt: string;
    updatedAt: string;
}

interface LegacyModelSwitchRecord
    extends Omit<ExecutorSwitchRecord, 'executor'> {
    model: string;
}

interface StoredAgentRun extends Partial<AgentRun> {
    id: string;
    goal: string;
    phase: RunPhase;
    taskIds: number[];
    iteration: number;
    maxIterations: number;
    createdAt: string;
    updatedAt: string;
    defaultModel?: string;
    roleModels?: Partial<RoleExecutorBindings>;
    modelSwitches?: LegacyModelSwitchRecord[];
}

const legacyExecutorSettings: RunExecutorSettings = {
    defaultExecutor: 'codex',
    roleExecutors: {
        planner: 'default',
        coder: 'antigravity',
        reviewer: 'default'
    }
};

function migrateExecutorName(value: string | undefined): string {
    if (value === 'gemini' || value === 'gemini-cli') {
        return 'antigravity';
    }

    return value?.trim() || '';
}

function normalizeRun(run: StoredAgentRun): AgentRun {
    const defaultExecutor = migrateExecutorName(
        run.defaultExecutor ?? run.defaultModel
    ) || legacyExecutorSettings.defaultExecutor;
    const storedBindings = run.roleExecutors ?? run.roleModels;
    const roleExecutors: RoleExecutorBindings = {
        planner: migrateExecutorName(storedBindings?.planner) ||
            legacyExecutorSettings.roleExecutors.planner,
        coder: migrateExecutorName(storedBindings?.coder) ||
            legacyExecutorSettings.roleExecutors.coder,
        reviewer: migrateExecutorName(storedBindings?.reviewer) ||
            legacyExecutorSettings.roleExecutors.reviewer
    };
    const executorSwitches = Array.isArray(run.executorSwitches)
        ? run.executorSwitches
        : Array.isArray(run.modelSwitches)
            ? run.modelSwitches.map(change => ({
                ...change,
                executor: migrateExecutorName(change.model)
            }))
            : [];

    return {
        id: run.id,
        goal: run.goal,
        constraints: Array.isArray(run.constraints) ? run.constraints : [],
        doneWhen: Array.isArray(run.doneWhen) ? run.doneWhen : [],
        phase: run.phase,
        taskIds: Array.isArray(run.taskIds) ? run.taskIds : [],
        iteration: run.iteration,
        maxIterations: run.maxIterations,
        defaultExecutor,
        roleExecutors,
        executorSwitches,
        verification: run.verification,
        review: run.review,
        lastError: run.lastError,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt
    };
}

function getRunsPath(projectRoot: string): string {
    return path.join(projectRoot, '.llm-co-op', 'runs.json');
}

export function readRuns(projectRoot: string): AgentRun[] {
    const runs = readJsonFile<StoredAgentRun[]>(getRunsPath(projectRoot));
    return Array.isArray(runs) ? runs.map(normalizeRun) : [];
}

export function writeRuns(
    projectRoot: string,
    runs: AgentRun[]
): void {
    writeJsonFileAtomic(getRunsPath(projectRoot), runs);
}

export function getRun(
    projectRoot: string,
    runId: string
): AgentRun | null {
    return readRuns(projectRoot).find(run => run.id === runId) ?? null;
}

export function startRun(
    projectRoot: string,
    goal: string,
    maxIterations: number,
    executorSettings: RunExecutorSettings = legacyExecutorSettings,
    context: {
        constraints?: string[];
        doneWhen?: string[];
    } = {}
): AgentRun {
    const runs = readRuns(projectRoot);
    const now = new Date().toISOString();
    const run: AgentRun = {
        id: `run-${Date.now()}-${randomUUID().slice(0, 8)}`,
        goal,
        constraints: [...(context.constraints ?? [])],
        doneWhen: [...(context.doneWhen ?? [])],
        phase: RunPhase.Planning,
        taskIds: [],
        iteration: 0,
        maxIterations,
        defaultExecutor: executorSettings.defaultExecutor,
        roleExecutors: { ...executorSettings.roleExecutors },
        executorSwitches: [],
        createdAt: now,
        updatedAt: now
    };

    runs.push(run);
    writeRuns(projectRoot, runs);
    return run;
}

export function switchRunExecutor(
    projectRoot: string,
    runId: string,
    input: {
        scope: ExecutorSwitchScope;
        executor: string;
        role?: AgentRole;
        taskId?: number;
        reason: string;
    }
): AgentRun | null {
    return updateRun(projectRoot, runId, run => {
        const phaseRole = getRoleForPhase(run.phase);
        const role = input.scope === 'role'
            ? input.role
            : input.scope === 'currentStep'
                ? input.role ?? phaseRole ?? undefined
                : undefined;

        if (input.scope === 'role' && !role) {
            throw new Error('role 범위에는 역할이 필요합니다.');
        }
        if (input.scope === 'currentStep' && !role) {
            throw new Error(
                '현재 단계는 대화형 실행자가 담당하는 역할 단계가 아닙니다.'
            );
        }

        run.executorSwitches.push({
            id: randomUUID(),
            scope: input.scope,
            executor: input.executor,
            role,
            phase: run.phase,
            taskId: input.taskId,
            iteration: run.iteration,
            reason: input.reason,
            changedAt: new Date().toISOString()
        });
    });
}

export function resolveRunExecutor(
    run: AgentRun,
    role: AgentRole,
    taskId?: number
): ResolvedExecutor {
    const roleExecutor = run.roleExecutors[role];
    let resolved: ResolvedExecutor =
        roleExecutor && roleExecutor !== 'default'
            ? { executor: roleExecutor, source: 'role' }
            : { executor: run.defaultExecutor, source: 'default' };

    for (const change of run.executorSwitches) {
        const appliesToRemainingRun = change.scope === 'remainingRun';
        const appliesToRole = change.scope === 'role' &&
            change.role === role;
        const appliesToCurrentStep = change.scope === 'currentStep' &&
            change.role === role &&
            change.phase === run.phase &&
            change.iteration === run.iteration &&
            (change.taskId === undefined || change.taskId === taskId);

        if (
            appliesToRemainingRun ||
            appliesToRole ||
            appliesToCurrentStep
        ) {
            resolved = {
                executor: change.executor,
                source: change.scope,
                overrideId: change.id
            };
        }
    }

    return resolved;
}

export function getRoleForPhase(phase: RunPhase): AgentRole | null {
    switch (phase) {
        case RunPhase.Planning:
            return 'planner';
        case RunPhase.Coding:
            return 'coder';
        case RunPhase.Reviewing:
            return 'reviewer';
        default:
            return null;
    }
}

export function updateRun(
    projectRoot: string,
    runId: string,
    update: (run: AgentRun) => void
): AgentRun | null {
    const runs = readRuns(projectRoot);
    const run = runs.find(item => item.id === runId);

    if (!run) {
        return null;
    }

    update(run);
    run.updatedAt = new Date().toISOString();
    writeRuns(projectRoot, runs);
    return run;
}

export function saveRunPlan(
    projectRoot: string,
    runId: string,
    taskIds: number[]
): AgentRun | null {
    return updateRun(projectRoot, runId, run => {
        run.taskIds = [...taskIds];
        run.phase = RunPhase.Coding;
        run.verification = undefined;
        run.review = undefined;
        run.lastError = undefined;
    });
}

export function setRunPhase(
    projectRoot: string,
    runId: string,
    phase: RunPhase,
    lastError?: string
): AgentRun | null {
    return updateRun(projectRoot, runId, run => {
        run.phase = phase;
        run.lastError = lastError;
    });
}

export function recordVerification(
    projectRoot: string,
    runId: string,
    verification: VerificationResult
): AgentRun | null {
    return updateRun(projectRoot, runId, run => {
        run.verification = verification;
        run.review = undefined;
        run.phase = RunPhase.Reviewing;
    });
}

export function recordReview(
    projectRoot: string,
    runId: string,
    review: ReviewResult
): AgentRun | null {
    return updateRun(projectRoot, runId, run => {
        run.review = review;
    });
}

export function retryRun(
    projectRoot: string,
    runId: string,
    phase: RunPhase.Planning | RunPhase.Coding | RunPhase.Verifying,
    reason: string
): AgentRun | null {
    return updateRun(projectRoot, runId, run => {
        run.iteration += 1;
        run.lastError = reason;
        run.review = undefined;

        if (run.iteration >= run.maxIterations) {
            run.phase = RunPhase.Blocked;
            return;
        }

        run.phase = phase;
        run.verification = undefined;
    });
}

export function completeRun(
    projectRoot: string,
    runId: string
): AgentRun | null {
    return updateRun(projectRoot, runId, run => {
        run.phase = RunPhase.Completed;
        run.lastError = undefined;
    });
}
