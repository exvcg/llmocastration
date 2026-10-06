import * as fs from 'fs';
import * as path from 'path';

export function readJsonFile<T>(filePath: string): T | null {
    if (!fs.existsSync(filePath)) {
        return null;
    }

    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

export function writeJsonFileAtomic<T>(
    filePath: string,
    value: T
): void {
    const directory = path.dirname(filePath);
    const temporaryPath = path.join(
        directory,
        `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`
    );

    fs.mkdirSync(directory, { recursive: true });

    try {
        fs.writeFileSync(
            temporaryPath,
            JSON.stringify(value, null, 4),
            'utf8'
        );
        fs.renameSync(temporaryPath, filePath);
    }
    finally {
        if (fs.existsSync(temporaryPath)) {
            fs.unlinkSync(temporaryPath);
        }
    }
}
