import {
	DndContext,
	type DragEndEvent,
	PointerSensor,
	closestCenter,
	useSensor,
	useSensors,
} from '@dnd-kit/core'
import {
	SortableContext,
	arrayMove,
	useSortable,
	verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Icon } from '@repo/ui/icon'
import { useEffect, useState } from 'react'
import { useFetcher } from 'react-router'

export type MenuReorderRow = { id: string; label: string }

function SortableRow({ id, label }: MenuReorderRow) {
	const { attributes, listeners, setNodeRef, transform, transition } =
		useSortable({ id })
	const style = {
		transform: CSS.Transform.toString(transform),
		transition,
	}
	return (
		<li
			ref={setNodeRef}
			style={style}
			className="bg-background flex items-center gap-3 rounded-md border px-3 py-2 text-sm"
		>
			<button
				type="button"
				className="text-muted-foreground cursor-grab touch-none"
				aria-label="Drag to reorder"
				{...attributes}
				{...listeners}
			>
				<Icon name="grip-vertical" className="size-4" />
			</button>
			<span className="flex-1 font-medium">{label}</span>
		</li>
	)
}

export function MenuReorderList({
	rows,
	reorderAction,
	reorderIntent,
	extraFields,
	disabled,
}: {
	rows: MenuReorderRow[]
	reorderAction: string
	reorderIntent: string
	extraFields?: Record<string, string>
	disabled?: boolean
}) {
	const fetcher = useFetcher()
	const [items, setItems] = useState(rows)

	useEffect(() => {
		setItems(rows)
	}, [rows])

	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
	)

	const persistOrder = (ordered: MenuReorderRow[]) => {
		const form = new FormData()
		form.set('intent', reorderIntent)
		form.set('orderedIds', JSON.stringify(ordered.map((r) => r.id)))
		if (extraFields) {
			for (const [key, value] of Object.entries(extraFields)) {
				form.set(key, value)
			}
		}
		void fetcher.submit(form, { method: 'post', action: reorderAction })
	}

	const onDragEnd = (event: DragEndEvent) => {
		const { active, over } = event
		if (!over || active.id === over.id || disabled) return
		const oldIndex = items.findIndex((r) => r.id === active.id)
		const newIndex = items.findIndex((r) => r.id === over.id)
		if (oldIndex < 0 || newIndex < 0) return
		const next = arrayMove(items, oldIndex, newIndex)
		setItems(next)
		persistOrder(next)
	}

	if (!items.length) return null

	return (
		<DndContext
			sensors={sensors}
			collisionDetection={closestCenter}
			onDragEnd={onDragEnd}
		>
			<SortableContext items={items} strategy={verticalListSortingStrategy}>
				<ul className="flex flex-col gap-2">
					{items.map((row) => (
						<SortableRow key={row.id} {...row} />
					))}
				</ul>
			</SortableContext>
		</DndContext>
	)
}
