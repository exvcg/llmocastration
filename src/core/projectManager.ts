import * as fs from 'fs';
import * as path from 'path';
import {
    readConfigOrDefault,
    writeConfig
} from './configManager';

export interface ProjectInitialization {
    projectRoot: string;
    dataDirectory: string;
    createdDataDirectory: boolean;
    createdConfig: boolean;
}

export function resolveProjectRoot(candidate: string): string {
    const trimmed = candidate.trim();

    if (!trimmed) {
        throw new Error('projectRoot가 필요합니다.');
    }
    if (!path.isAbsolute(trimmed)) {
        throw new Error(
            `projectRoot는 절대 경로여야 합니다: ${trimmed}`
        );
    }

    const projectRoot = path.resolve(trimmed);

    if (!fs.existsSync(projectRoot)) {
        throw new Error(
            `프로젝트 경로를 찾을 수 없습니다: ${projectRoot}`
        );
    }
    if (!fs.statSync(projectRoot).isDirectory()) {
        throw new Error(
            `프로젝트 경로가 폴더가 아닙니다: ${projectRoot}`
        );
    }

    return projectRoot;
}

export function initializeProject(candidate: string): ProjectInitialization {
    const projectRoot = resolveProjectRoot(candidate);
    const dataDirectory = path.join(projectRoot, '.llm-co-op');
    const configPath = path.join(dataDirectory, 'config.json');
    const createdDataDirectory = !fs.existsSync(dataDirectory);
    const createdConfig = !fs.existsSync(configPath);

    fs.mkdirSync(dataDirectory, { recursive: true });

    if (createdConfig) {
        writeConfig(projectRoot, readConfigOrDefault(projectRoot));
    }

    return {
        projectRoot,
        dataDirectory,
        createdDataDirectory,
        createdConfig
    };
}
