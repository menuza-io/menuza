import {
	FlowNodeShell,
	type FlowNodeShellProps,
	type FlowNodeTone,
} from '@repo/flow-editor'

export type WorkflowNodeKind = 'trigger' | 'delay' | 'condition' | 'action'

const KIND_TONE: Record<WorkflowNodeKind, FlowNodeTone> = {
	trigger: 'primary',
	delay: 'neutral',
	condition: 'warning',
	action: 'info',
}

interface WorkflowNodeShellProps extends Omit<FlowNodeShellProps, 'tone'> {
	kind: WorkflowNodeKind
}

export function WorkflowNodeShell({ kind, ...props }: WorkflowNodeShellProps) {
	return <FlowNodeShell tone={KIND_TONE[kind]} {...props} />
}
