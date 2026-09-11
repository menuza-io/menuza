import { type NodeTypes } from '@xyflow/react'
import { ActionEmailNode } from './action-email-node.tsx'
import { ActionSmsNode } from './action-sms-node.tsx'
import { ConditionNode } from './condition-node.tsx'
import { DelayNode } from './delay-node.tsx'
import { TriggerNode } from './trigger-node.tsx'

export { TriggerNode, DelayNode, ActionEmailNode, ActionSmsNode, ConditionNode }
export * from './node-shell.tsx'

export const nodeTypes = {
	trigger: TriggerNode,
	delay: DelayNode,
	action_email: ActionEmailNode,
	action_sms: ActionSmsNode,
	condition: ConditionNode,
} satisfies NodeTypes
