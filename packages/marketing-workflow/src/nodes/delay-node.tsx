import { Trans } from '@lingui/macro'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { memo } from 'react'
import { type DelayFlowNode } from '../types.ts'
import { useWorkflowUiLabels } from '../workflow-labels.ts'
import { WorkflowNodeShell } from './node-shell.tsx'

function DelayNodeComponent({ data, selected }: NodeProps<DelayFlowNode>) {
	const { delayUnitLabel } = useWorkflowUiLabels()

	return (
		<WorkflowNodeShell
			kind="delay"
			icon="clock"
			typeLabel={<Trans>Time delay</Trans>}
			title={
				<Trans>
					Wait {data.duration} {delayUnitLabel(data.unit)}
				</Trans>
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
						id="output"
						className="border-background bg-muted-foreground size-3 border-2"
					/>
				</>
			}
		/>
	)
}

export const DelayNode = memo(DelayNodeComponent)
