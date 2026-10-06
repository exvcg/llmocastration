import * as vscode from 'vscode';

export function activate(
    _context: vscode.ExtensionContext
): void {
    console.log(
        'LLM Co-op Activated: agent execution is provided by the MCP plugin.'
    );
}

export function deactivate(): void {
    console.log('LLM Co-op Deactivated');
}
