import { cn } from '@repo/ui'
import {
	Frame,
	FrameAction,
	FrameHeader,
	FramePanel,
	FrameTitle,
} from '@repo/ui/frame'
import { Icon, type IconName } from '@repo/ui/icon'
import { type ReactNode } from 'react'

export type WorkflowNodeKind = 'trigger' | 'delay' | 'condition' | 'action'

const KIND_FRAME_CLASS: Record<WorkflowNodeKind, string> = {
	trigger: 'border-primary/20 bg-primary/5 dark:bg-primary/10',
	delay: '',
	condition: 'border-amber-500/20 bg-amber-500/5 dark:bg-amber-500/10',
	action: 'border-sky-500/20 bg-sky-500/5 dark:bg-sky-500/10',
}

const KIND_TITLE_CLASS: Record<WorkflowNodeKind, string> = {
	trigger: 'text-primary',
	delay: 'text-muted-foreground',
	condition: 'text-amber-600 dark:text-amber-400',
	action: 'text-sky-600 dark:text-sky-400',
}

interface WorkflowNodeShellProps {
	kind: WorkflowNodeKind
	icon: IconName
	typeLabel: ReactNode
	title: ReactNode
	description?: ReactNode
	badge?: ReactNode
	overlay?: ReactNode
	selected?: boolean
	className?: string
}

export function WorkflowNodeShell({
	kind,
	icon,
	typeLabel,
	title,
	description,
	badge,
	overlay,
	selected,
	className,
}: WorkflowNodeShellProps) {
	return (
		<Frame
			className={cn(
				'w-[280px]',
				KIND_FRAME_CLASS[kind],
				selected && 'ring-ring ring-2',
				className,
			)}
		>
			<FrameHeader className="gap-0.5 px-4 py-3">
				<FrameTitle
					className={cn(
						'flex min-w-0 items-center gap-1.5',
						KIND_TITLE_CLASS[kind],
					)}
				>
					<Icon name={icon} size="xs" className="shrink-0" />
					<h4 className="truncate text-xs font-semibold">{typeLabel}</h4>
				</FrameTitle>
				{badge ? (
					<FrameAction>
						<span className="bg-muted text-muted-foreground inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium">
							{badge}
						</span>
					</FrameAction>
				) : null}
			</FrameHeader>

			<FramePanel className="space-y-1 p-4">
				<h3 className="text-foreground truncate text-sm font-medium">
					{title}
				</h3>
				{description ? (
					<p className="text-muted-foreground line-clamp-2 text-xs text-pretty">
						{description}
					</p>
				) : null}
			</FramePanel>

			{overlay}
		</Frame>
	)
}
