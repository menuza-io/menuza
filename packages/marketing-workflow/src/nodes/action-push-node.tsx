import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { FLOW_HANDLE_CLASS } from '@repo/flow-editor'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { memo } from 'react'
import { type ActionPushFlowNode } from '../types.ts'
import { WorkflowNodeShell } from './node-shell.tsx'

function ActionPushNodeComponent({
	data,
	selected,
}: NodeProps<ActionPushFlowNode>) {
	const { _ } = useLingui()

	return (
		<WorkflowNodeShell
			kind="action"
			icon="smartphone"
			typeLabel={<Trans>Push</Trans>}
			title={data.title || _(msg`Empty message`)}
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

export const ActionPushNode = memo(ActionPushNodeComponent)
