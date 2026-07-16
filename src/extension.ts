import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

let isUpdating = false;

/* ============================================================
    Interfaces
============================================================ */

enum TaskStatus {
    Pending = "pending",
    Running = "running",
    Completed = "completed",
    Failed = "failed"
}

interface Config {

    model: string;

}

interface TaskLog {

    id: number;

    instruction: string;

    target: string[];

    status: TaskStatus;

    time: string;

}

interface LLMFile {

    path: string;

    content: string;

}

interface LLMResult {

    files: LLMFile[];

}

/* ============================================================
    Activate
============================================================ */

export function activate(
    context: vscode.ExtensionContext
) {

    console.log("LLM Co-op Activated");

    const saveListener =
        vscode.workspace.onDidSaveTextDocument(

            async (document) => {

                if (isUpdating) {
                    return;
                }

                const workspace =
                    vscode.workspace.workspaceFolders?.[0];

                if (!workspace) {
                    return;
                }

                const projectRoot =
                    workspace.uri.fsPath;

                console.log(
                    "Saved :",
                    document.fileName
                );

                const config =
                    readConfig(projectRoot);

                if (!config) {

                    vscode.window.showErrorMessage(
                        "config.json을 찾을 수 없습니다."
                    );

                    return;
                }

                const task =
                    readTask(projectRoot);

                if (!task) {

                    console.log(
                        "실행할 작업이 없습니다."
                    );

                    return;
                }

                updateTaskStatus(
                    projectRoot,
                    task.id,
                    TaskStatus.Running
                );

                try {

                    isUpdating = true;

                    const prompt =
                        buildPrompt(
                            projectRoot,
                            task
                        );

                    const answer =
                        await askOllama(
                            config.model,
                            prompt
                        );

                    const result =
                        validateResponse(
                            answer
                        );

                    if (!result) {

                        updateTaskStatus(
                            projectRoot,
                            task.id,
                            TaskStatus.Failed
                        );

                        return;
                    }

                    await applyChanges(
                        projectRoot,
                        result
                    );

                    updateTaskStatus(
                        projectRoot,
                        task.id,
                        TaskStatus.Completed
                    );

                    vscode.window.showInformationMessage(
                        "LLM 작업 완료"
                    );

                }
                catch (err) {

                    console.error(err);

                    updateTaskStatus(
                        projectRoot,
                        task.id,
                        TaskStatus.Failed
                    );

                    vscode.window.showErrorMessage(
                        "LLM 작업 실패"
                    );

                }
                finally {

                    isUpdating = false;

                }

            });

    context.subscriptions.push(
        saveListener
    );

}
function readConfig(
    projectRoot: string
): Config | null {

    const configPath =
        path.join(
            projectRoot,
            ".llm-co-op",
            "config.json"
        );

    if (!fs.existsSync(configPath)) {
        return null;
    }

    return JSON.parse(
        fs.readFileSync(
            configPath,
            "utf8"
        )
    ) as Config;

}
function readTask(
    projectRoot: string
): TaskLog | null {

    const taskPath =
        path.join(
            projectRoot,
            ".llm-co-op",
            "task.json"
        );

    if (!fs.existsSync(taskPath)) {
        return null;
    }

    const tasks =
        JSON.parse(
            fs.readFileSync(
                taskPath,
                "utf8"
            )
        ) as TaskLog[];

    if (!Array.isArray(tasks)) {
        return null;
    }

    /* 실행 중인 작업 확인 */

    const running =
        tasks.find(
            t => t.status === TaskStatus.Running
        );

    if (running) {

        console.log(
            `Running Task : ${running.id}`
        );

        return null;
    }

    /* 가장 최근 Pending */

    for (
        let i = tasks.length - 1;
        i >= 0;
        i--
    ) {

        if (
            tasks[i].status ===
            TaskStatus.Pending
        ) {

            return tasks[i];

        }

    }

    return null;

}
/* ============================================================
    Update Task Status
============================================================ */

function updateTaskStatus(
    projectRoot: string,
    taskId: number,
    status: TaskStatus
): void {

    const taskPath = path.join(
        projectRoot,
        ".llm-co-op",
        "task.json"
    );

    if (!fs.existsSync(taskPath)) {
        return;
    }

    const tasks = JSON.parse(
        fs.readFileSync(
            taskPath,
            "utf8"
        )
    ) as TaskLog[];

    const task = tasks.find(
        t => t.id === taskId
    );

    if (!task) {
        return;
    }

    task.status = status;

    fs.writeFileSync(
        taskPath,
        JSON.stringify(tasks, null, 4),
        "utf8"
    );

}
/* ============================================================
    Prompt Builder
============================================================ */

