import { msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { FlowEdgeView } from '@repo/flow-editor'
import { useReactFlow, type EdgeProps } from '@xyflow/react'
import { memo } from 'react'
import { type AppFlowEdge } from '../types.ts'

function WorkflowEdgeComponent({
	id,
	sourceHandleId,
	data,
	...props
}: EdgeProps<AppFlowEdge>) {
	const { _ } = useLingui()
	const { setEdges } = useReactFlow()

	const isTrueBranch = sourceHandleId === 'true'
	const isFalseBranch = sourceHandleId === 'false'
	const label =
		data?.label ||
		(isTrueBranch ? _(msg`True`) : isFalseBranch ? _(msg`False`) : null)

	return (
		<FlowEdgeView
			{...props}
			label={label}
			tone={isTrueBranch ? 'positive' : isFalseBranch ? 'negative' : 'default'}
			onDelete={() =>
				setEdges((edges) => edges.filter((edge) => edge.id !== id))
			}
			deleteLabel={_(msg`Delete connection`)}
		/>
	)
}

export const WorkflowEdge = memo(WorkflowEdgeComponent)
