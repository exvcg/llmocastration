import * as path from 'path';
import { readJsonFile, writeJsonFileAtomic } from './jsonFile';

export enum TaskStatus {
    Pending = 'pending',
    Running = 'running',
    Completed = 'completed',
    Failed = 'failed'
}

export interface TaskExecutionResult {
    success: boolean;
    summary: string;
    finishedAt: string;
}

export interface TaskLog {
    id: number;
    runId?: string;
    instruction: string;
    target: string[];
    acceptanceCriteria: string[];
    assignedRole: 'coder';
    status: TaskStatus;
    time: string;
    updatedAt: string;
    result?: TaskExecutionResult;
}

export interface CreateTaskInput {
    runId?: string;
    instruction: string;
    target: string[];
    acceptanceCriteria?: string[];
    assignedRole?: 'coder';
}

export interface UpdateTaskInput {
    instruction?: string;
    target?: string[];
    acceptanceCriteria?: string[];
    status?: TaskStatus;
    result?: TaskExecutionResult | null;
}

function getTaskPath(projectRoot: string): string {
    return path.join(projectRoot, '.llm-co-op', 'task.json');
}

function normalizeTask(task: TaskLog): TaskLog {
    const timestamp = typeof task.time === 'string'
        ? task.time
        : new Date().toISOString();

    return {
        ...task,
        target: Array.isArray(task.target) ? task.target : [],
        acceptanceCriteria: Array.isArray(task.acceptanceCriteria)
            ? task.acceptanceCriteria
            : [],
        assignedRole: 'coder',
        updatedAt: typeof task.updatedAt === 'string'
            ? task.updatedAt
            : timestamp
    };
}

export function readTasks(projectRoot: string): TaskLog[] | null {
    const tasks = readJsonFile<TaskLog[]>(getTaskPath(projectRoot));

    if (!Array.isArray(tasks)) {
        return null;
    }

    return tasks.map(normalizeTask);
}

export function writeTasks(
    projectRoot: string,
    tasks: TaskLog[]
): void {
    writeJsonFileAtomic(getTaskPath(projectRoot), tasks);
}

export function getTask(
    projectRoot: string,
    taskId: number
): TaskLog | null {
    return readTasks(projectRoot)?.find(
        task => task.id === taskId
    ) ?? null;
}

export function getTasksForRun(
    projectRoot: string,
    runId: string
): TaskLog[] {
    return (readTasks(projectRoot) ?? []).filter(
        task => task.runId === runId
    );
}

export function createTask(
    projectRoot: string,
    input: CreateTaskInput
): TaskLog {
    const tasks = readTasks(projectRoot) ?? [];
    const now = new Date().toISOString();
    const nextId = tasks.reduce(
        (maximumId, task) => Math.max(maximumId, task.id),
        0
    ) + 1;
    const task: TaskLog = {
        id: nextId,
        runId: input.runId,
        instruction: input.instruction,
        target: [...input.target],
        acceptanceCriteria: [...(input.acceptanceCriteria ?? [])],
        assignedRole: input.assignedRole ?? 'coder',
        status: TaskStatus.Pending,
        time: now,
        updatedAt: now
    };

    tasks.push(task);
    writeTasks(projectRoot, tasks);

    return task;
}

export function updateTask(
    projectRoot: string,
    taskId: number,
    input: UpdateTaskInput
): TaskLog | null {
    const tasks = readTasks(projectRoot);
    const task = tasks?.find(item => item.id === taskId);

    if (!tasks || !task) {
        return null;
    }

    if (input.instruction !== undefined) {
        task.instruction = input.instruction;
    }
    if (input.target !== undefined) {
        task.target = [...input.target];
    }
    if (input.acceptanceCriteria !== undefined) {
        task.acceptanceCriteria = [...input.acceptanceCriteria];
    }
    if (input.status !== undefined) {
        task.status = input.status;
    }
    if (input.result !== undefined) {
        task.result = input.result ?? undefined;
    }

    task.updatedAt = new Date().toISOString();
    writeTasks(projectRoot, tasks);

    return task;
}

