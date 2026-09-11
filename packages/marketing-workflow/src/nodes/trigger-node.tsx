import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { memo } from 'react'
import { type TriggerFlowNode } from '../types.ts'
import { useWorkflowConfig } from '../workflow-config.tsx'
import { WorkflowNodeShell } from './node-shell.tsx'

function TriggerNodeComponent({ data, selected }: NodeProps<TriggerFlowNode>) {
	const { _ } = useLingui()
	const { triggerLabels } = useWorkflowConfig()
	const triggerType = data.triggerType || 'phone_verified'
	const info = triggerLabels[triggerType] || {
		label: triggerType,
		desc: _(msg`Custom trigger event`),
	}

	return (
		<WorkflowNodeShell
			kind="trigger"
			icon="play"
			typeLabel={<Trans>Trigger</Trans>}
			title={info.label}
			description={info.desc}
			selected={selected}
			overlay={
				<Handle
					type="source"
					position={Position.Bottom}
					id="output"
					className="border-background bg-muted-foreground size-3 border-2"
				/>
			}
		/>
	)
}

export const TriggerNode = memo(TriggerNodeComponent)
