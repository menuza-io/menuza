import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Icon } from '@repo/ui/icon'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { memo } from 'react'
import { type ActionEmailFlowNode } from '../types.ts'
import { WorkflowNodeShell } from './node-shell.tsx'

function ActionEmailNodeComponent({
	data,
	selected,
}: NodeProps<ActionEmailFlowNode>) {
	const { _ } = useLingui()
	const blockCount = data.blocks?.length ?? 0

	return (
		<WorkflowNodeShell
			kind="action"
			icon="mail"
			typeLabel={<Trans>Email</Trans>}
			title={data.subject || _(msg`Empty subject`)}
			description={data.bodyText?.trim() || undefined}
			badge={
				blockCount > 0 ? (
					<>
						<Icon name="blocks" size="xs" />
						{blockCount}
					</>
				) : undefined
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

export const ActionEmailNode = memo(ActionEmailNodeComponent)
