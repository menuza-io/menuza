import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	FLOW_HANDLE_CLASS,
	FlowEdgeView,
	FlowNodeShell,
	type FlowEdgeTone,
	type FlowNodeTone,
} from '@repo/flow-editor'
import {
	FLOW_NODE_TYPES,
	flowOutputs,
	type FlowNodeType,
	type FlowOutput,
} from '@repo/phone-agent'
import { cn } from '@repo/ui'
import { Icon } from '@repo/ui/icon'
import {
	Handle,
	Position,
	type EdgeProps,
	type EdgeTypes,
	type NodeProps,
	type NodeTypes,
} from '@xyflow/react'
import { memo, type ReactNode } from 'react'
import {
	FLOW_STEP_META,
	HANDLE_LABELS,
	type FlowStepCategory,
} from './flow-meta.ts'
import {
	useFlowEditorContext,
	type FlowEditorEdge,
	type FlowEditorNode,
} from './flow-model.ts'

const CATEGORY_TONE: Record<FlowStepCategory, FlowNodeTone> = {
	start: 'primary',
	menu: 'warning',
	ai: 'info',
	action: 'neutral',
	end: 'neutral',
}

function StepHint({ node }: { node: FlowEditorNode }) {
	const { data } = node
	switch (node.type) {
		case 'start':
			return <Trans>When a call connects</Trans>
		case 'hours_check':
			return <Trans>Are you open right now?</Trans>
		case 'ai_agent':
			return data.message ? (
				<>{data.message}</>
			) : (
				<Trans>Helps the caller for the rest of the call</Trans>
			)
		case 'transfer': {
			const phone = data.phone
			return phone ? (
				<Trans>Calls {phone}</Trans>
			) : (
				<Trans>Calls the staff number from Setup</Trans>
			)
		}
		default:
			return data.message ? (
				<>{data.message}</>
			) : (
				<Trans>Nothing to say yet</Trans>
			)
	}
}

/** A labeled output row with its handle on the node's right edge. */
function OutputRow({
	handle,
	chip,
	children,
	muted,
}: {
	handle: string
	chip?: ReactNode
	children: ReactNode
	muted?: boolean
}) {
	return (
		<div className="relative -me-5 flex items-center gap-2 py-1 pe-5 text-xs">
			{chip ? (
				<span className="bg-muted text-foreground inline-flex size-5 shrink-0 items-center justify-center rounded font-mono text-[11px] font-semibold">
					{chip}
				</span>
			) : null}
			<span
				className={cn(
					'min-w-0 flex-1 truncate',
					muted ? 'text-muted-foreground' : 'text-foreground',
				)}
			>
				{children}
			</span>
			<Handle
				type="source"
				id={handle}
				position={Position.Right}
				className={FLOW_HANDLE_CLASS}
			/>
		</div>
	)
}

function OutputRows({ outputs }: { outputs: FlowOutput[] }) {
	const { _ } = useLingui()
	return (
		<div className="border-border mt-3 border-t pt-2">
			{outputs.map((output) =>
				output.handle === null ? null : output.option ? (
					<OutputRow
						key={output.handle}
						handle={output.handle}
						chip={output.option.key}
					>
						{output.option.label || <Trans>Untitled option</Trans>}
					</OutputRow>
				) : (
					<OutputRow
						key={output.handle}
						handle={output.handle}
						muted={!output.required}
					>
						{HANDLE_LABELS[output.handle]
							? _(HANDLE_LABELS[output.handle]!)
							: output.handle}
					</OutputRow>
				),
			)}
		</div>
	)
}

function FlowStepNodeComponent(props: NodeProps<FlowEditorNode>) {
	const { _ } = useLingui()
	const { issuesByNode } = useFlowEditorContext()
	const type = props.type as FlowNodeType
	const meta = FLOW_STEP_META[type]
	const issueCount = issuesByNode.get(props.id)?.length ?? 0
	const node = { id: props.id, type, data: props.data } as FlowEditorNode
	const outputs = flowOutputs({ type, data: props.data })
	const singleOutput = outputs.length === 1 && outputs[0]!.handle === null

	return (
		<FlowNodeShell
			tone={CATEGORY_TONE[meta.category]}
			icon={meta.icon}
			typeLabel={_(meta.title)}
			title={props.data.label}
			description={<StepHint node={node} />}
			selected={props.selected}
			invalid={issueCount > 0}
			badge={
				issueCount > 0 ? (
					<>
						<Icon name="alert-triangle" size="xs" />
						{issueCount}
					</>
				) : null
			}
			overlay={
				<>
					{type === 'start' ? null : (
						<Handle
							type="target"
							position={Position.Left}
							className={FLOW_HANDLE_CLASS}
						/>
					)}
					{singleOutput ? (
						<Handle
							type="source"
							position={Position.Right}
							className={FLOW_HANDLE_CLASS}
						/>
					) : null}
				</>
			}
		>
			{outputs.length && !singleOutput ? (
				<OutputRows outputs={outputs} />
			) : null}
		</FlowNodeShell>
	)
}

export const FlowStepNode = memo(FlowStepNodeComponent)

export const flowNodeTypes: NodeTypes = Object.fromEntries(
	FLOW_NODE_TYPES.map((type) => [type, FlowStepNode]),
)

function FlowEdgeComponent({
	id,
	sourceHandleId,
	...props
}: EdgeProps<FlowEditorEdge>) {
	const { _ } = useLingui()
	const { readOnly, issuesByEdge, deleteEdge } = useFlowEditorContext()
	const tone: FlowEdgeTone =
		sourceHandleId === 'open'
			? 'positive'
			: sourceHandleId === 'closed'
				? 'negative'
				: 'default'

	return (
		<FlowEdgeView
			{...props}
			tone={tone}
			invalid={(issuesByEdge.get(id)?.length ?? 0) > 0}
			onDelete={readOnly ? undefined : () => deleteEdge(id)}
			deleteLabel={_(msg`Delete connection`)}
		/>
	)
}

export const FlowPathEdge = memo(FlowEdgeComponent)

export const flowEdgeTypes: EdgeTypes = { flow: FlowPathEdge }
