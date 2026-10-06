import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import { runVerificationCommands } from '../agent/verificationRunner';
import {
    Config,
    getRoleExecutorBindings,
    readConfigOrDefault,
    writeConfig
} from '../core/configManager';
import {
    agentRoles,
    AgentRole,
    executorSwitchScopes
} from '../core/agentExecutors';
import { appendHistory, getHistory } from '../core/historyManager';
import { resolveCurrentHost } from '../core/hostContext';
import { normalizeProjectPaths } from '../core/pathSafety';
import {
    initializeProject,
    resolveProjectRoot
} from '../core/projectManager';
import {
    completeRun,
    AgentRun,
    getRun,
    getRoleForPhase,
    readRuns,
    recordReview,
    recordVerification,
    resolveRunExecutor,
    retryRun,
    ReviewIssue,
    RunPhase,
    saveRunPlan,
    setRunPhase,
    startRun,
    switchRunExecutor
} from '../core/runManager';
import {
    createTask,
    getTask,
    readTasks,
    TaskLog,
    TaskStatus,
    updateTask
} from '../core/taskManager';

const statusSchema = z.enum([
    TaskStatus.Pending,
    TaskStatus.Running,
    TaskStatus.Completed,
    TaskStatus.Failed
]);

const runPhaseSchema = z.enum([
    RunPhase.Planning,
    RunPhase.Coding,
    RunPhase.Verifying,
    RunPhase.Reviewing,
    RunPhase.Completed,
    RunPhase.Failed,
    RunPhase.Blocked
]);

const reviewVerdictSchema = z.enum([
    'pass',
    'implementation_issue',
    'plan_gap',
    'test_gap',
    'needs_human'
]);

const agentRoleSchema = z.enum(agentRoles);
const executorSwitchScopeSchema = z.enum(executorSwitchScopes);
const projectRootSchema = z.string().trim().min(1).describe(
    'Absolute path of the project this tool call may read or modify.'
);
const projectRootInputShape = {
    projectRoot: projectRootSchema.optional()
};

function resolveConfiguredProjectRoot(): string | null {
    const args = process.argv.slice(2);
    const projectRootIndex = args.indexOf('--project-root');
    const argumentPath = projectRootIndex >= 0
        ? args[projectRootIndex + 1]
        : undefined;
    const configuredPath =
        argumentPath ?? process.env.LLM_CO_OP_PROJECT_ROOT;

    if (!configuredPath || configuredPath.startsWith('--')) {
        return null;
    }

    return resolveProjectRoot(configuredPath);
}

function requireProjectRoot(
    requestedProjectRoot: string | undefined,
    configuredProjectRoot: string | null
): string {
    const candidate = requestedProjectRoot ?? configuredProjectRoot;

    if (!candidate) {
        throw new Error(
            '현재 프로젝트의 절대 경로를 projectRoot로 전달한 뒤 다시 호출하세요.'
        );
    }

    return resolveProjectRoot(candidate);
}

function successResult(output: Record<string, unknown>) {
    return {
        content: [
            {
                type: 'text' as const,
                text: JSON.stringify(output, null, 2)
            }
        ],
        structuredContent: output
    };
}

function errorResult(error: unknown) {
    return {
        isError: true,
        content: [
            {
                type: 'text' as const,
                text: error instanceof Error
                    ? error.message
                    : String(error)
            }
        ]
    };
}

function requireRun(projectRoot: string, runId: string) {
    const run = getRun(projectRoot, runId);

    if (!run) {
        throw new Error(`실행 ${runId}을 찾을 수 없습니다.`);
    }

    return run;
}

function requireConfiguredExecutor(config: Config, executorName: string) {
    const executor = config.executors[executorName];

    if (!executor) {
        throw new Error(
            `실행자 '${executorName}'이 config.executors에 등록되어 있지 않습니다.`
        );
    }

    return executor;
}

function requireHostOwnsRole(
    config: Config,
    run: AgentRun,
    role: AgentRole,
    currentHost: string,
    taskId?: number
) {
    const selectedExecutor = resolveRunExecutor(run, role, taskId);
    requireConfiguredExecutor(config, selectedExecutor.executor);

    if (selectedExecutor.executor !== currentHost) {
        throw new Error(
            `${role} 역할은 '${selectedExecutor.executor}' 실행자에 배정되어 있습니다.`
        );
    }

    return selectedExecutor;
}

function getRunTasks(projectRoot: string, run: AgentRun): TaskLog[] {
    return run.taskIds
        .map(taskId => getTask(projectRoot, taskId))
        .filter((task): task is TaskLog => task !== null);
}

function getSuggestedNextAction(
    run: AgentRun,
    tasks: TaskLog[]
): string {
    switch (run.phase) {
        case RunPhase.Planning:
            return '계획을 작성한 뒤 save_plan을 호출합니다.';
        case RunPhase.Coding: {
            const task = tasks.find(item =>
                item.status !== TaskStatus.Completed
            );
            return task
                ? `작업 ${task.id}을 구현하고 결과를 제출합니다.`
                : '모든 작업이 완료되었습니다. 검증 단계로 전환합니다.';
        }
        case RunPhase.Verifying:
            return 'run_verification을 호출합니다.';
        case RunPhase.Reviewing:
            return '변경 내용과 검증 결과를 검토하고 submit_review를 호출합니다.';
        case RunPhase.Completed:
            return '실행이 완료되었습니다.';
        case RunPhase.Blocked:
            return '사람의 결정 또는 설정 변경이 필요합니다.';
        case RunPhase.Failed:
            return '실패 원인을 확인하고 새 실행 또는 복구 방법을 결정합니다.';
    }
}

