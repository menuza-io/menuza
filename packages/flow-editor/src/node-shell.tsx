import { cn } from '@repo/ui'
import { Frame, FramePanel, FrameTitle } from '@repo/ui/frame'
import { Icon, type IconName } from '@repo/ui/icon'
import { type ReactNode } from 'react'

export type FlowNodeTone = 'primary' | 'neutral' | 'warning' | 'info'

// Tones are selected through `data-tone` so the classes stay static strings
// that the design-system lint can check.
const TONE_FRAME_CLASS =
	'data-[tone=primary]:bg-primary/5 dark:data-[tone=primary]:bg-primary/10 data-[tone=warning]:bg-amber-500/5 dark:data-[tone=warning]:bg-amber-500/10 data-[tone=info]:bg-blue-500/5 dark:data-[tone=info]:bg-blue-500/10'

const TONE_TITLE_CLASS =
	'text-muted-foreground data-[tone=primary]:text-primary data-[tone=warning]:text-amber-600 dark:data-[tone=warning]:text-amber-400 data-[tone=info]:text-blue-600 dark:data-[tone=info]:text-blue-400'

/**
 * React Flow's opt-out classes for interactive elements inside nodes and
 * edges (buttons, inputs, labels), so clicking them never drags or pans.
 */
export const FLOW_NO_DRAG_CLASS = 'nodrag nopan'

/** Shared handle look; React Flow's own handle styles are overridden by size. */
export const FLOW_HANDLE_CLASS =
	'border-background bg-muted-foreground size-3 border-2'

/** Pill under a source handle that names the branch (Yes / No / Fallback). */
export function FlowHandleLabel({
	className,
	children,
}: {
	className?: string
	children: ReactNode
}) {
	return (
		<div
			className={cn(
				'border-border bg-card text-muted-foreground pointer-events-none absolute -bottom-6 z-10 -translate-x-1/2 rounded-full border px-2 py-0.5 text-[10px] font-medium whitespace-nowrap shadow-xs',
				className,
			)}
		>
			{children}
		</div>
	)
}

export interface FlowNodeShellProps {
	tone: FlowNodeTone
	icon: IconName
	typeLabel: ReactNode
	title: ReactNode
	description?: ReactNode
	badge?: ReactNode
	/** Extra content under the description, such as per-option rows. */
	children?: ReactNode
	/** Handles and handle labels, positioned against the node frame. */
	overlay?: ReactNode
	selected?: boolean
	/** Marks the node as having validation problems. */
	invalid?: boolean
	className?: string
}

export function FlowNodeShell({
	tone,
	icon,
	typeLabel,
	title,
	description,
	badge,
	children,
	overlay,
	selected,
	invalid,
	className,
}: FlowNodeShellProps) {
	// Frame and tone backgrounds are translucent; the opaque base keeps edges
	// that pass behind a node from showing through it.
	return (
		<div
			className={cn(
				'bg-background w-[280px] rounded-md',
				invalid && 'ring-destructive ring-1',
				selected && 'ring-ring ring-2',
				className,
			)}
		>
			<Frame data-tone={tone} className={TONE_FRAME_CLASS}>
				<div className="flex min-w-0 items-center gap-2 px-4 py-3">
					<FrameTitle
						data-tone={tone}
						className={cn(
							'flex min-w-0 flex-1 items-center gap-1.5',
							TONE_TITLE_CLASS,
						)}
					>
						<Icon name={icon} size="xs" className="shrink-0" />
						<h4 className="truncate text-xs">{typeLabel}</h4>
					</FrameTitle>
					{badge ? (
						<div className="shrink-0">
							<span
								className={cn(
									'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium',
									invalid
										? 'bg-destructive/10 text-destructive'
										: 'bg-muted text-muted-foreground',
								)}
							>
								{badge}
							</span>
						</div>
					) : null}
				</div>

				<FramePanel className="space-y-1 p-4">
					<h3 className="text-foreground truncate text-sm font-medium">
						{title}
					</h3>
					{description ? (
						<p className="text-muted-foreground line-clamp-2 text-xs text-pretty">
							{description}
						</p>
					) : null}
					{children}
				</FramePanel>

				{overlay}
			</Frame>
		</div>
	)
}
