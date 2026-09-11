import { Trans } from '@lingui/macro'
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
						className="border-background bg-muted-foreground size-3 border-2"
					/>

					<Handle
						type="source"
						position={Position.Bottom}
						id="true"
						className="border-background bg-foreground size-3 border-2"
						style={{ left: '25%' }}
					/>
					<div className="border-border bg-card text-foreground absolute -bottom-6 left-[25%] z-10 -translate-x-1/2 rounded-full border px-2 py-0.5 text-[10px] font-medium shadow-xs">
						<Trans>Yes</Trans>
					</div>

					<Handle
						type="source"
						position={Position.Bottom}
						id="false"
						className="border-background bg-muted-foreground size-3 border-2"
						style={{ left: '75%' }}
					/>
					<div className="border-border bg-card text-muted-foreground absolute -bottom-6 left-[75%] z-10 -translate-x-1/2 rounded-full border px-2 py-0.5 text-[10px] font-medium shadow-xs">
						<Trans>No</Trans>
					</div>
				</>
			}
		/>
	)
}

export const ConditionNode = memo(ConditionNodeComponent)
