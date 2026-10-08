import { cn } from '@repo/ui'
import { Icon } from '@repo/ui/icon'
import {
	BaseEdge,
	EdgeLabelRenderer,
	getSmoothStepPath,
	Position,
	type EdgeProps,
} from '@xyflow/react'
import { type ReactNode } from 'react'
import { FLOW_NO_DRAG_CLASS } from './node-shell.tsx'

export type FlowEdgeTone = 'default' | 'positive' | 'negative'

// React Flow's stylesheet is not in a cascade layer, so stroke utilities need
// `!` to win over `.react-flow__edge-path`.
const TONE_STROKE_CLASS: Record<FlowEdgeTone, string> = {
	default: 'stroke-muted-foreground/60!',
	positive: 'stroke-primary/70!',
	negative: 'stroke-destructive/70!',
}

// The theme has no success token, so the "yes" branch uses the brand primary.
// Labels keep an opaque card fill so the edge line never shows through.
const TONE_LABEL_CLASS: Record<FlowEdgeTone, string> = {
	default: 'bg-card text-muted-foreground border-border',
	positive: 'border-primary/40 bg-card text-primary',
	negative: 'border-destructive/40 bg-card text-destructive',
}

type EdgeGeometry = Pick<
	EdgeProps,
	| 'sourceX'
	| 'sourceY'
	| 'targetX'
	| 'targetY'
	| 'sourcePosition'
	| 'targetPosition'
	| 'markerEnd'
	| 'selected'
>

export interface FlowEdgeViewProps extends EdgeGeometry {
	label?: ReactNode
	tone?: FlowEdgeTone
	/** Marks the path as having validation problems. */
	invalid?: boolean
	/** Makes the label a button (e.g. to select the edge for an inspector). */
	onLabelClick?: () => void
	/** Shows a delete button next to the label on hover or selection. */
	onDelete?: () => void
	deleteLabel?: string
}

export function FlowEdgeView({
	sourceX,
	sourceY,
	targetX,
	targetY,
	sourcePosition = Position.Bottom,
	targetPosition = Position.Top,
	markerEnd,
	selected,
	label,
	tone = 'default',
	invalid,
	onLabelClick,
	onDelete,
	deleteLabel = 'Delete connection',
}: FlowEdgeViewProps) {
	const [edgePath, midX, midY] = getSmoothStepPath({
		sourceX,
		sourceY,
		sourcePosition,
		targetX,
		targetY,
		targetPosition,
		borderRadius: 16,
	})
	// A path that loops back up shares its midpoint with the forward path
	// between the same two nodes, so its label sits just below its source.
	const loopsBack = targetY < sourceY
	const labelX = loopsBack ? sourceX : midX
	const labelY = loopsBack ? sourceY + 28 : midY

	const labelClassName = cn(
		'max-w-40 truncate rounded-full border px-2 py-0.5 text-[10px] font-medium shadow-xs transition-all',
		invalid
			? 'border-destructive bg-card text-destructive'
			: TONE_LABEL_CLASS[tone],
		selected &&
			!invalid &&
			tone === 'default' &&
			'border-primary text-foreground',
	)

	return (
		<>
			<BaseEdge
				path={edgePath}
				markerEnd={markerEnd}
				className={cn(
					TONE_STROKE_CLASS[tone],
					selected && tone === 'default' && 'stroke-primary!',
					invalid && 'stroke-destructive!',
				)}
				style={{ strokeWidth: selected ? 2.5 : 2 }}
			/>

			{label || onDelete ? (
				<EdgeLabelRenderer>
					<div
						style={{
							transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
							pointerEvents: 'all',
						}}
						// React Flow's pan/drag listeners are native (d3), so React's
						// stopPropagation fires too late; these classes are its opt-out.
						className={cn(
							FLOW_NO_DRAG_CLASS,
							'group absolute flex items-center gap-1',
						)}
					>
						{label ? (
							onLabelClick ? (
								<button
									type="button"
									onClick={(event) => {
										event.stopPropagation()
										onLabelClick()
									}}
									className={labelClassName}
								>
									{label}
								</button>
							) : (
								<span className={labelClassName}>{label}</span>
							)
						) : null}

						{onDelete ? (
							<button
								type="button"
								className={cn(
									'bg-background border-border/80 text-muted-foreground hover:text-destructive hover:border-destructive size-5 rounded-full border shadow-xs',
									'flex items-center justify-center opacity-0 transition-all group-hover:opacity-100 focus-visible:opacity-100',
									selected && 'opacity-100',
								)}
								onClick={(event) => {
									event.stopPropagation()
									onDelete()
								}}
								title={deleteLabel}
								aria-label={deleteLabel}
							>
								<Icon name="x" size="xs" />
							</button>
						) : null}
					</div>
				</EdgeLabelRenderer>
			) : null}
		</>
	)
}
