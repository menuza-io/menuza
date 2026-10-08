import { cn } from '@repo/ui'
import { Button } from '@repo/ui/button'
import { Icon, type IconName } from '@repo/ui/icon'
import {
	Item,
	ItemActions,
	ItemContent,
	ItemDescription,
	ItemGroup,
	ItemMedia,
	ItemTitle,
} from '@repo/ui/item'
import { ScrollArea } from '@repo/ui/scroll-area'
import { type DragEvent, type ReactNode } from 'react'

const DRAG_TYPE = 'application/reactflow'
const DRAG_DATA = 'application/reactflow-data'

export interface FlowPaletteItem<TType extends string = string> {
	type: TType
	label: string
	description?: ReactNode
	icon: IconName
	/** Shown next to the label (e.g. a plan badge). */
	badge?: ReactNode
	/** Initial node data, carried through drag-and-drop. */
	data?: Record<string, unknown>
}

export interface FlowPaletteGroup<TType extends string = string> {
	id: string
	title?: ReactNode
	items: FlowPaletteItem<TType>[]
}

export function setFlowDragData(
	event: DragEvent,
	type: string,
	data: Record<string, unknown> = {},
) {
	event.dataTransfer.setData(DRAG_TYPE, type)
	event.dataTransfer.setData(DRAG_DATA, JSON.stringify(data))
	event.dataTransfer.effectAllowed = 'move'
}

/** Reads a palette drop; returns null when the drop didn't come from a palette. */
export function readFlowDragData(event: DragEvent) {
	const type = event.dataTransfer.getData(DRAG_TYPE)
	if (!type) return null
	let data: Record<string, unknown> = {}
	try {
		const raw = event.dataTransfer.getData(DRAG_DATA)
		if (raw) data = JSON.parse(raw) as Record<string, unknown>
	} catch {}
	return { type, data }
}

export function onFlowDragOver(event: DragEvent) {
	event.preventDefault()
	event.dataTransfer.dropEffect = 'move'
}

export interface FlowNodePaletteProps<TType extends string = string> {
	title: ReactNode
	icon?: IconName
	groups: FlowPaletteGroup<TType>[]
	onAdd: (item: FlowPaletteItem<TType>) => void
	/** Accessible name for an item's add button. */
	addLabel: (item: FlowPaletteItem<TType>) => string
	disabled?: boolean
	/** Rendered above the groups (help, notices). */
	header?: ReactNode
	className?: string
}

export function FlowNodePalette<TType extends string = string>({
	title,
	icon = 'blocks',
	groups,
	onAdd,
	addLabel,
	disabled,
	header,
	className,
}: FlowNodePaletteProps<TType>) {
	const count = groups.reduce((total, group) => total + group.items.length, 0)

	return (
		<div className={cn('flex h-full min-h-0 flex-col', className)}>
			<div className="border-border flex items-center gap-2 border-b px-3 py-2.5">
				<span className="bg-muted text-muted-foreground flex size-6 items-center justify-center rounded-md">
					<Icon name={icon} size="xs" />
				</span>
				<span className="min-w-0 truncate text-sm font-medium">{title}</span>
				<span className="text-muted-foreground text-xs tabular-nums">
					{count}
				</span>
			</div>

			<ScrollArea className="min-h-0 flex-1">
				{header ? <div className="space-y-3 p-3">{header}</div> : null}
				{groups.map((group) => (
					<section key={group.id}>
						{group.title ? (
							<h3 className="text-muted-foreground border-b-border border-b px-3 pt-3 pb-1.5 text-xs font-medium">
								{group.title}
							</h3>
						) : null}
						<ItemGroup className="gap-0">
							{group.items.map((item) => (
								<div
									key={item.type}
									role="listitem"
									draggable={!disabled}
									onDragStart={(event) =>
										setFlowDragData(event, item.type, item.data)
									}
									className={cn(
										'border-b-border border-b',
										disabled && 'opacity-60',
									)}
								>
									<Item>
										<ItemMedia>
											<Icon name={item.icon} size="xs" />
										</ItemMedia>
										<ItemContent>
											<ItemTitle>
												<span className="truncate">{item.label}</span>
												{item.badge}
											</ItemTitle>
											{item.description ? (
												<ItemDescription>{item.description}</ItemDescription>
											) : null}
										</ItemContent>

										<ItemActions>
											<Button
												type="button"
												variant="ghost"
												size="sm"
												disabled={disabled}
												aria-label={addLabel(item)}
												title={addLabel(item)}
												className="text-muted-foreground size-7 p-0 opacity-0 transition-opacity group-hover/item:opacity-100 focus-visible:opacity-100"
												onClick={(event) => {
													event.stopPropagation()
													onAdd(item)
												}}
											>
												<Icon name="plus" size="xs" />
											</Button>
										</ItemActions>
									</Item>
								</div>
							))}
						</ItemGroup>
					</section>
				))}
			</ScrollArea>
		</div>
	)
}