function createHandoff(
    run: AgentRun,
    projectRoot: string,
    tasks: TaskLog[],
    role: AgentRole | null,
    currentHost: string,
    selectedExecutor?: ReturnType<typeof resolveRunExecutor>
) {
    return {
        projectRoot,
        goal: run.goal,
        constraints: run.constraints,
        doneWhen: run.doneWhen,
        phase: run.phase,
        role,
        currentHost,
        selectedExecutor,
        requiresHandoff: selectedExecutor !== undefined &&
            selectedExecutor.executor !== currentHost,
        iteration: run.iteration,
        completed: tasks
            .filter(task => task.status === TaskStatus.Completed)
            .map(task => task.id),
        pending: tasks
            .filter(task => task.status !== TaskStatus.Completed)
            .map(task => ({
                id: task.id,
                instruction: task.instruction,
                target: task.target,
                acceptanceCriteria: task.acceptanceCriteria,
                status: task.status
            })),
        verification: run.verification,
        review: run.review,
        nextAction: getSuggestedNextAction(run, tasks)
    };
}

function buildRolePrompt(
    run: AgentRun,
    role: AgentRole,
    roleInstructions: string,
    tasks: TaskLog[]
): string {
    const shared = [
        roleInstructions,
        '',
        `역할: ${role}`,
        `전체 목표: ${run.goal}`,
        `현재 단계: ${run.phase}`,
        `반복: ${run.iteration + 1}/${run.maxIterations}`,
        '',
        '제약 조건:',
        ...(run.constraints.length > 0
            ? run.constraints.map(item => `- ${item}`)
            : ['- 없음']),
        '',
        '완료 기준:',
        ...(run.doneWhen.length > 0
            ? run.doneWhen.map(item => `- ${item}`)
            : ['- 각 작업의 acceptanceCriteria를 따릅니다.'])
    ];

    if (role === 'planner') {
        return [
            ...shared,
            '',
            '파일을 수정하지 말고 구현 계획만 작성하세요.',
            '각 작업에 instruction, target, acceptanceCriteria를 포함하세요.',
            '결과는 save_plan에 전달할 수 있는 JSON tasks 배열로 반환하세요.'
        ].join('\n');
    }

    return [
        ...shared,
        '',
        '계획된 작업:',
        JSON.stringify(tasks, null, 2),
        '',
        '검증 결과:',
        JSON.stringify(run.verification ?? null, null, 2),
        '',
        '파일을 수정하지 말고 독립적으로 검토하세요.',
        'verdict, summary, issues가 포함된 JSON으로 반환하세요.'
    ].join('\n');
}

function finishCoderTask(
    projectRoot: string,
    run: AgentRun,
    taskId: number,
    success: boolean,
    summary: string
) {
    const updatedTask = updateTask(projectRoot, taskId, {
        status: success ? TaskStatus.Completed : TaskStatus.Failed,
        result: {
            success,
            summary,
            finishedAt: new Date().toISOString()
        }
    });
    const activeTasks = run.taskIds.map(id => getTask(projectRoot, id));
    let updatedRun = getRun(projectRoot, run.id);

    if (
        success &&
        activeTasks.every(task => task?.status === TaskStatus.Completed)
    ) {
        updatedRun = setRunPhase(
            projectRoot,
            run.id,
            RunPhase.Verifying
        );
    }

    return { run: updatedRun, task: updatedTask };
}

