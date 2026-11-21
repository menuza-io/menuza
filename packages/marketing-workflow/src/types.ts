import {
	type TriggerNodeData,
	type DelayNodeData,
	type ActionEmailNodeData,
	type ActionSmsNodeData,
	type ActionPushNodeData,
	type ConditionNodeData,
	type JourneyTriggerType,
	type DelayUnit,
	type ConditionOperator,
	type JourneyStatus,
	type JourneyRunStatus,
	type WorkflowNode,
	type WorkflowGraph,
	type DAGValidationResult,
} from '@repo/tenant-db/types/journey'
import { type Node, type Edge } from '@xyflow/react'

export type {
	TriggerNodeData,
	DelayNodeData,
	ActionEmailNodeData,
	ActionSmsNodeData,
	ActionPushNodeData,
	ConditionNodeData,
	JourneyTriggerType,
	DelayUnit,
	ConditionOperator,
	JourneyStatus,
	JourneyRunStatus,
	WorkflowNode,
	WorkflowGraph,
	DAGValidationResult,
}

// React Flow Node typing aliases
export type TriggerFlowNode = Node<TriggerNodeData, 'trigger'>
export type DelayFlowNode = Node<DelayNodeData, 'delay'>
export type ActionEmailFlowNode = Node<ActionEmailNodeData, 'action_email'>
export type ActionSmsFlowNode = Node<ActionSmsNodeData, 'action_sms'>
export type ActionPushFlowNode = Node<ActionPushNodeData, 'action_push'>
export type ConditionFlowNode = Node<ConditionNodeData, 'condition'>

export type AppFlowNode =
	| TriggerFlowNode
	| DelayFlowNode
	| ActionEmailFlowNode
	| ActionSmsFlowNode
	| ActionPushFlowNode
	| ConditionFlowNode

export type AppFlowEdge = Edge<{
	label?: string
	isConditionBranch?: boolean
}>

export interface PaletteItem {
	type:
		| 'trigger'
		| 'delay'
		| 'action_email'
		| 'action_sms'
		| 'action_push'
		| 'condition'
	label: string
	description: string
	icon: string
	color: string
	defaultData:
		| TriggerNodeData
		| DelayNodeData
		| ActionEmailNodeData
		| ActionSmsNodeData
		| ActionPushNodeData
		| ConditionNodeData

	isGated?: boolean
}

export interface JourneyRunRecord {
	id: string
	journeyId: string
	customerId: string
	status: JourneyRunStatus
	startedAt: string | Date
	completedAt?: string | Date | null
	currentStepNodeId?: string | null
	errorMessage?: string | null
	createdAt: string | Date
}

export interface JourneyStepExecutionRecord {
	id: string
	runId: string
	nodeId: string
	nodeType: string
	status: string
	attempt: number
	executedAt?: string | Date | null
	errorMessage?: string | null
	createdAt: string | Date
}
