export const agentRoles = [
    'planner',
    'coder',
    'reviewer'
] as const;

export type AgentRole = typeof agentRoles[number];

export interface RoleExecutorBindings {
    planner: string;
    coder: string;
    reviewer: string;
}

export const executorSwitchScopes = [
    'currentStep',
    'role',
    'remainingRun'
] as const;

export type ExecutorSwitchScope = typeof executorSwitchScopes[number];
