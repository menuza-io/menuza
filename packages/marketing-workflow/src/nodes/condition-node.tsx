import { Trans } from '@lingui/macro'
import { FLOW_HANDLE_CLASS, FlowHandleLabel } from '@repo/flow-editor'
import { cn } from '@repo/ui'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { memo } from 'react'
import { type ConditionFlowNode } from '../types.ts'
import { useWorkflowUiLabels } from '../workflow-labels.ts'
import { WorkflowNodeShell } from './node-shell.tsx'

function ConditionNodeComponent({
	data,
	selected,
}: NodeProps<ConditionFlowNode>) {
	const { conditionFieldLabel } = useWorkflowUiLabels()

	return (
		<WorkflowNodeShell
			kind="condition"
			icon="route"
			typeLabel={<Trans>Conditional split</Trans>}
			title={
				data.field === 'phoneVerified' ? (
					<Trans>
						Customer <span className="text-foreground font-medium">Phone</span>{' '}
						is {data.value === 'true' ? '' : 'not '}
						<span className="text-foreground font-medium">Verified</span>
					</Trans>
				) : (
					<Trans>
						<span className="text-foreground font-medium">
							{conditionFieldLabel(data.field || 'email')}
						</span>{' '}
						{data.operator === 'equals'
							? 'is'
							: data.operator === 'not_equals'
								? 'is not'
								: 'contains'}{' '}
						<span className="text-foreground font-medium">"{data.value}"</span>
					</Trans>
				)
			}
			selected={selected}
			overlay={
				<>
					<Handle
						type="target"
						position={Position.Top}
						id="input"
						className={FLOW_HANDLE_CLASS}
					/>

					<Handle
						type="source"
						position={Position.Bottom}
						id="true"
						className={cn(FLOW_HANDLE_CLASS, 'bg-foreground')}
						style={{ left: '25%' }}
					/>
					<FlowHandleLabel className="text-foreground left-[25%]">
						<Trans>Yes</Trans>
					</FlowHandleLabel>

					<Handle
						type="source"
						position={Position.Bottom}
						id="false"
						className={FLOW_HANDLE_CLASS}
						style={{ left: '75%' }}
					/>
					<FlowHandleLabel className="left-[75%]">
						<Trans>No</Trans>
					</FlowHandleLabel>
				</>
			}
		/>
	)
}

export const ConditionNode = memo(ConditionNodeComponent)