function buildPrompt(
    projectRoot: string,
    task: TaskLog
): string {

    let prompt = "";

    prompt +=
`당신은 코드 수정 전문가입니다.

반드시 JSON만 출력하십시오.

{
    "files": [
        {
            "path": "파일경로",
            "content": "수정된 전체 코드"
        }
    ]
}

설명은 출력하지 마십시오.
코드블록(\`\`\`)도 출력하지 마십시오.

`;

    prompt +=
`작업 내용

${task.instruction}

`;

    prompt +=
`수정 대상 파일

`;

    for (const file of task.target) {

        const filePath = path.join(
            projectRoot,
            file
        );

        if (!fs.existsSync(filePath)) {

            console.warn(
                `파일 없음 : ${file}`
            );

            continue;

        }

        const content =
            fs.readFileSync(
                filePath,
                "utf8"
            );

        prompt +=
`==================================================
FILE : ${file}
==================================================

${content}

`;

    }

    return prompt;

}
/* ============================================================
    Ollama
============================================================ */

async function askOllama(
    model: string,
    prompt: string
): Promise<string> {

    const response = await fetch(

        "http://127.0.0.1:11434/api/generate",

        {

            method: "POST",

            headers: {

                "Content-Type": "application/json"

            },

            body: JSON.stringify({

                model,

                prompt,

                stream: false

            })

        }

    );

    if (!response.ok) {

        throw new Error(

            `Ollama Error : ${response.status}`

        );

    }

    const data = await response.json();

    if (

        typeof data === "object" &&
        data !== null &&
        "response" in data &&
        typeof data.response === "string"

    ) {

        return data.response;

    }

    throw new Error(
        "Ollama 응답 형식이 올바르지 않습니다."
    );

}
/* ============================================================
    Validate Response
============================================================ */

function validateResponse(
    answer: string
): LLMResult | null {

    try {

        let text = answer.trim();

        if (text.startsWith("```")) {

            text = text
                .replace(/^```json\s*/, "")
                .replace(/^```\s*/, "")
                .replace(/\s*```$/, "");

        }

        const result =
            JSON.parse(text);

        if (
            typeof result !== "object" ||
            result === null ||
            !("files" in result) ||
            !Array.isArray(result.files)
        ) {

            vscode.window.showErrorMessage(
                "LLM 응답 형식이 올바르지 않습니다."
            );

            return null;

        }

        return result as LLMResult;

    }
    catch (err) {

        console.error(err);

        vscode.window.showErrorMessage(
            "LLM 응답을 JSON으로 변환하지 못했습니다."
        );

        return null;

    }

}
/* ============================================================
    Apply Changes
============================================================ */

async function applyChanges(
    projectRoot: string,
    result: LLMResult
): Promise<void> {

    const edit = new vscode.WorkspaceEdit();

    const newFiles: {
        path: string;
        content: string;
    }[] = [];

    for (const file of result.files) {

        const filePath = path.join(
            projectRoot,
            file.path
        );

        // 기존 파일이면 수정
        if (fs.existsSync(filePath)) {

            const uri =
                vscode.Uri.file(filePath);

            const document =
                await vscode.workspace.openTextDocument(
                    uri
                );

            const fullRange =
                new vscode.Range(
                    document.positionAt(0),
                    document.positionAt(
                        document.getText().length
                    )
                );

            edit.replace(
                uri,
                fullRange,
                file.content
            );

        }
        // 새 파일이면 나중에 생성
        else {

            newFiles.push({
                path: filePath,
                content: file.content
            });

        }

    }

    // 기존 파일 수정
    await vscode.workspace.applyEdit(edit);

    // 수정된 파일 저장
    for (const file of result.files) {

        const filePath = path.join(
            projectRoot,
            file.path
        );

        if (!fs.existsSync(filePath)) {
            continue;
        }

        const uri =
            vscode.Uri.file(filePath);

        const document =
            await vscode.workspace.openTextDocument(
                uri
            );

        if (document.isDirty) {
            await document.save();
        }

    }

    // 새 파일 생성
    for (const file of newFiles) {

        const dir =
            path.dirname(file.path);

        fs.mkdirSync(
            dir,
            { recursive: true }
        );

        fs.writeFileSync(
            file.path,
            file.content,
            "utf8"
        );

    }

}
/* ============================================================
    Deactivate
============================================================ */

export function deactivate() {

    console.log(
        "LLM Co-op Deactivated"
    );

}