export type NodeType =
	| 'trigger'
	| 'delay'
	| 'action_email'
	| 'action_sms'
	| 'action_push'
	| 'action'
	| 'condition'

export interface DelayNodeData {
	duration?: number
	unit?: 'minutes' | 'hours' | 'days' | 'weeks'
	delayValue?: number
	delayUnit?: 'seconds' | 'minutes' | 'hours' | 'days' | 'weeks'
}

export interface ActionEmailNodeData {
	subject?: string
	bodyHtml?: string
	bodyText?: string
	fromName?: string
	template?: string
	content?: string
	channel?: string
}

export interface ActionSmsNodeData {
	messageText?: string
	content?: string
	channel?: string
}

export interface ConditionNodeData {
	field?: string
	operator?: 'equals' | 'not_equals' | 'contains' | 'greater_than' | 'less_than'
	value?: string | number | boolean
}

export interface WorkflowNode {
	id: string
	type: NodeType | string
	position?: { x: number; y: number }
	data?: Record<string, unknown>
}

export interface WorkflowEdge {
	id: string
	source: string
	target: string
	sourceHandle?: string | null
	targetHandle?: string | null
}

export interface WorkflowGraph {
	nodes: WorkflowNode[]
	edges: WorkflowEdge[]
	viewport?: { x: number; y: number; zoom: number }
}

export interface MarketingJourneyWorkflowParams {
	orgId: string
	tenantId?: string
	journeyId: string
	runId: string
	journeyInstanceId?: string
	customerId: string
	tenantApiUrl?: string
	dataRegion?: 'us' | 'ksa'
	triggerEvent?: string
	graph?: WorkflowGraph
	journeyGraph?: WorkflowGraph
	triggerPayload?: Record<string, unknown>
}

export interface MarketingJourneyWorkflowEnv {
	INTERNAL_COMMAND_TOKEN: string
	TENANT_API_URL?: string
	TENANT_API_URL_KSA?: string
	APP_BASE_URL?: string
}
