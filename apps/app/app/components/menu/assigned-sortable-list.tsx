import {
	DndContext,
	KeyboardSensor,
	PointerSensor,
	useSensor,
	useSensors,
	type DragEndEvent,
} from '@dnd-kit/core'
import {
	arrayMove,
	SortableContext,
	sortableKeyboardCoordinates,
	useSortable,
	verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Trans } from '@lingui/macro'
import { cn } from '@repo/ui'
import { Button } from '@repo/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
import {
	Frame,
	FrameDescription,
	FrameFooter,
	FrameHeader,
	FramePanel,
	FrameTitle,
} from '@repo/ui/frame'
import { Icon } from '@repo/ui/icon'
import { useId, useState } from 'react'

export interface AssignableEntry {
	id: string
	name: string
	description?: string | null
	meta?: string
}

interface AssignedSortableListProps {
	id?: string
	title: React.ReactNode
	description: React.ReactNode
	addLabel: React.ReactNode
	selectionTitle: React.ReactNode
	selectionDescription: React.ReactNode
	emptyMessage: React.ReactNode
	entries: AssignableEntry[]
	selectedIds: string[]
	onChange: (ids: string[]) => void
}

function AssignedRow({
	entry,
	onRemove,
}: {
	entry: AssignableEntry
	onRemove: () => void
}) {
	const {
		attributes,
		listeners,
		setActivatorNodeRef,
		setNodeRef,
		transform,
		transition,
		isDragging,
	} = useSortable({ id: entry.id })

	return (
		<FramePanel
			ref={setNodeRef}
			style={{
				transform: CSS.Transform.toString(transform),
				transition,
			}}
			className={cn(
				'flex min-h-14 items-center gap-3 px-4 py-1.5',
				isDragging && 'z-10',
			)}
		>
			<button
				type="button"
				ref={setActivatorNodeRef}
				{...attributes}
				{...listeners}
				className="text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring shrink-0 cursor-grab rounded p-1 transition-colors focus-visible:ring-2 focus-visible:outline-none active:cursor-grabbing"
				aria-label="Drag to reorder"
			>
				<Icon name="grip-vertical" className="size-4" />
			</button>
			<div className="min-w-0 flex-1">
				<p className="truncate text-sm font-medium">{entry.name}</p>
				{entry.description ? (
					<p className="text-muted-foreground mt-0.5 truncate text-xs">
						{entry.description}
					</p>
				) : null}
			</div>
			{entry.meta ? (
				<span className="text-muted-foreground shrink-0 text-xs font-medium tabular-nums">
					{entry.meta}
				</span>
			) : null}
			<Button
				type="button"
				variant="ghost"
				size="icon-sm"
				onClick={onRemove}
				aria-label="Remove assignment"
			>
				<Icon name="x" className="size-4" />
			</Button>
		</FramePanel>
	)
}

export function AssignedSortableList({
	id: idProp,
	title,
	description,
	addLabel,
	selectionTitle,
	selectionDescription,
	emptyMessage,
	entries,
	selectedIds,
	onChange,
}: AssignedSortableListProps) {
	const generatedId = useId()
	const dndId = idProp ?? generatedId
	const [isPickerOpen, setIsPickerOpen] = useState(false)
	const [isSorting, setIsSorting] = useState(false)
	const entriesById = new Map(entries.map((entry) => [entry.id, entry]))
	const selectedEntries = selectedIds.flatMap((id) => {
		const entry = entriesById.get(id)
		return entry ? [entry] : []
	})
	const availableEntries = entries.filter(
		(entry) => !selectedIds.includes(entry.id),
	)
	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
		useSensor(KeyboardSensor, {
			coordinateGetter: sortableKeyboardCoordinates,
		}),
	)

	const handleDragEnd = ({ active, over }: DragEndEvent) => {
		setIsSorting(false)
		if (!over || active.id === over.id) return
		const oldIndex = selectedIds.indexOf(String(active.id))
		const newIndex = selectedIds.indexOf(String(over.id))
		if (oldIndex >= 0 && newIndex >= 0) {
			onChange(arrayMove(selectedIds, oldIndex, newIndex))
		}
	}

	const handleDragStart = () => {
		setIsSorting(true)
	}

	const handleDragCancel = () => {
		setIsSorting(false)
	}

	const handleAdd = (id: string) => {
		onChange([...selectedIds, id])
		setIsPickerOpen(false)
	}

	return (
		<>
			{/*
				Stacked panels derive their corners from DOM order. A drag changes visual
				order before the DOM updates, so temporarily render independent panels.
			*/}
			<Frame className="w-full" stackedPanels={!isSorting}>
				<FrameHeader>
					<FrameTitle className="text-base">{title}</FrameTitle>
					<FrameDescription>{description}</FrameDescription>
				</FrameHeader>
				{selectedEntries.length === 0 ? (
					<FramePanel className="text-muted-foreground px-5 py-6 text-center text-sm">
						{emptyMessage}
					</FramePanel>
				) : (
					<DndContext
						id={dndId}
						sensors={sensors}
						onDragStart={handleDragStart}
						onDragEnd={handleDragEnd}
						onDragCancel={handleDragCancel}
					>
						<SortableContext
							id={dndId}
							items={selectedEntries.map((entry) => entry.id)}
							strategy={verticalListSortingStrategy}
						>
							{selectedEntries.map((entry) => (
								<AssignedRow
									key={entry.id}
									entry={entry}
									onRemove={() =>
										onChange(selectedIds.filter((id) => id !== entry.id))
									}
								/>
							))}
						</SortableContext>
					</DndContext>
				)}
				<FrameFooter className="items-end pt-3">
					<Button
						type="button"
						size="sm"
						className="w-full"
						variant="outline"
						onClick={() => setIsPickerOpen(true)}
						disabled={availableEntries.length === 0}
					>
						<Icon name="plus" className="size-4" />
						{addLabel}
					</Button>
				</FrameFooter>
			</Frame>

			<Dialog open={isPickerOpen} onOpenChange={setIsPickerOpen}>
				<DialogContent className="sm:max-w-lg">
					<DialogHeader>
						<DialogTitle>{selectionTitle}</DialogTitle>
						<DialogDescription>{selectionDescription}</DialogDescription>
					</DialogHeader>
					<div className="max-h-80 space-y-1 overflow-y-auto py-2">
						{availableEntries.map((entry) => (
							<button
								key={entry.id}
								type="button"
								className="hover:bg-muted focus-visible:ring-ring flex w-full items-center gap-3 rounded-md px-3 py-3 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none"
								onClick={() => handleAdd(entry.id)}
							>
								<Icon name="plus" className="text-muted-foreground size-4" />
								<span className="min-w-0 flex-1">
									<span className="block truncate text-sm font-medium">
										{entry.name}
									</span>
									{entry.description ? (
										<span className="text-muted-foreground block truncate text-xs">
											{entry.description}
										</span>
									) : null}
								</span>
								{entry.meta ? (
									<span className="text-muted-foreground text-xs tabular-nums">
										{entry.meta}
									</span>
								) : null}
							</button>
						))}
						{availableEntries.length === 0 ? (
							<p className="text-muted-foreground px-3 py-6 text-center text-sm">
								<Trans>Everything available is already assigned.</Trans>
							</p>
						) : null}
					</div>
				</DialogContent>
			</Dialog>
		</>
	)
}
