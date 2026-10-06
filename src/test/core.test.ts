import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readConfig } from '../core/configManager';
import { resolveCurrentHost } from '../core/hostContext';
import { normalizeProjectPath } from '../core/pathSafety';
import {
    initializeProject,
    resolveProjectRoot
} from '../core/projectManager';
import {
    completeRun,
    getRun,
    readRuns,
    recordReview,
    recordVerification,
    resolveRunExecutor,
    RunPhase,
    saveRunPlan,
    startRun,
    switchRunExecutor
} from '../core/runManager';
import { createTask } from '../core/taskManager';

suite('Core managers', () => {
    const temporaryDirectories: string[] = [];

    function createProject(): string {
        const projectRoot = fs.mkdtempSync(
            path.join(os.tmpdir(), 'llm-co-op-')
        );
        temporaryDirectories.push(projectRoot);
        return projectRoot;
    }

    teardown(() => {
        for (const directory of temporaryDirectories.splice(0)) {
            const resolved = path.resolve(directory);
            const resolvedTemporaryRoot = path.resolve(os.tmpdir());

            if (resolved.startsWith(`${resolvedTemporaryRoot}${path.sep}`)) {
                fs.rmSync(resolved, { recursive: true, force: true });
            }
        }
    });

    test('loads executor defaults for an obsolete model-only config', () => {
        const projectRoot = createProject();
        const configDirectory = path.join(projectRoot, '.llm-co-op');
        fs.mkdirSync(configDirectory, { recursive: true });
        fs.writeFileSync(
            path.join(configDirectory, 'config.json'),
            JSON.stringify({ model: 'legacy-model' }),
            'utf8'
        );

        const config = readConfig(projectRoot);

        assert.strictEqual(config?.defaultExecutor, 'codex');
        assert.strictEqual(config?.roles.planner.executor, 'default');
        assert.strictEqual(config?.roles.coder.executor, 'antigravity');
        assert.strictEqual(config?.executors.codex.type, 'interactive');
        assert.strictEqual(
            config?.executors.antigravity.type,
            'interactive'
        );
    });

    test('migrates previous Gemini assignments to Antigravity', () => {
        const projectRoot = createProject();
        const configDirectory = path.join(projectRoot, '.llm-co-op');
        fs.mkdirSync(configDirectory, { recursive: true });
        fs.writeFileSync(
            path.join(configDirectory, 'config.json'),
            JSON.stringify({
                defaultModel: 'codex',
                roles: {
                    coder: {
                        executor: 'gemini-cli',
                        command: 'custom-gemini',
                        model: 'gemini-2.5-pro',
                        instructions: 'Implement the task.'
                    }
                }
            }),
            'utf8'
        );

        const config = readConfig(projectRoot);

        assert.strictEqual(config?.defaultExecutor, 'codex');
        assert.strictEqual(config?.roles.coder.executor, 'antigravity');
        assert.strictEqual(
            config?.roles.coder.instructions,
            'Implement the task.'
        );
    });

    test('resolves the current host from an argument or environment', () => {
        assert.strictEqual(
            resolveCurrentHost(['--host', 'Antigravity'], {}),
            'antigravity'
        );
        assert.strictEqual(
            resolveCurrentHost([], { LLM_CO_OP_HOST: 'codex' }),
            'codex'
        );
        assert.throws(() => resolveCurrentHost([], {}));
    });

    test('rejects paths outside the project root', () => {
        const projectRoot = createProject();

        assert.throws(() =>
            normalizeProjectPath(projectRoot, '../outside.ts')
        );
        assert.strictEqual(
            normalizeProjectPath(projectRoot, 'src/index.ts'),
            'src/index.ts'
        );
    });

    test('initializes project-local data without overwriting config', () => {
        const projectRoot = createProject();
        const first = initializeProject(projectRoot);
        const configPath = path.join(
            projectRoot,
            '.llm-co-op',
            'config.json'
        );

        assert.strictEqual(first.projectRoot, path.resolve(projectRoot));
        assert.strictEqual(first.createdDataDirectory, true);
        assert.strictEqual(first.createdConfig, true);
        assert.strictEqual(fs.existsSync(configPath), true);

        const originalConfig = fs.readFileSync(configPath, 'utf8');
        const second = initializeProject(projectRoot);

        assert.strictEqual(second.createdDataDirectory, false);
        assert.strictEqual(second.createdConfig, false);
        assert.strictEqual(fs.readFileSync(configPath, 'utf8'), originalConfig);
    });

    test('requires an existing absolute project root', () => {
        assert.throws(() => resolveProjectRoot('relative-project'));
        assert.throws(() => resolveProjectRoot(
            path.join(os.tmpdir(), 'missing-llm-co-op-project')
        ));
    });

    test('persists the plan, verification, review, and completion', () => {
        const projectRoot = createProject();
        const run = startRun(projectRoot, 'Add a feature', 3);
        const task = createTask(projectRoot, {
            runId: run.id,
            instruction: 'Implement the feature',
            target: ['src/index.ts'],
            acceptanceCriteria: ['Type checking passes']
        });

        saveRunPlan(projectRoot, run.id, [task.id]);
        recordVerification(projectRoot, run.id, {
            success: true,
            commands: [],
            completedAt: new Date().toISOString()
        });
        recordReview(projectRoot, run.id, {
            verdict: 'pass',
            summary: 'Requirements met.',
            issues: [],
            completedAt: new Date().toISOString()
        });
        completeRun(projectRoot, run.id);

        assert.strictEqual(
            getRun(projectRoot, run.id)?.phase,
            RunPhase.Completed
        );
    });

    test('resolves role bindings and executor switches in order', () => {
        const projectRoot = createProject();
        const run = startRun(projectRoot, 'Route executor work', 3, {
            defaultExecutor: 'codex',
            roleExecutors: {
                planner: 'default',
                coder: 'antigravity',
                reviewer: 'default'
            }
        });
        const firstTask = createTask(projectRoot, {
            runId: run.id,
            instruction: 'First task',
            target: ['src/first.ts']
        });
        const secondTask = createTask(projectRoot, {
            runId: run.id,
            instruction: 'Second task',
            target: ['src/second.ts']
        });
        const codingRun = saveRunPlan(
            projectRoot,
            run.id,
            [firstTask.id, secondTask.id]
        );

        assert.ok(codingRun);
        assert.strictEqual(
            resolveRunExecutor(codingRun, 'planner').executor,
            'codex'
        );
        assert.strictEqual(
            resolveRunExecutor(
                codingRun,
                'coder',
                firstTask.id
            ).executor,
            'antigravity'
        );

        const roleSwitched = switchRunExecutor(projectRoot, run.id, {
            scope: 'role',
            executor: 'codex',
            role: 'coder',
            reason: 'Use Codex for coding'
        });
        assert.ok(roleSwitched);
        assert.strictEqual(
            resolveRunExecutor(
                roleSwitched,
                'coder',
                firstTask.id
            ).executor,
            'codex'
        );

        const stepSwitched = switchRunExecutor(projectRoot, run.id, {
            scope: 'currentStep',
            executor: 'antigravity',
            role: 'coder',
            taskId: firstTask.id,
            reason: 'Retry only the first task in Antigravity'
        });
        assert.ok(stepSwitched);
        assert.strictEqual(
            resolveRunExecutor(
                stepSwitched,
                'coder',
                firstTask.id
            ).executor,
            'antigravity'
        );
        assert.strictEqual(
            resolveRunExecutor(
                stepSwitched,
                'coder',
                secondTask.id
            ).executor,
            'codex'
        );

        const fullySwitched = switchRunExecutor(projectRoot, run.id, {
            scope: 'remainingRun',
            executor: 'antigravity',
            reason: 'Move the remaining run to Antigravity'
        });
        assert.ok(fullySwitched);
        assert.strictEqual(
            resolveRunExecutor(
                fullySwitched,
                'coder',
                secondTask.id
            ).executor,
            'antigravity'
        );
        assert.strictEqual(
            resolveRunExecutor(fullySwitched, 'reviewer').executor,
            'antigravity'
        );
        assert.strictEqual(fullySwitched.executorSwitches.length, 3);
    });

    test('migrates stored model-based runs to executor assignments', () => {
        const projectRoot = createProject();
        const dataDirectory = path.join(projectRoot, '.llm-co-op');
        fs.mkdirSync(dataDirectory, { recursive: true });
        fs.writeFileSync(
            path.join(dataDirectory, 'runs.json'),
            JSON.stringify([{
                id: 'legacy-run',
                goal: 'Continue old work',
                constraints: [],
                doneWhen: [],
                phase: RunPhase.Coding,
                taskIds: [],
                iteration: 0,
                maxIterations: 3,
                defaultModel: 'codex',
                roleModels: {
                    planner: 'default',
                    coder: 'gemini',
                    reviewer: 'default'
                },
                modelSwitches: [],
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            }]),
            'utf8'
        );

        const migrated = readRuns(projectRoot)[0];

        assert.strictEqual(migrated.defaultExecutor, 'codex');
        assert.strictEqual(migrated.roleExecutors.coder, 'antigravity');
        assert.deepStrictEqual(migrated.executorSwitches, []);
    });
});
