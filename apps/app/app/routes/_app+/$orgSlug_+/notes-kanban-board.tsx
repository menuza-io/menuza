import {
	DndContext,
	KeyboardSensor,
	MouseSensor,
	TouchSensor,
	pointerWithin,
	rectIntersection,
	useSensor,
	useSensors,
	useDroppable,
	DragOverlay,
	type DragStartEvent,
	type DragEndEvent,
	type DragOverEvent,
	type Announcements,
} from '@dnd-kit/core'
import {
	SortableContext,
	verticalListSortingStrategy,
	horizontalListSortingStrategy,
	useSortable,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { t, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { useDoubleCheck } from '@repo/common'
import { Button } from '@repo/ui/button'
import { ColorPicker } from '@repo/ui/color-picker'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { StatusButton } from '@repo/ui/status-button'
import React, { useState, useMemo, useId } from 'react'
import { createPortal } from 'react-dom'
import { useFetcher, useFetchers } from 'react-router'

import { NoteCard } from './notes-cards.tsx'

type Note = LoaderNote & {
	position?: number | null
}
type LoaderNote = {
	id: string
	title: string
	content: string
	createdAt: string
	updatedAt: string
	createdById: string
	createdByName: string
	statusId: string | null
	statusName: string | null
	uploads: Array<{
		id: string
		type: string
		altText: string | null
		objectKey: string
	}>
}

type Status = {
	id: string
	name: string
	color?: string
	position: number | null
}
type Column = { id: string; name: string; color?: string }

const UNCATEGORISED = '__uncategorised'
const SEPARATOR = ':::'
const COLUMN_PREFIX = 'column-'
function makeDragId(columnId: string, noteId: string) {
	return `${columnId}${SEPARATOR}${noteId}`
}
function makeColumnDragId(columnId: string) {
	return `${COLUMN_PREFIX}${columnId}`
}
function parseDragId(
	id: unknown,
): { columnId: string; noteId?: string; isColumn?: boolean } | null {
	if (!id || typeof id !== 'string') return null

	// Check if it's a column drag
	if (id.startsWith(COLUMN_PREFIX)) {
		const columnId = id.substring(COLUMN_PREFIX.length)
		return { columnId, isColumn: true }
	}

	// Check if it's a note drag
	if (id.includes(SEPARATOR)) {
		const [columnId, noteId] = id.split(SEPARATOR)
		return { columnId: columnId || '', noteId }
	}
	return { columnId: id }
}

const collisionStrategy = (args: any) => {
	const pointer = pointerWithin(args)
	return pointer.length > 0 ? pointer : rectIntersection(args)
}

/**
 * Helper function to determine the destination column and position for a note drag operation.
 * Reduces code duplication between handleDragOver and handleDragEnd.
 */
function calculateNoteDestination(
	over: { id: unknown },
	activeParsed: ReturnType<typeof parseDragId>,
	grouped: Record<string, Note[]>,
): { columnId: string; position: number } | null {
	const overParsed = parseDragId(over.id)
	const destColId = overParsed?.columnId ?? String(over.id)
	const overNoteId =
		overParsed?.noteId && overParsed.noteId !== '__placeholder'
			? overParsed.noteId
			: null

	if (!destColId || !activeParsed?.noteId) return null

	const list = grouped[destColId] ?? []
	let destIndex = list.length

	if (overNoteId) {
		const overIndex = list.findIndex((n) => n.id === overNoteId)
		if (overIndex >= 0) destIndex = overIndex

		// If moving within same column and after itself, adjust index
		if (
			activeParsed.columnId === destColId &&
			overIndex > list.findIndex((n) => n.id === activeParsed.noteId)
		) {
			destIndex--
		}
	}

	return { columnId: destColId, position: destIndex }
}

const EMPTY_NOTES: Note[] = []

export function NotesKanbanBoard({
	notes,
	statuses,
	orgSlug,
	organizationId,
}: {
	notes: LoaderNote[]
	statuses: Status[]
	orgSlug: string
	organizationId: string
}) {
	// --- Optimistic overlays from Remix fetchers ---
	const fetchers = useFetchers()

	// Pending note moves / creates
	const pendingNotes = fetchers
		.filter((f) => f.formData?.get('intent') === 'reorder-note')
		.map((f) => ({
			id: String(f.formData!.get('noteId')),
			statusId: (f.formData!.get('statusId') as string) ?? null,
			position: Number(f.formData!.get('position')),
		}))

	const pendingNoteCreates = fetchers
		.filter((f) => f.formData?.get('intent') === 'create-note')
		.map(
			(f) =>
				({
					id: String(f.formData!.get('noteId')),
					title: String(f.formData!.get('title')),
					content: '',
					createdAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
					createdById: '',
					createdByName: 'You',
					statusId: (f.formData!.get('statusId') as string) ?? null,
					statusName: null,
					uploads: [],
				}) as LoaderNote,
		)

	// Pending status creates / renames / deletes
	const renameMap = useMemo(() => {
		const map: Record<string, string> = {}
		fetchers
			.filter((f) => f.formData?.get('intent') === 'rename-status')
			.forEach((f) => {
				map[String(f.formData!.get('statusId'))] = String(
					f.formData!.get('name'),
				)
			})
		return map
	}, [fetchers])

	const pendingCreatesStatus = useMemo(
		() =>
			fetchers
				.filter((f) => f.formData?.get('intent') === 'create-status')
				.map((f) => {
					const name = String(f.formData!.get('name'))
					return { id: name, name }
				}),
		[fetchers],
	)

	const pendingDeletes = useMemo(() => {
		const set = new Set<string>()
		for (const f of fetchers) {
			if (
				f.formMethod === 'DELETE' &&
				f.formAction?.includes('/notes/status/')
			) {
				const statusId = f.formAction.split('/').pop()
				if (statusId) set.add(statusId)
			}
		}
		return set
	}, [fetchers])

	// Build columns - memoized to avoid recreation on every render
	const columns = useMemo<Column[]>(() => {
		const cols: Column[] = [
			...statuses
				.filter((s) => !pendingDeletes.has(s.id))
				.map((s) => ({
					id: s.id,
					name: renameMap[s.id] ?? s.name,
					color: s.color,
				})),
			...pendingCreatesStatus,
		]
		if (notes.some((n) => !n.statusId))
			cols.unshift({ id: UNCATEGORISED, name: 'Uncategorised' })
		return cols
	}, [statuses, pendingDeletes, renameMap, pendingCreatesStatus, notes])

	// Build notes and group by statusId - memoized with sorting
	const { noteMap, grouped } = useMemo(() => {
		const map = new Map<string, Note>()
		notes.forEach((n) => map.set(n.id, { ...n }))
		pendingNotes.forEach((p) => {
			const n = map.get(p.id)
			if (n) {
				n.statusId = p.statusId
				n.position = p.position
			}
		})
		pendingNoteCreates.forEach((n) => map.set(n.id, n))

		// Group by statusId
		const grp: Record<string, Note[]> = {}
		columns.forEach((c) => (grp[c.id] = []))
		map.forEach((n) => {
			const bucket =
				grp[n.statusId ?? UNCATEGORISED] ??
				(grp[n.statusId ?? UNCATEGORISED] = [])
			bucket.push(n)
		})

		// Sort each group
		Object.values(grp).forEach((arr) =>
			arr.sort((a, b) => {
				const posA = a.position ?? Number.POSITIVE_INFINITY
				const posB = b.position ?? Number.POSITIVE_INFINITY
				if (posA === posB) {
					return (
						new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
					)
				}
				return posA - posB
			}),
		)

		return { noteMap: map, grouped: grp }
	}, [notes, pendingNotes, pendingNoteCreates, columns])

	// --- DnD-kit setup ---
	const dndId = useId()
	const sensors = useSensors(
		useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
		useSensor(TouchSensor, {
			activationConstraint: { delay: 250, tolerance: 5 },
		}),
		useSensor(KeyboardSensor),
	)
	const reorderFetcher = useFetcher()
	const columnReorderFetcher = useFetcher()
	const [activeNote, setActiveNote] = useState<Note | null>(null)
	const [activeColumn, setActiveColumn] = useState<Column | null>(null)
	const [dragDestination, setDragDestination] = useState<{
		columnId: string
		position?: number
	} | null>(null)

	function handleDragStart(ev: DragStartEvent) {
		const info = parseDragId(ev.active.id)
		if (info?.isColumn) {
			// Column drag
			const column = columns.find((c) => c.id === info.columnId)
			setActiveColumn(column ?? null)
			setActiveNote(null)
		} else if (info?.noteId && info.noteId !== '__placeholder') {
			// Note drag
			setActiveNote(noteMap.get(info.noteId) ?? null)
			setActiveColumn(null)
		} else {
			setActiveNote(null)
			setActiveColumn(null)
		}
		setDragDestination(null)
	}

	function handleDragOver(ev: DragOverEvent) {
		const { active, over } = ev
		if (!over) return

		const activeParsed = parseDragId(active.id)

		// Handle column drag over
		if (activeParsed?.isColumn) {
			// Column dragging - no preview needed for now
			return
		}

		// Handle note drag over (existing logic)
		if (!activeNote) return

		const destination = calculateNoteDestination(over, activeParsed, grouped)
		if (!destination) return

		// Only update if destination changed
		if (
			dragDestination?.columnId !== destination.columnId ||
			dragDestination?.position !== destination.position
		) {
			setDragDestination({
				columnId: destination.columnId,
				position: destination.position,
			})
		}
	}

	function handleDragEnd(ev: DragEndEvent) {
		const { active, over } = ev
		setActiveNote(null)
		setActiveColumn(null)
		setDragDestination(null)
		if (!over) return

		const activeParsed = parseDragId(active.id)

		// Handle column reordering
		if (activeParsed?.isColumn) {
			const overParsed = parseDragId(over.id)
			if (!overParsed?.isColumn) return

			const activeIndex = columns.findIndex(
				(c) => c.id === activeParsed.columnId,
			)
			const overIndex = columns.findIndex((c) => c.id === overParsed.columnId)

			if (activeIndex !== overIndex && activeIndex !== -1 && overIndex !== -1) {
				const formData = new FormData()
				formData.append('statusId', activeParsed.columnId)
				formData.append('position', String(overIndex))
				void columnReorderFetcher.submit(formData, {
					method: 'post',
					action: `/${orgSlug}/notes/statuses/reorder`,
				})
			}
			return
		}

		// Handle note reordering (existing logic)
		const destination = calculateNoteDestination(over, activeParsed, grouped)
		if (!destination) return

		const formData = new FormData()
		formData.append('intent', 'reorder-note')
		if (activeParsed?.noteId) {
			formData.append('noteId', activeParsed.noteId)
		}
		formData.append('position', String(destination.position))
		if (destination.columnId !== UNCATEGORISED)
			formData.append('statusId', destination.columnId)
		void reorderFetcher.submit(formData, {
			method: 'post',
			action: `/${orgSlug}/notes/reorder`,
		})
	}

	// Accessibility announcements for screen readers
	const announcements: Announcements = {
		onDragStart({ active }) {
			const info = parseDragId(active.id)
			if (info?.isColumn) {
				const column = columns.find((c) => c.id === info.columnId)
				return `Picked up column "${column?.name}"`
			} else if (info?.noteId && info.noteId !== '__placeholder') {
				const note = noteMap.get(info.noteId)
				const column = columns.find((c) => c.id === info.columnId)
				return `Picked up note "${note?.title}" from column "${column?.name}"`
			}
			return 'Picked up draggable item'
		},
		onDragOver({ active, over }) {
			if (!over) return
			const activeInfo = parseDragId(active.id)
			const overInfo = parseDragId(over.id)

			if (activeInfo?.isColumn && overInfo?.isColumn) {
				const overColumn = columns.find((c) => c.id === overInfo.columnId)
				return `Moving column over "${overColumn?.name}"`
			}

			const destColumn = columns.find(
				(c) => c.id === (overInfo?.columnId ?? over.id),
			)

			if (activeInfo?.noteId && destColumn) {
				return `Moving note over column "${destColumn.name}"`
			}
			return 'Moving item'
		},
		onDragEnd({ active, over }) {
			if (!over) return 'Item dropped'
			const activeInfo = parseDragId(active.id)
			const overInfo = parseDragId(over.id)

			if (activeInfo?.isColumn && overInfo?.isColumn) {
				const activeColumn = columns.find((c) => c.id === activeInfo.columnId)
				const overColumn = columns.find((c) => c.id === overInfo.columnId)
				return `Column "${activeColumn?.name}" moved next to "${overColumn?.name}"`
			}

			const destColumn = columns.find(
				(c) => c.id === (overInfo?.columnId ?? over.id),
			)

			if (activeInfo?.noteId && destColumn) {
				const note = noteMap.get(activeInfo.noteId)
				return `Note "${note?.title}" dropped in column "${destColumn.name}"`
			}
			return 'Item dropped'
		},
		onDragCancel() {
			return 'Dragging cancelled'
		},
	}

	// --- Render ---
	return (
		<DndContext
			id={dndId}
			sensors={sensors}
			collisionDetection={collisionStrategy}
			onDragStart={handleDragStart}
			onDragOver={handleDragOver}
			onDragEnd={handleDragEnd}
			onDragCancel={() => {
				setActiveNote(null)
				setActiveColumn(null)
				setDragDestination(null)
			}}
			accessibility={{ announcements }}
		>
			<SortableContext
				id={dndId}
				items={columns.map((col) => makeColumnDragId(col.id))}
				strategy={horizontalListSortingStrategy}
			>
				<div className="flex snap-x snap-mandatory gap-2 overflow-x-auto py-2">
					{columns.map((col) => (
						<SortableKanbanColumn
							key={col.id}
							column={col}
							notes={grouped[col.id] ?? EMPTY_NOTES}
							orgSlug={orgSlug}
							activeNote={activeNote}
							isDragDestination={dragDestination?.columnId === col.id}
							dragPosition={
								dragDestination?.columnId === col.id
									? dragDestination.position
									: undefined
							}
							organizationId={organizationId}
							isActive={activeColumn?.id === col.id}
						/>
					))}
					<NewColumnButton orgSlug={orgSlug} />
				</div>
			</SortableContext>
			{typeof window !== 'undefined' &&
				createPortal(
					<DragOverlay>
						{activeNote ? (
							<div className="rotate-3 shadow-lg">
								<NoteCard note={activeNote} organizationId={organizationId} />
							</div>
						) : activeColumn ? (
							<div className="scale-105 rotate-3 shadow-2xl">
								<KanbanColumn
									column={activeColumn}
									notes={grouped[activeColumn.id] ?? EMPTY_NOTES}
									orgSlug={orgSlug}
									activeNote={null}
									isDragDestination={false}
									dragPosition={undefined}
									organizationId={organizationId}
								/>
							</div>
						) : null}
					</DragOverlay>,
					document.body,
				)}
		</DndContext>
	)
}

/* -------------------------------------------------------------------------- */
/*  Sortable Column Wrapper                                                   */
/* -------------------------------------------------------------------------- */

// ⚡ Bolt: Wrapped SortableKanbanColumn in React.memo and extracted primitive drag props
// to prevent O(N) re-renders of all columns during drag-over events.
const SortableKanbanColumn = React.memo(function SortableKanbanColumn({
	column,
	notes,
	orgSlug,
	activeNote,
	isDragDestination,
	dragPosition,
	organizationId,
	isActive,
}: {
	column: Column
	notes: Note[]
	orgSlug: string
	activeNote: Note | null
	isDragDestination: boolean
	dragPosition?: number
	organizationId: string
	isActive: boolean
}) {
	const {
		attributes,
		listeners,
		setNodeRef,
		transform,
		transition,
		isDragging,
	} = useSortable({
		id: makeColumnDragId(column.id),
		data: {
			type: 'Column',
			column,
		},
	})

	const style = {
		transform: CSS.Transform.toString(transform),
		transition,
		opacity: isDragging ? 0.5 : 1,
		zIndex: isDragging ? 1000 : 'auto',
	}

	return (
		<div ref={setNodeRef} style={style}>
			<KanbanColumn
				column={column}
				notes={notes}
				orgSlug={orgSlug}
				activeNote={activeNote}
				isDragDestination={isDragDestination}
				dragPosition={dragPosition}
				organizationId={organizationId}
				dragHandleProps={{ ...attributes, ...listeners }}
				isActive={isActive}
			/>
		</div>
	)
})

/* -------------------------------------------------------------------------- */
/*  Column                                                                    */
/* -------------------------------------------------------------------------- */

// ⚡ Bolt: Wrapped KanbanColumn in React.memo and extracted primitive drag props
// to prevent O(N) re-renders of all columns during drag-over events.
const KanbanColumn = React.memo(function KanbanColumn({
	column,
	notes,
	orgSlug,
	activeNote,
	isDragDestination,
	dragPosition,
	organizationId,
	dragHandleProps,
	isActive,
}: {
	column: Column
	notes: Note[]
	orgSlug: string
	activeNote: Note | null
	isDragDestination: boolean
	dragPosition?: number
	organizationId: string
	dragHandleProps?: React.HTMLAttributes<HTMLDivElement>
	isActive?: boolean
}) {
	const { _ } = useLingui()
	const { setNodeRef } = useDroppable({ id: column.id })
	const deleteFetcher = useFetcher()
	const dc = useDoubleCheck()
	const [editing, setEditing] = useState(false)

	const placeholderId = makeDragId(column.id, '__placeholder')
	const sortableItems = notes.length
		? notes.map((n) => makeDragId(column.id, n.id))
		: [placeholderId]

	// Create display notes with preview
	const displayNotes = [...notes]
	if (
		isDragDestination &&
		activeNote &&
		!notes.find((n) => n.id === activeNote.id)
	) {
		// Insert preview note at the correct position
		const previewNote = { ...activeNote, id: `${activeNote.id}-preview` }
		displayNotes.splice(dragPosition ?? 0, 0, previewNote)
	}

	return (
		<div
			ref={setNodeRef}
			className={`bg-muted/30 flex max-w-[320px] min-w-[320px] shrink-0 snap-center flex-col rounded p-2 shadow-xs ${
				isActive ? 'ring-primary/50 ring-2' : ''
			}`}
		>
			{/* header ------------------------------------------------------- */}
			<div className="group mb-1 flex w-full items-center gap-2">
				{/* Drag handle for column */}
				{dragHandleProps && (
					<div
						{...dragHandleProps}
						className="cursor-grab touch-none opacity-50 hover:opacity-100 active:cursor-grabbing"
						title={_(t`Drag to reorder column`)}
					>
						<Icon name="grip-vertical" size="sm" />
					</div>
				)}
				{editing ? (
					<EditColumnForm
						column={column}
						orgSlug={orgSlug}
						onCancel={() => setEditing(false)}
					/>
				) : (
					<div className="flex w-full items-center justify-between gap-2">
						<button
							className="flex items-center gap-2 hover:underline"
							onClick={() => setEditing(true)}
							aria-label={`Edit ${column.name} column`}
						>
							{column.id !== UNCATEGORISED && column.color && (
								<div
									className="h-3 w-3 shrink-0 rounded-full"
									style={{ backgroundColor: column.color }}
								/>
							)}
							<span className="text-sm">{column.name}</span>
							{column.id !== UNCATEGORISED && (
								<button
									className="invisible p-1 px-2 group-hover:visible"
									aria-label={_(t`Edit column`)}
								>
									<Icon name="pencil" size="xs" />
								</button>
							)}
						</button>
						{column.id !== UNCATEGORISED && (
							<deleteFetcher.Form
								method="delete"
								action={`/${orgSlug}/notes/status/${column.id}`}
								className="invisible group-hover:visible"
							>
								<StatusButton
									{...dc.getButtonProps({ type: 'submit' })}
									variant={dc.doubleCheck ? 'destructive' : 'ghost'}
									size="sm"
									className="h-auto p-1"
									status={deleteFetcher.state !== 'idle' ? 'pending' : 'idle'}
								>
									{dc.doubleCheck && 'Are you sure?'}
									<Icon name={dc.doubleCheck ? 'check' : 'trash-2'} size="xs" />
								</StatusButton>
							</deleteFetcher.Form>
						)}
					</div>
				)}
			</div>

			{/* list --------------------------------------------------------- */}
			<SortableContext
				id={column.id}
				items={sortableItems}
				strategy={verticalListSortingStrategy}
			>
				<div className="flex min-h-screen flex-col gap-3 overflow-y-auto p-1">
					{displayNotes.map((n) => {
						const isPreview = n.id.endsWith('-preview')
						const originalId = isPreview ? n.id.replace('-preview', '') : n.id

						if (isPreview) {
							return (
								<div
									key={`preview-${originalId}`}
									className="scale-95 opacity-30"
								>
									<NoteCard
										note={{ ...n, id: originalId }}
										organizationId={organizationId}
									/>
								</div>
							)
						}

						// Hide the original note if it's being dragged
						if (activeNote?.id === n.id) {
							return (
								<div key={makeDragId(column.id, n.id)} className="opacity-30">
									<SortableNote
										note={n}
										dragId={makeDragId(column.id, n.id)}
										organizationId={organizationId}
									/>
								</div>
							)
						}

						return (
							<SortableNote
								key={makeDragId(column.id, n.id)}
								note={n}
								dragId={makeDragId(column.id, n.id)}
								organizationId={organizationId}
							/>
						)
					})}
					{notes.length === 0 && !isDragDestination && (
						<div className="text-muted-foreground border-muted-foreground/30 flex h-20 min-h-screen items-center justify-center rounded border-2 border-dashed text-sm"></div>
					)}
				</div>
			</SortableContext>
		</div>
	)
})

/* -------------------------------------------------------------------------- */
/*  Note Card wrapper                                                         */
/* -------------------------------------------------------------------------- */

// ⚡ Bolt: Wrapped SortableNote in React.memo to prevent O(N*M) re-renders
// of all notes when its parent column re-renders during drag operations.
const SortableNote = React.memo(function SortableNote({
	note,
	dragId,
	organizationId,
}: {
	note: Note
	dragId: string
	organizationId: string
}) {
	const [editingNoteId, setEditingNoteId] = useState<string | null>(null)
	const {
		attributes,
		listeners,
		setNodeRef,
		transform,
		transition,
		isDragging,
		isOver,
	} = useSortable({
		id: dragId,
		data: {
			type: 'Note',
			note,
		},
	})

	const style = {
		transform: CSS.Transform.toString(transform),
		transition,
		opacity: isDragging ? 0.3 : 1,
		cursor: isDragging ? 'grabbing' : 'grab',
		zIndex: isDragging ? 1000 : 'auto',
	}

	return (
		<div
			ref={setNodeRef}
			style={style}
			className={`${isDragging ? 'scale-105 shadow-2xl' : ''} ${isOver ? 'ring-primary/50 ring-2' : ''}`}
			{...attributes}
			{...listeners}
		>
			<NoteCard
				note={note}
				organizationId={organizationId}
				isEditing={editingNoteId === note.id}
				setEditingNote={setEditingNoteId}
			/>
		</div>
	)
})

/* -------------------------------------------------------------------------- */
/*  “+ column” button – stateless (details element manages open/close)    */
/* -------------------------------------------------------------------------- */

function EditColumnForm({
	column,
	orgSlug,
	onCancel,
}: {
	column: Column
	orgSlug: string
	onCancel: () => void
}) {
	const fetcher = useFetcher()
	const [selectedColor, setSelectedColor] = useState(column.color || '#6b7280')

	// Close editing when fetcher is done
	React.useEffect(() => {
		if (fetcher.state === 'idle' && fetcher.data) {
			onCancel()
		}
	}, [fetcher.state, fetcher.data, onCancel])

	return (
		<fetcher.Form
			className="w-full space-y-2"
			method="patch"
			action={`/${orgSlug}/notes/status/${column.id}`}
		>
			<input type="hidden" name="intent" value="rename-status" />
			<input type="hidden" name="statusId" value={column.id} />
			<input type="hidden" name="color" value={selectedColor} />
			<div className="flex gap-2">
				<Input
					name="name"
					defaultValue={column.name}
					autoFocus
					className="h-8 flex-1 px-2"
					onKeyDown={(e) => e.key === 'Escape' && onCancel()}
					aria-label={t`Column name`}
				/>
				<ColorPicker value={selectedColor} onChange={setSelectedColor} />
			</div>
			<div className="flex gap-2">
				<Button type="submit" variant="default" size="sm" className="flex-1">
					<Trans>Save</Trans>
				</Button>
				<Button type="button" variant="outline" size="sm" onClick={onCancel}>
					<Trans>Cancel</Trans>
				</Button>
			</div>
		</fetcher.Form>
	)
}

function NewColumnButton({ orgSlug }: { orgSlug: string }) {
	const fetcher = useFetcher()
	const [editing, setEditing] = useState(false)
	const [selectedColor, setSelectedColor] = useState('#6b7280')

	// Close editing when fetcher is done
	React.useEffect(() => {
		if (fetcher.state === 'idle' && fetcher.data) {
			setEditing(false)
		}
	}, [fetcher.state, fetcher.data])

	return (
		<div className="flex min-w-[270px] flex-col justify-start">
			{editing ? (
				<fetcher.Form
					method="post"
					action={`/${orgSlug}/notes/statuses`}
					onSubmit={() => (document.activeElement as HTMLElement)?.blur()}
					className="mt-2 space-y-2"
				>
					<input type="hidden" name="intent" value="create-status" />
					<input type="hidden" name="color" value={selectedColor} />
					<div className="flex gap-2">
						<Input
							autoFocus
							name="name"
							placeholder={t`Column name`}
							maxLength={24}
							className="flex-1"
							aria-label={t`Column name`}
						/>
						<ColorPicker value={selectedColor} onChange={setSelectedColor} />
					</div>
					<div className="flex gap-2">
						<Button
							type="submit"
							variant="default"
							size="sm"
							className="flex-1"
						>
							<Trans>Create</Trans>
						</Button>
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={() => setEditing(false)}
						>
							<Trans>Cancel</Trans>
						</Button>
					</div>
				</fetcher.Form>
			) : (
				<Button
					type="button"
					variant="secondary"
					className="mt-2"
					onClick={() => setEditing(true)}
				>
					<Icon name="plus" className="mr-1" /> <Trans>Add column</Trans>
				</Button>
			)}
		</div>
	)
}