function createServer(
    configuredProjectRoot: string | null,
    currentHost: string
): McpServer {
    const server = new McpServer(
        {
            name: 'llm-co-op',
            version: '0.1.0'
        },
        {
            instructions:
                'Pass the absolute current workspace path as projectRoot on every project tool call. Call initialize_project once before first use. Use get_next_action to resolve each role to an executor. Only perform interactive work when the assigned executor matches currentHost. Preserve run state across switch_executor handoffs, execute only configured verification commands, and complete runs only after verification and review pass.'
        }
    );

    server.registerTool(
        'initialize_project',
        {
            title: 'Initialize project',
            description:
                'Initialize project-local LLM Co-op data without overwriting existing configuration.',
            inputSchema: z.object({
                projectRoot: projectRootSchema
            }),
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false
            }
        },
        async ({ projectRoot: requestedProjectRoot }) => {
            try {
                const project = initializeProject(requestedProjectRoot);
                return successResult({
                    project,
                    config: readConfigOrDefault(project.projectRoot)
                });
            }
            catch (error) {
                return errorResult(error);
            }
        }
    );

    server.registerTool(
        'list_tasks',
        {
            title: 'List tasks',
            description: 'List project tasks, optionally filtered by status.',
            inputSchema: z.object({
                ...projectRootInputShape,
                status: statusSchema.optional(),
                runId: z.string().trim().min(1).optional()
            }),
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false
            }
        },
        async ({ projectRoot: requestedProjectRoot, status, runId }) => {
            const projectRoot = requireProjectRoot(
                requestedProjectRoot,
                configuredProjectRoot
            );
            let tasks = readTasks(projectRoot) ?? [];

            if (status !== undefined) {
                tasks = tasks.filter(task => task.status === status);
            }
            if (runId !== undefined) {
                tasks = tasks.filter(task => task.runId === runId);
            }

            return successResult({ tasks });
        }
    );

    server.registerTool(
        'get_task',
        {
            title: 'Get task',
            description: 'Get one task by numeric ID.',
            inputSchema: z.object({
                ...projectRootInputShape,
                id: z.number().int().positive()
            }),
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false
            }
        },
        async ({ projectRoot: requestedProjectRoot, id }) => {
            const projectRoot = requireProjectRoot(
                requestedProjectRoot,
                configuredProjectRoot
            );
            const task = getTask(projectRoot, id);
            return task
                ? successResult({ task })
                : errorResult(new Error(`작업 ${id}을 찾을 수 없습니다.`));
        }
    );

    server.registerTool(
        'create_task',
        {
            title: 'Create task',
            description: 'Create a pending implementation task.',
            inputSchema: z.object({
                ...projectRootInputShape,
                instruction: z.string().trim().min(1),
                target: z.array(z.string().trim().min(1)).min(1),
                acceptanceCriteria: z.array(
                    z.string().trim().min(1)
                ).default([])
            }),
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: false,
                openWorldHint: false
            }
        },
        async ({
            projectRoot: requestedProjectRoot,
            instruction,
            target,
            acceptanceCriteria
        }) => {
            try {
                const projectRoot = requireProjectRoot(
                    requestedProjectRoot,
                    configuredProjectRoot
                );
                const task = createTask(projectRoot, {
                    instruction,
                    target: normalizeProjectPaths(projectRoot, target),
                    acceptanceCriteria
                });
                return successResult({ task });
            }
            catch (error) {
                return errorResult(error);
            }
        }
    );

    server.registerTool(
        'update_task',
        {
            title: 'Update task',
            description: 'Update a task instruction, files, criteria, or status.',
            inputSchema: z.object({
                ...projectRootInputShape,
                id: z.number().int().positive(),
                instruction: z.string().trim().min(1).optional(),
                target: z.array(z.string().trim().min(1)).min(1).optional(),
                acceptanceCriteria: z.array(
                    z.string().trim().min(1)
                ).optional(),
                status: statusSchema.optional()
            }).refine(input =>
                input.instruction !== undefined ||
                input.target !== undefined ||
                input.acceptanceCriteria !== undefined ||
                input.status !== undefined,
            {
                message: '변경할 필드가 하나 이상 필요합니다.'
            }),
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false
            }
        },
        async input => {
            try {
                const projectRoot = requireProjectRoot(
                    input.projectRoot,
                    configuredProjectRoot
                );
                const task = updateTask(projectRoot, input.id, {
                    instruction: input.instruction,
                    target: input.target
                        ? normalizeProjectPaths(projectRoot, input.target)
                        : undefined,
                    acceptanceCriteria: input.acceptanceCriteria,
                    status: input.status
                });

                return task
                    ? successResult({ task })
                    : errorResult(
                        new Error(`작업 ${input.id}을 찾을 수 없습니다.`)
                    );
            }
            catch (error) {
                return errorResult(error);
            }
        }
    );

    server.registerTool(
        'get_config',
        {
            title: 'Get configuration',
            description:
                'Read role, executor, verification, and limit settings.',
            inputSchema: z.object({
                ...projectRootInputShape
            }),
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false
            }
        },
        async ({ projectRoot: requestedProjectRoot }) => {
            const projectRoot = requireProjectRoot(
                requestedProjectRoot,
                configuredProjectRoot
            );
            return successResult({
                projectRoot,
                config: readConfigOrDefault(projectRoot)
            });
        }
    );

    server.registerTool(
        'update_config',
        {
            title: 'Update configuration',
            description: 'Update selected LLM Co-op configuration fields.',
            inputSchema: z.object({
                ...projectRootInputShape,
                defaultExecutor: z.string().trim().min(1).optional(),
                roleExecutors: z.object({
                    planner: z.string().trim().min(1).optional(),
                    coder: z.string().trim().min(1).optional(),
                    reviewer: z.string().trim().min(1).optional()
                }).optional(),
                maxIterations: z.number().int().positive().optional(),
                timeoutSeconds: z.number().int().positive().optional(),
                plannerInstructions: z.string().trim().min(1).optional(),
                reviewerInstructions: z.string().trim().min(1).optional()
            }).refine(input => [
                input.defaultExecutor,
                input.roleExecutors,
                input.maxIterations,
                input.timeoutSeconds,
                input.plannerInstructions,
                input.reviewerInstructions
            ].some(value => value !== undefined), {
                message: '변경할 설정이 하나 이상 필요합니다.'
            }),
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false
            }
        },
        async input => {
            try {
                const projectRoot = requireProjectRoot(
                    input.projectRoot,
                    configuredProjectRoot
                );
                const config = readConfigOrDefault(projectRoot);
                const requestedExecutors = [
                    input.defaultExecutor,
                    input.roleExecutors?.planner,
                    input.roleExecutors?.coder,
                    input.roleExecutors?.reviewer
                ].filter((name): name is string =>
                    name !== undefined && name !== 'default'
                );

                for (const executorName of requestedExecutors) {
                    requireConfiguredExecutor(config, executorName);
                }

                config.defaultExecutor = input.defaultExecutor ??
                    config.defaultExecutor;
                config.roles.planner.executor =
                    input.roleExecutors?.planner ??
                    config.roles.planner.executor;
                config.roles.coder.executor =
                    input.roleExecutors?.coder ??
                    config.roles.coder.executor;
                config.roles.reviewer.executor =
                    input.roleExecutors?.reviewer ??
                    config.roles.reviewer.executor;

                config.limits.maxIterations =
                    input.maxIterations ?? config.limits.maxIterations;
                config.limits.timeoutSeconds =
                    input.timeoutSeconds ?? config.limits.timeoutSeconds;
                config.roles.planner.instructions =
                    input.plannerInstructions ??
                    config.roles.planner.instructions;
                config.roles.reviewer.instructions =
                    input.reviewerInstructions ??
                    config.roles.reviewer.instructions;

                writeConfig(projectRoot, config);
                return successResult({ config });
            }
            catch (error) {
                return errorResult(error);
            }
        }
    );

    server.registerTool(
        'start_run',
        {
            title: 'Start agent run',
            description:
                'Create a run with a snapshot of the current role-to-executor bindings.',
            inputSchema: z.object({
                ...projectRootInputShape,
                goal: z.string().trim().min(1),
                constraints: z.array(
                    z.string().trim().min(1)
                ).default([]),
                doneWhen: z.array(
                    z.string().trim().min(1)
                ).default([])
            }),
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: false,
                openWorldHint: false
            }
        },
        async ({
            projectRoot: requestedProjectRoot,
            goal,
            constraints,
            doneWhen
        }) => {
            const projectRoot = requireProjectRoot(
                requestedProjectRoot,
                configuredProjectRoot
            );
            const config = readConfigOrDefault(projectRoot);
            const run = startRun(
                projectRoot,
                goal,
                config.limits.maxIterations,
                {
                    defaultExecutor: config.defaultExecutor,
                    roleExecutors: getRoleExecutorBindings(config)
                },
                { constraints, doneWhen }
            );
            appendHistory(projectRoot, {
                runId: run.id,
                type: 'run_started',
                message: goal
            });
            return successResult({ run });
        }
    );

    server.registerTool(
        'list_runs',
        {
            title: 'List agent runs',
            description: 'List runs, optionally filtered by phase.',
            inputSchema: z.object({
                ...projectRootInputShape,
                phase: runPhaseSchema.optional()
            }),
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false
            }
        },
        async ({ projectRoot: requestedProjectRoot, phase }) => {
            const projectRoot = requireProjectRoot(
                requestedProjectRoot,
                configuredProjectRoot
            );
            const runs = readRuns(projectRoot).filter(run =>
                phase === undefined || run.phase === phase
            );
            return successResult({ runs });
        }
    );

    server.registerTool(
        'get_run',
        {
            title: 'Get agent run',
            description: 'Get a run and its active tasks.',
            inputSchema: z.object({
                ...projectRootInputShape,
                runId: z.string().trim().min(1)
            }),
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false
            }
        },
        async ({ projectRoot: requestedProjectRoot, runId }) => {
            try {
                const projectRoot = requireProjectRoot(
                    requestedProjectRoot,
                    configuredProjectRoot
                );
                const run = requireRun(projectRoot, runId);
                const tasks = run.taskIds
                    .map(taskId => getTask(projectRoot, taskId))
                    .filter(task => task !== null);
                return successResult({ run, tasks });
            }
            catch (error) {
                return errorResult(error);
            }
        }
    );

    server.registerTool(
        'get_next_action',
        {
            title: 'Get next agent action',
            description:
                'Resolve the current role, assigned executor, host match, and handoff checkpoint.',
            inputSchema: z.object({
                ...projectRootInputShape,
                runId: z.string().trim().min(1),
                taskId: z.number().int().positive().optional()
            }),
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false
            }
        },
        async ({ projectRoot: requestedProjectRoot, runId, taskId }) => {
            try {
                const projectRoot = requireProjectRoot(
                    requestedProjectRoot,
                    configuredProjectRoot
                );
                const run = requireRun(projectRoot, runId);
                const tasks = getRunTasks(projectRoot, run);
                const role = getRoleForPhase(run.phase);

                if (!role) {
                    return successResult({
                        run,
                        assignment: run.phase === RunPhase.Verifying
                            ? {
                                role: 'verifier',
                                executor: 'command'
                            }
                            : null,
                        currentHost,
                        handoff: createHandoff(
                            run,
                            projectRoot,
                            tasks,
                            null,
                            currentHost
                        )
                    });
                }

                const selectedTaskId = taskId ?? (
                    role === 'coder'
                        ? tasks.find(task =>
                            task.status !== TaskStatus.Completed
                        )?.id
                        : undefined
                );
                const selectedExecutor = resolveRunExecutor(
                    run,
                    role,
                    selectedTaskId
                );
                const config = readConfigOrDefault(projectRoot);
                requireConfiguredExecutor(
                    config,
                    selectedExecutor.executor
                );
                const requiresHandoff =
                    selectedExecutor.executor !== currentHost;

                return successResult({
                    run,
                    currentHost,
                    assignment: {
                        role,
                        taskId: selectedTaskId,
                        ...selectedExecutor,
                        requiresHandoff
                    },
                    handoff: createHandoff(
                        run,
                        projectRoot,
                        tasks,
                        role,
                        currentHost,
                        selectedExecutor
                    )
                });
            }
            catch (error) {
                return errorResult(error);
            }
        }
    );

    server.registerTool(
        'switch_executor',
        {
            title: 'Switch executor assignment',
            description:
                'Override the assigned program for the current step, one role, or the rest of a run.',
            inputSchema: z.object({
                ...projectRootInputShape,
                runId: z.string().trim().min(1),
                executor: z.string().trim().min(1),
                scope: executorSwitchScopeSchema,
                role: agentRoleSchema.optional(),
                taskId: z.number().int().positive().optional(),
                reason: z.string().trim().min(1)
            }),
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: false,
                openWorldHint: false
            }
        },
        async ({
            projectRoot: requestedProjectRoot,
            runId,
            executor,
            scope,
            role,
            taskId,
            reason
        }) => {
            try {
                const projectRoot = requireProjectRoot(
                    requestedProjectRoot,
                    configuredProjectRoot
                );
                const run = requireRun(projectRoot, runId);
                const config = readConfigOrDefault(projectRoot);
                requireConfiguredExecutor(config, executor);

                if (
                    run.phase === RunPhase.Completed ||
                    run.phase === RunPhase.Failed ||
                    run.phase === RunPhase.Blocked
                ) {
                    throw new Error(
                        `${run.phase} 상태의 실행은 실행자를 교체할 수 없습니다.`
                    );
                }

                if (scope === 'role' && !role) {
                    throw new Error('role 범위에는 role 값이 필요합니다.');
                }
                if (scope !== 'currentStep' && taskId !== undefined) {
                    throw new Error(
                        'taskId는 currentStep 범위에서만 사용할 수 있습니다.'
                    );
                }
                if (taskId !== undefined && !run.taskIds.includes(taskId)) {
                    throw new Error(
                        `작업 ${taskId}은 현재 실행에 속하지 않습니다.`
                    );
                }
                if (scope === 'currentStep') {
                    const phaseRole = getRoleForPhase(run.phase);

                    if (!phaseRole) {
                        throw new Error(
                            '현재 단계는 실행자를 교체할 수 있는 역할 단계가 아닙니다.'
                        );
                    }
                    if (role && role !== phaseRole) {
                        throw new Error(
                            `현재 단계의 역할은 ${phaseRole}입니다.`
                        );
                    }
                    if (taskId !== undefined && phaseRole !== 'coder') {
                        throw new Error(
                            'taskId 단위 전환은 coding 단계에서만 가능합니다.'
                        );
                    }
                }

                const updatedRun = switchRunExecutor(projectRoot, runId, {
                    scope,
                    executor,
                    role,
                    taskId,
                    reason
                });

                appendHistory(projectRoot, {
                    runId,
                    taskId,
                    type: 'executor_switched',
                    message: `${scope}: ${executor} (${reason})`
                });

                const tasks = updatedRun
                    ? getRunTasks(projectRoot, updatedRun)
                    : [];
                const activeRole = updatedRun
                    ? getRoleForPhase(updatedRun.phase)
                    : null;
                const selectedExecutor = updatedRun && activeRole
                    ? resolveRunExecutor(updatedRun, activeRole, taskId)
                    : undefined;

                return successResult({
                    run: updatedRun,
                    handoff: updatedRun
                        ? createHandoff(
                            updatedRun,
                            projectRoot,
                            tasks,
                            activeRole,
                            currentHost,
                            selectedExecutor
                        )
                        : null
                });
            }
            catch (error) {
                return errorResult(error);
            }
        }
    );

    server.registerTool(
        'dispatch_role',
        {
            title: 'Dispatch planner or reviewer',
            description:
                'Return a local prompt when this host owns the role, otherwise return an executor handoff.',
            inputSchema: z.object({
                ...projectRootInputShape,
                runId: z.string().trim().min(1),
                role: z.enum(['planner', 'reviewer'])
            }),
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: false,
                openWorldHint: true
            }
        },
        async ({ projectRoot: requestedProjectRoot, runId, role }) => {
            try {
                const projectRoot = requireProjectRoot(
                    requestedProjectRoot,
                    configuredProjectRoot
                );
                const run = requireRun(projectRoot, runId);
                const phaseRole = getRoleForPhase(run.phase);

                if (phaseRole !== role) {
                    throw new Error(
                        `현재 단계의 역할은 ${phaseRole ?? '없음'}입니다.`
                    );
                }

                const config = readConfigOrDefault(projectRoot);
                const selectedExecutor = resolveRunExecutor(run, role);
                requireConfiguredExecutor(
                    config,
                    selectedExecutor.executor
                );
                const tasks = getRunTasks(projectRoot, run);
                const prompt = buildRolePrompt(
                    run,
                    role,
                    config.roles[role].instructions,
                    tasks
                );
                const assignment = {
                    role,
                    ...selectedExecutor,
                    currentHost,
                    requiresHandoff:
                        selectedExecutor.executor !== currentHost
                };

                if (selectedExecutor.executor !== currentHost) {
                    return successResult({
                        run,
                        assignment,
                        requiresHandoff: true,
                        targetExecutor: selectedExecutor.executor,
                        handoff: createHandoff(
                            run,
                            projectRoot,
                            tasks,
                            role,
                            currentHost,
                            selectedExecutor
                        ),
                        nextTool: 'get_next_action'
                    });
                }

                appendHistory(projectRoot, {
                    runId,
                    type: `${role}_started`,
                    message: currentHost
                });

                return successResult({
                    run,
                    assignment,
                    requiresCurrentChat: true,
                    prompt,
                    handoff: createHandoff(
                        run,
                        projectRoot,
                        tasks,
                        role,
                        currentHost,
                        selectedExecutor
                    ),
                    nextTool: role === 'planner'
                        ? 'save_plan'
                        : 'submit_review'
                });
            }
            catch (error) {
                return errorResult(error);
            }
        }
    );

    server.registerTool(
        'save_plan',
        {
            title: 'Save planner output',
            description:
                'Save the current chat planner output and move the run to coding.',
            inputSchema: z.object({
                ...projectRootInputShape,
                runId: z.string().trim().min(1),
                tasks: z.array(z.object({
                    instruction: z.string().trim().min(1),
                    target: z.array(
                        z.string().trim().min(1)
                    ).min(1),
                    acceptanceCriteria: z.array(
                        z.string().trim().min(1)
                    ).min(1)
                })).min(1)
            }),
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: false,
                openWorldHint: false
            }
        },
        async ({ projectRoot: requestedProjectRoot, runId, tasks }) => {
            try {
                const projectRoot = requireProjectRoot(
                    requestedProjectRoot,
                    configuredProjectRoot
                );
                const run = requireRun(projectRoot, runId);

                if (run.phase !== RunPhase.Planning) {
                    throw new Error('planning 단계에서만 계획을 저장할 수 있습니다.');
                }

                requireHostOwnsRole(
                    readConfigOrDefault(projectRoot),
                    run,
                    'planner',
                    currentHost
                );

                const normalizedTasks = tasks.map(task => ({
                    ...task,
                    target: normalizeProjectPaths(
                        projectRoot,
                        task.target
                    )
                }));
                const createdTasks = normalizedTasks.map(task =>
                    createTask(projectRoot, {
                        runId,
                        ...task
                    })
                );
                const updatedRun = saveRunPlan(
                    projectRoot,
                    runId,
                    createdTasks.map(task => task.id)
                );

                appendHistory(projectRoot, {
                    runId,
                    type: 'plan_saved',
                    message: `${createdTasks.length}개 작업을 계획했습니다.`
                });
                return successResult({
                    run: updatedRun,
                    tasks: createdTasks
                });
            }
            catch (error) {
                return errorResult(error);
            }
        }
    );

    server.registerTool(
        'dispatch_coder',
        {
            title: 'Dispatch selected coder',
            description:
                'Return a local coding handoff when this host owns the task, otherwise route it to the assigned executor.',
            inputSchema: z.object({
                ...projectRootInputShape,
                runId: z.string().trim().min(1),
                taskId: z.number().int().positive()
            }),
            annotations: {
                readOnlyHint: false,
                destructiveHint: true,
                idempotentHint: false,
                openWorldHint: false
            }
        },
        async ({ projectRoot: requestedProjectRoot, runId, taskId }) => {
            try {
                const projectRoot = requireProjectRoot(
                    requestedProjectRoot,
                    configuredProjectRoot
                );
                const run = requireRun(projectRoot, runId);
                const task = getTask(projectRoot, taskId);

                if (run.phase !== RunPhase.Coding) {
                    throw new Error('coding 단계에서만 Coder를 실행할 수 있습니다.');
                }
                if (!task || !run.taskIds.includes(taskId)) {
                    throw new Error('현재 실행에 포함된 작업이 아닙니다.');
                }
                if (task.status === TaskStatus.Running) {
                    throw new Error('이미 실행 중인 작업입니다.');
                }

                const config = readConfigOrDefault(projectRoot);
                const selectedExecutor = resolveRunExecutor(
                    run,
                    'coder',
                    taskId
                );
                requireConfiguredExecutor(
                    config,
                    selectedExecutor.executor
                );
                const assignment = {
                    role: 'coder',
                    taskId,
                    ...selectedExecutor,
                    currentHost,
                    requiresHandoff:
                        selectedExecutor.executor !== currentHost
                };

                if (selectedExecutor.executor !== currentHost) {
                    return successResult({
                        run,
                        task,
                        assignment,
                        requiresHandoff: true,
                        targetExecutor: selectedExecutor.executor,
                        handoff: createHandoff(
                            run,
                            projectRoot,
                            getRunTasks(projectRoot, run),
                            'coder',
                            currentHost,
                            selectedExecutor
                        ),
                        nextTool: 'get_next_action'
                    });
                }

                updateTask(projectRoot, taskId, {
                    status: TaskStatus.Running,
                    result: null
                });
                appendHistory(projectRoot, {
                    runId,
                    taskId,
                    type: 'coder_started',
                    message: `${currentHost}: ${task.instruction}`
                });

                return successResult({
                    run: getRun(projectRoot, runId),
                    task: getTask(projectRoot, taskId),
                    assignment,
                    requiresCurrentChat: true,
                    handoff: createHandoff(
                        run,
                        projectRoot,
                        getRunTasks(projectRoot, run),
                        'coder',
                        currentHost,
                        selectedExecutor
                    ),
                    nextTool: 'submit_coder_result'
                });
            }
            catch (error) {
                return errorResult(error);
            }
        }
    );

    server.registerTool(
        'submit_coder_result',
        {
            title: 'Submit current-chat coder result',
            description:
                'Record a coder result after the assigned interactive host completes the task.',
            inputSchema: z.object({
                ...projectRootInputShape,
                runId: z.string().trim().min(1),
                taskId: z.number().int().positive(),
                success: z.boolean(),
                summary: z.string().trim().min(1)
            }),
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: false,
                openWorldHint: false
            }
        },
        async ({
            projectRoot: requestedProjectRoot,
            runId,
            taskId,
            success,
            summary
        }) => {
            try {
                const projectRoot = requireProjectRoot(
                    requestedProjectRoot,
                    configuredProjectRoot
                );
                const run = requireRun(projectRoot, runId);
                const task = getTask(projectRoot, taskId);

                if (run.phase !== RunPhase.Coding) {
                    throw new Error(
                        'coding 단계에서만 Coder 결과를 제출할 수 있습니다.'
                    );
                }
                if (!task || !run.taskIds.includes(taskId)) {
                    throw new Error('현재 실행에 포함된 작업이 아닙니다.');
                }

                requireHostOwnsRole(
                    readConfigOrDefault(projectRoot),
                    run,
                    'coder',
                    currentHost,
                    taskId
                );

                const completed = finishCoderTask(
                    projectRoot,
                    run,
                    taskId,
                    success,
                    summary
                );
                appendHistory(projectRoot, {
                    runId,
                    taskId,
                    type: success ? 'coder_completed' : 'coder_failed',
                    message: summary.slice(-1000)
                });

                return successResult(completed);
            }
            catch (error) {
                return errorResult(error);
            }
        }
    );

    server.registerTool(
        'run_verification',
        {
            title: 'Run deterministic verification',
            description:
                'Run only the verification commands configured by the project owner.',
            inputSchema: z.object({
                ...projectRootInputShape,
                runId: z.string().trim().min(1)
            }),
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: false,
                openWorldHint: false
            }
        },
        async ({ projectRoot: requestedProjectRoot, runId }) => {
            try {
                const projectRoot = requireProjectRoot(
                    requestedProjectRoot,
                    configuredProjectRoot
                );
                const run = requireRun(projectRoot, runId);

                if (run.phase !== RunPhase.Verifying) {
                    throw new Error(
                        'verifying 단계에서만 검증을 실행할 수 있습니다.'
                    );
                }

                const config = readConfigOrDefault(projectRoot);
                const verification = await runVerificationCommands(
                    projectRoot,
                    config.roles.verifier.commands,
                    config.limits.timeoutSeconds
                );
                const updatedRun = recordVerification(
                    projectRoot,
                    runId,
                    verification
                );

                appendHistory(projectRoot, {
                    runId,
                    type: 'verification_completed',
                    message: verification.success
                        ? '모든 검증 명령이 통과했습니다.'
                        : '하나 이상의 검증 명령이 실패했습니다.'
                });
                return successResult({
                    run: updatedRun,
                    verification
                });
            }
            catch (error) {
                return errorResult(error);
            }
        }
    );

    server.registerTool(
        'submit_review',
        {
            title: 'Submit reviewer decision',
            description:
                'Store the current chat reviewer decision after examining the goal, diff, and verification result.',
            inputSchema: z.object({
                ...projectRootInputShape,
                runId: z.string().trim().min(1),
                verdict: reviewVerdictSchema,
                summary: z.string().trim().min(1),
                issues: z.array(z.object({
                    severity: z.enum(['critical', 'major', 'minor']),
                    description: z.string().trim().min(1),
                    file: z.string().trim().min(1).optional()
                })).default([])
            }),
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false
            }
        },
        async ({
            projectRoot: requestedProjectRoot,
            runId,
            verdict,
            summary,
            issues
        }) => {
            try {
                const projectRoot = requireProjectRoot(
                    requestedProjectRoot,
                    configuredProjectRoot
                );
                const run = requireRun(projectRoot, runId);

                if (run.phase !== RunPhase.Reviewing) {
                    throw new Error(
                        'reviewing 단계에서만 리뷰를 제출할 수 있습니다.'
                    );
                }

                requireHostOwnsRole(
                    readConfigOrDefault(projectRoot),
                    run,
                    'reviewer',
                    currentHost
                );

                const normalizedIssues: ReviewIssue[] = issues.map(issue => ({
                    ...issue,
                    file: issue.file
                        ? normalizeProjectPaths(
                            projectRoot,
                            [issue.file]
                        )[0]
                        : undefined
                }));
                const review = {
                    verdict,
                    summary,
                    issues: normalizedIssues,
                    completedAt: new Date().toISOString()
                };
                const updatedRun = recordReview(
                    projectRoot,
                    runId,
                    review
                );

                appendHistory(projectRoot, {
                    runId,
                    type: 'review_submitted',
                    message: `${verdict}: ${summary}`
                });
                return successResult({ run: updatedRun, review });
            }
            catch (error) {
                return errorResult(error);
            }
        }
    );

    server.registerTool(
        'retry_run',
        {
            title: 'Retry agent run',
            description:
                'Route a reviewed run back to planning, coding, or verification.',
            inputSchema: z.object({
                ...projectRootInputShape,
                runId: z.string().trim().min(1),
                route: z.enum(['planner', 'coder', 'verifier']),
                reason: z.string().trim().min(1),
                taskIds: z.array(
                    z.number().int().positive()
                ).optional()
            }),
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: false,
                openWorldHint: false
            }
        },
        async ({
            projectRoot: requestedProjectRoot,
            runId,
            route,
            reason,
            taskIds
        }) => {
            try {
                const projectRoot = requireProjectRoot(
                    requestedProjectRoot,
                    configuredProjectRoot
                );
                const run = requireRun(projectRoot, runId);

                if (run.phase !== RunPhase.Reviewing) {
                    throw new Error(
                        '리뷰가 끝난 실행만 재시도할 수 있습니다.'
                    );
                }

                requireHostOwnsRole(
                    readConfigOrDefault(projectRoot),
                    run,
                    'reviewer',
                    currentHost
                );

                const phase = route === 'planner'
                    ? RunPhase.Planning
                    : route === 'coder'
                        ? RunPhase.Coding
                        : RunPhase.Verifying;
                const selectedTaskIds = taskIds ?? run.taskIds;

                if (route === 'coder') {
                    for (const taskId of selectedTaskIds) {
                        if (!run.taskIds.includes(taskId)) {
                            throw new Error(
                                `작업 ${taskId}은 현재 실행에 속하지 않습니다.`
                            );
                        }
                    }
                }

                const updatedRun = retryRun(
                    projectRoot,
                    runId,
                    phase,
                    reason
                );

                if (!updatedRun) {
                    throw new Error(`실행 ${runId}을 갱신하지 못했습니다.`);
                }

                if (
                    route === 'coder' &&
                    updatedRun.phase !== RunPhase.Blocked
                ) {
                    for (const taskId of selectedTaskIds) {
                        updateTask(projectRoot, taskId, {
                            status: TaskStatus.Pending,
                            result: null
                        });
                    }
                }

                appendHistory(projectRoot, {
                    runId,
                    type: updatedRun.phase === RunPhase.Blocked
                        ? 'run_blocked'
                        : 'run_retried',
                    message: `${route}: ${reason}`
                });
                return successResult({ run: updatedRun });
            }
            catch (error) {
                return errorResult(error);
            }
        }
    );

    server.registerTool(
        'complete_run',
        {
            title: 'Complete agent run',
            description:
                'Complete a run only after verification passed and review verdict is pass.',
            inputSchema: z.object({
                ...projectRootInputShape,
                runId: z.string().trim().min(1)
            }),
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false
            }
        },
        async ({ projectRoot: requestedProjectRoot, runId }) => {
            try {
                const projectRoot = requireProjectRoot(
                    requestedProjectRoot,
                    configuredProjectRoot
                );
                const run = requireRun(projectRoot, runId);

                requireHostOwnsRole(
                    readConfigOrDefault(projectRoot),
                    run,
                    'reviewer',
                    currentHost
                );

                if (!run.verification?.success) {
                    throw new Error('검증이 통과되지 않았습니다.');
                }
                if (run.review?.verdict !== 'pass') {
                    throw new Error('Reviewer의 pass 판정이 필요합니다.');
                }

                const updatedRun = completeRun(projectRoot, runId);
                appendHistory(projectRoot, {
                    runId,
                    type: 'run_completed',
                    message: run.goal
                });
                return successResult({ run: updatedRun });
            }
            catch (error) {
                return errorResult(error);
            }
        }
    );

    server.registerTool(
        'get_history',
        {
            title: 'Get run history',
            description: 'Read recent workflow events.',
            inputSchema: z.object({
                ...projectRootInputShape,
                runId: z.string().trim().min(1).optional(),
                limit: z.number().int().positive().max(500).default(100)
            }),
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false
            }
        },
        async ({ projectRoot: requestedProjectRoot, runId, limit }) => {
            const projectRoot = requireProjectRoot(
                requestedProjectRoot,
                configuredProjectRoot
            );
            return successResult({
                projectRoot,
                history: getHistory(projectRoot, runId, limit)
            });
        }
    );

    return server;
}

function main(): void {
    let configuredProjectRoot: string | null;
    let currentHost: string;

    try {
        configuredProjectRoot = resolveConfiguredProjectRoot();
        currentHost = resolveCurrentHost();
    }
    catch (error) {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
        return;
    }

    console.error(
        `llm-co-op MCP server: ${
            configuredProjectRoot ?? 'dynamic project selection'
        } (${currentHost})`
    );
    serveStdio(
        () => createServer(configuredProjectRoot, currentHost),
        {
            onerror: error => {
                console.error(error);
            }
        }
    );
}

main();
