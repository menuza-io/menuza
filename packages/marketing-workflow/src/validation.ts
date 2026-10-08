import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/macro'
import {
	validateWorkflowDAG as validateTenantWorkflowDAG,
	type DAGValidationResult,
	type WorkflowGraph,
} from '@repo/tenant-db/types/journey'
import { type Node, type Edge } from '@xyflow/react'
import { reactFlowToWorkflowGraph } from './serialization.ts'

export type ValidationTranslateFn = (descriptor: MessageDescriptor) => string

export const VALIDATION_MSGS = {
	emptyWorkflow: msg`Workflow must contain at least one Trigger node.`,
	formatFailed: msg`Failed to format graph for validation`,
	triggerTypeRequired: msg`Trigger event type is required.`,
	delayDurationMin: msg`Delay duration must be at least 1.`,
	delayUnitRequired: msg`Delay unit is required.`,
	emailSubjectRequired: msg`Email subject line is required.`,
	emailBodyRequired: msg`Email body content is required.`,
	emailBoilerplate: msg`Unedited boilerplate text detected in email body.`,
	smsMessageRequired: msg`SMS message text is required.`,
	smsMessageTooLong: msg`SMS message exceeds 1600 characters maximum.`,
	conditionFieldRequired: msg`Condition comparison field is required.`,
	conditionOperatorRequired: msg`Condition operator is required.`,
} as const

function t(
	descriptor: MessageDescriptor,
	translate?: ValidationTranslateFn,
): string {
	return translate ? translate(descriptor) : (descriptor.message ?? '')
}

export interface RealtimeValidationState extends DAGValidationResult {
	nodeErrors: Record<string, string[]>
}

/**
 * Validates the current React Flow canvas state against the DAG rules and schema.
 */
export function validateFlowCanvas(
	nodes: Node[],
	edges: Edge[],
	translate?: ValidationTranslateFn,
): RealtimeValidationState {
	const nodeErrors: Record<string, string[]> = {}

	if (!nodes || nodes.length === 0) {
		return {
			valid: false,
			errors: [t(VALIDATION_MSGS.emptyWorkflow, translate)],
			warnings: [],
			nodeCount: 0,
			edgeCount: 0,
			terminalNodeIds: [],
			hasCycles: false,
			nodeErrors,
		}
	}

	// 1. Convert to canonical format for schema & DAG validation
	let graph: WorkflowGraph
	try {
		graph = reactFlowToWorkflowGraph(nodes, edges)
	} catch (err) {
		return {
			valid: false,
			errors: [
				err instanceof Error
					? err.message
					: t(VALIDATION_MSGS.formatFailed, translate),
			],
			warnings: [],
			nodeCount: nodes.length,
			edgeCount: edges.length,
			terminalNodeIds: [],
			hasCycles: false,
			nodeErrors,
		}
	}

	// 2. Perform deep DAG validation using @repo/tenant-db
	const dagResult = validateTenantWorkflowDAG(graph)

	// 3. Map errors to specific nodes for inline UI display
	for (const node of nodes) {
		const errs: string[] = []
		const data = (node.data || {}) as Record<string, any>

		switch (node.type) {
			case 'trigger':
				if (!data.triggerType) {
					errs.push(t(VALIDATION_MSGS.triggerTypeRequired, translate))
				}
				break
			case 'delay':
				if (typeof data.duration !== 'number' || data.duration < 1) {
					errs.push(t(VALIDATION_MSGS.delayDurationMin, translate))
				}
				if (!data.unit) {
					errs.push(t(VALIDATION_MSGS.delayUnitRequired, translate))
				}
				break
			case 'action_email':
				if (
					!data.subject ||
					typeof data.subject !== 'string' ||
					data.subject.trim() === ''
				) {
					errs.push(t(VALIDATION_MSGS.emailSubjectRequired, translate))
				}
				if (!data.bodyHtml && !data.bodyText) {
					errs.push(t(VALIDATION_MSGS.emailBodyRequired, translate))
				} else {
					const combined = (
						(data.bodyHtml || '') +
						' ' +
						(data.bodyText || '')
					).toLowerCase()
					if (
						combined.includes('lorem ipsum') ||
						combined.includes('insert text here') ||
						combined.includes('default template text')
					) {
						errs.push(t(VALIDATION_MSGS.emailBoilerplate, translate))
					}
				}
				break
			case 'action_sms':
				if (
					!data.messageText ||
					typeof data.messageText !== 'string' ||
					data.messageText.trim() === ''
				) {
					errs.push(t(VALIDATION_MSGS.smsMessageRequired, translate))
				} else if (data.messageText.length > 1600) {
					errs.push(t(VALIDATION_MSGS.smsMessageTooLong, translate))
				}
				break
			case 'condition':
				if (
					!data.field ||
					typeof data.field !== 'string' ||
					data.field.trim() === ''
				) {
					errs.push(t(VALIDATION_MSGS.conditionFieldRequired, translate))
				}
				if (!data.operator) {
					errs.push(t(VALIDATION_MSGS.conditionOperatorRequired, translate))
				}
				break
		}

		if (errs.length > 0) {
			nodeErrors[node.id] = errs
		}
	}

	return {
		...dagResult,
		nodeErrors,
	}
}
