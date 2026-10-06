import * as path from 'path';

export function normalizeProjectPath(
    projectRoot: string,
    candidate: string
): string {
    const trimmedCandidate = candidate.trim();

    if (!trimmedCandidate) {
        throw new Error('빈 파일 경로는 사용할 수 없습니다.');
    }

    if (path.isAbsolute(trimmedCandidate)) {
        throw new Error(`절대 경로는 사용할 수 없습니다: ${candidate}`);
    }

    const resolvedRoot = path.resolve(projectRoot);
    const resolvedCandidate = path.resolve(resolvedRoot, trimmedCandidate);
    const relativePath = path.relative(resolvedRoot, resolvedCandidate);

    if (
        !relativePath ||
        relativePath === '..' ||
        relativePath.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativePath)
    ) {
        throw new Error(
            `프로젝트 밖의 경로는 사용할 수 없습니다: ${candidate}`
        );
    }

    return relativePath.replaceAll('\\', '/');
}

export function normalizeProjectPaths(
    projectRoot: string,
    candidates: string[]
): string[] {
    return [
        ...new Set(
            candidates.map(candidate =>
                normalizeProjectPath(projectRoot, candidate)
            )
        )
    ];
}

export function resolveProjectPath(
    projectRoot: string,
    candidate: string
): string {
    return path.resolve(
        projectRoot,
        normalizeProjectPath(projectRoot, candidate)
    );
}
