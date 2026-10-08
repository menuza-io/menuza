import { Trans } from '@lingui/macro'
import { FLOW_HANDLE_CLASS } from '@repo/flow-editor'
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
						className={FLOW_HANDLE_CLASS}
					/>
					<Handle
						type="source"
						position={Position.Bottom}
						id="output"
						className={FLOW_HANDLE_CLASS}
					/>
				</>
			}
		/>
	)
}

export const DelayNode = memo(DelayNodeComponent)
