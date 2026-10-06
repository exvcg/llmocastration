import * as path from 'path';
import { randomUUID } from 'crypto';
import { readJsonFile, writeJsonFileAtomic } from './jsonFile';

export interface HistoryEvent {
    id: string;
    runId?: string;
    taskId?: number;
    type: string;
    message: string;
    time: string;
}

function getHistoryPath(projectRoot: string): string {
    return path.join(projectRoot, '.llm-co-op', 'history.json');
}

export function readHistory(projectRoot: string): HistoryEvent[] {
    const history = readJsonFile<HistoryEvent[]>(
        getHistoryPath(projectRoot)
    );
    return Array.isArray(history) ? history : [];
}

export function appendHistory(
    projectRoot: string,
    event: Omit<HistoryEvent, 'id' | 'time'>
): HistoryEvent {
    const history = readHistory(projectRoot);
    const storedEvent: HistoryEvent = {
        ...event,
        id: randomUUID(),
        time: new Date().toISOString()
    };

    history.push(storedEvent);
    writeJsonFileAtomic(getHistoryPath(projectRoot), history);
    return storedEvent;
}

export function getHistory(
    projectRoot: string,
    runId?: string,
    limit = 100
): HistoryEvent[] {
    const history = readHistory(projectRoot);
    const filtered = runId
        ? history.filter(event => event.runId === runId)
        : history;

    return filtered.slice(-Math.max(1, limit));
}
