import { type MessageDescriptor } from '@lingui/core'
import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { cn } from '@repo/ui'
import { Alert, AlertDescription, AlertTitle } from '@repo/ui/alert'
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from '@repo/ui/alert-dialog'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from '@repo/ui/collapsible'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@repo/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@repo/ui/tooltip'
import {
	type KeyboardEvent as ReactKeyboardEvent,
	type PointerEvent as ReactPointerEvent,
	useEffect,
	useMemo,
	useRef,
	useState,
} from 'react'
import { SelectField, TextField } from '#app/components/staff/controls.tsx'
import { SwitchField } from '#app/components/staff/switch-field.tsx'
import {
	clampCanvasCoord,
	clampCanvasDimension,
	type DiningAreaDto,
	FLOOR_CANVAS_MAX,
	FLOOR_GRID_STEP,
	type FloorElementDto,
	type FloorElementKind,
	normalizeRotation,
	type ReflowedMoveDto,
	type SetupConflictDto,
	snapToGrid,
	type TableDto,
	type TableShape,
} from '#app/utils/reservations/setup-api.ts'
import { useReservationLocales } from '#app/utils/reservations/use-reservation-locales.ts'
import {
	NumberField,
	RotationPresets,
} from './floor-plan-editor/editor-fields.tsx'

export type FloorPlanSaveDraft = {
	expectedFloorPlanVersion: number
	areas: DiningAreaDto[]
	tables: TableDto[]
	elements: FloorElementDto[]
	archiveMissingTables: boolean
}

export type FloorPlanCanvasProps = {
	locationName: string
	floorPlanVersion: number
	areas: DiningAreaDto[]
	tables: TableDto[]
	elements: FloorElementDto[]
	canWrite: boolean
	saving: boolean
	conflictMessage: string | null
	lastConflicts?: SetupConflictDto[]
	lastReflowedMoves?: ReflowedMoveDto[]
	/** Resolves true only when the save succeeded; false keeps the local draft dirty. */
	onSave: (draft: FloorPlanSaveDraft) => Promise<boolean>
	onReloadLatest: () => void
	onLeave: () => void
	/** Optional: lets the route guard navigation while the draft is dirty. */
	onDirtyChange?: (dirty: boolean) => void
}

type SelectedItem =
	{ kind: 'table'; id: string } | { kind: 'element'; id: string } | null

type DragSession = {
	itemKind: 'table' | 'element'
	itemId: string
	mode: 'move' | 'resize'
	startClientX: number
	startClientY: number
	initialX: number
	initialY: number
	initialWidth: number
	initialHeight: number
}

const TABLE_SHAPES: ReadonlyArray<{
	value: TableShape
	label: MessageDescriptor
}> = [
	{ value: 'round', label: msg`Round` },
	{ value: 'square', label: msg`Square` },
	{ value: 'rect', label: msg`Rectangle` },
	{ value: 'booth', label: msg`Booth` },
	{ value: 'bar', label: msg`Bar seat` },
	{ value: 'high_top', label: msg`High-top` },
]

const ELEMENT_KINDS: ReadonlyArray<{
	value: FloorElementKind
	label: MessageDescriptor
	defaultWidth: number
	defaultHeight: number
}> = [
	{ value: 'wall', label: msg`Wall`, defaultWidth: 160, defaultHeight: 20 },
	{
		value: 'bar',
		label: msg`Bar counter`,
		defaultWidth: 160,
		defaultHeight: 60,
	},
	{ value: 'door', label: msg`Door`, defaultWidth: 60, defaultHeight: 20 },
	{ value: 'window', label: msg`Window`, defaultWidth: 120, defaultHeight: 20 },
	{ value: 'label', label: msg`Label`, defaultWidth: 120, defaultHeight: 40 },
	{ value: 'plant', label: msg`Plant`, defaultWidth: 40, defaultHeight: 40 },
	{ value: 'zone', label: msg`Zone`, defaultWidth: 200, defaultHeight: 160 },
]

const ROTATION_PRESETS = [0, 90, 180, 270] as const

function makeClientId(prefix: string): string {
	return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
}

export function FloorPlanCanvas({
	locationName,
	floorPlanVersion,
	areas,
	tables,
	elements,
	canWrite,
	saving,
	conflictMessage,
	lastConflicts = [],
	lastReflowedMoves = [],
	onSave,
	onReloadLatest,
	onLeave,
	onDirtyChange,
}: FloorPlanCanvasProps) {
	const { _ } = useLingui()
	const siteLocales = useReservationLocales()
	const tableShapeOptions = TABLE_SHAPES.map((shape) => ({
		value: shape.value,
		label: _(shape.label),
	}))
	const elementKindOptions = ELEMENT_KINDS.map((kind) => ({
		value: kind.value,
		label: _(kind.label),
	}))

	const activeAreas = useMemo(
		() =>
			areas
				.filter((area) => area.isActive !== false && !area.archivedAt)
				.slice()
				.sort((a, b) => a.sortOrder - b.sortOrder),
		[areas],
	)

	const [draftAreas, setDraftAreas] = useState<DiningAreaDto[]>(
		() => activeAreas,
	)
	const [draftTables, setDraftTables] = useState<TableDto[]>(() =>
		tables.filter((table) => table.isActive !== false && !table.archivedAt),
	)
	const [draftElements, setDraftElements] = useState<FloorElementDto[]>(
		() => elements,
	)
	const [selectedAreaId, setSelectedAreaId] = useState<string>(
		() => activeAreas[0]?.id ?? '',
	)
	const [selected, setSelected] = useState<SelectedItem>(null)
	const [dirty, setDirty] = useState(false)
	const [zoom, setZoom] = useState(1)
	const [showGrid, setShowGrid] = useState(true)
	const [liveAnnouncement, setLiveAnnouncement] = useState('')
	const [newElementKind, setNewElementKind] = useState<FloorElementKind>('wall')
	const [confirmLeaveOpen, setConfirmLeaveOpen] = useState(false)

	const dragRef = useRef<DragSession | null>(null)

	useEffect(() => {
		onDirtyChange?.(dirty)
	}, [dirty, onDirtyChange])

	// Sync baseline when server floorPlanVersion advances and user has not made dirty edits
	useEffect(() => {
		if (!dirty) {
			const nextAreas = areas
				.filter((area) => area.isActive !== false && !area.archivedAt)
				.slice()
				.sort((a, b) => a.sortOrder - b.sortOrder)
			setDraftAreas(nextAreas)
			setDraftTables(
				tables.filter((table) => table.isActive !== false && !table.archivedAt),
			)
			setDraftElements(elements)
			if (
				nextAreas.length > 0 &&
				!nextAreas.some((area) => area.id === selectedAreaId)
			) {
				setSelectedAreaId(nextAreas[0]!.id)
			}
		}
	}, [areas, tables, elements, floorPlanVersion, dirty, selectedAreaId])

	const currentAreaId = selectedAreaId || draftAreas[0]?.id || ''

	const visibleTables = useMemo(
		() =>
			draftTables.filter(
				(table) =>
					table.isActive !== false &&
					!table.archivedAt &&
					(!currentAreaId || table.areaId === currentAreaId),
			),
		[draftTables, currentAreaId],
	)

	const visibleElements = useMemo(
		() =>
			draftElements.filter(
				(el) => !currentAreaId || !el.areaId || el.areaId === currentAreaId,
			),
		[draftElements, currentAreaId],
	)

	const selectedTable = useMemo(
		() =>
			selected?.kind === 'table'
				? (draftTables.find((t) => t.id === selected.id) ?? null)
				: null,
		[selected, draftTables],
	)

	const selectedElement = useMemo(
		() =>
			selected?.kind === 'element'
				? (draftElements.find((el) => el.id === selected.id) ?? null)
				: null,
		[selected, draftElements],
	)

	const updateDraftTable = (
		tableId: string,
		patch: Partial<TableDto>,
		announceText?: string,
	) => {
		if (!canWrite) return
		setDraftTables((prev) =>
			prev.map((table) =>
				table.id === tableId ? { ...table, ...patch } : table,
			),
		)
		setDirty(true)
		if (announceText) {
			setLiveAnnouncement(announceText)
		}
	}

	const updateDraftElement = (
		elementId: string,
		patch: Partial<FloorElementDto>,
		announceText?: string,
	) => {
		if (!canWrite) return
		setDraftElements((prev) =>
			prev.map((el) => (el.id === elementId ? { ...el, ...patch } : el)),
		)
		setDirty(true)
		if (announceText) {
			setLiveAnnouncement(announceText)
		}
	}

	const handleAddTable = () => {
		if (!canWrite) return
		let targetAreaId = currentAreaId
		if (!targetAreaId) {
			const fallbackArea: DiningAreaDto = {
				id: makeClientId('area'),
				locationId: '',
				name: 'Main Dining',
				nameI18n: { [siteLocales.defaultLocale]: 'Main Dining' },
				floorLabel: null,
				sortOrder: 0,
				isOutdoor: false,
				isBookableOnline: true,
				onlinePriority: 0,
				isActive: true,
				archivedAt: null,
				version: 1,
			}
			setDraftAreas([fallbackArea])
			setSelectedAreaId(fallbackArea.id)
			targetAreaId = fallbackArea.id
		}

		const existingLabels = new Set(
			draftTables.map((t) => t.label.trim().toUpperCase()),
		)
		let idx = draftTables.length + 1
		let candidate = `T${idx}`
		while (existingLabels.has(candidate.toUpperCase())) {
			idx += 1
			candidate = `T${idx}`
		}

		const offset = (visibleTables.length % 8) * 40
		const newTable: TableDto = {
			id: makeClientId('tbl'),
			locationId: '',
			areaId: targetAreaId,
			label: candidate,
			minCovers: 2,
			maxCovers: 4,
			shape: 'square',
			x: snapToGrid(80 + offset),
			y: snapToGrid(80 + offset),
			width: 70,
			height: 70,
			rotation: 0,
			combinable: true,
			isBookableOnline: true,
			isAccessible: false,
			isHighTop: false,
			isPatio: false,
			resetBufferMin: 15,
			priority: visibleTables.length,
			notes: null,
			isActive: true,
			archivedAt: null,
			version: 1,
		}

		setDraftTables((prev) => [...prev, newTable])
		setSelected({ kind: 'table', id: newTable.id })
		setDirty(true)
		const addedLabel = newTable.label
		const addedX = newTable.x
		const addedY = newTable.y
		setLiveAnnouncement(
			_(msg`Added table ${addedLabel} at (${addedX}, ${addedY})`),
		)
	}

	const handleAddElement = () => {
		if (!canWrite) return
		const preset =
			ELEMENT_KINDS.find((k) => k.value === newElementKind) ?? ELEMENT_KINDS[0]!
		const offset = (visibleElements.length % 6) * 30
		const created: FloorElementDto = {
			id: makeClientId('el'),
			areaId: currentAreaId || null,
			kind: preset.value,
			label: _(preset.label),
			x: snapToGrid(120 + offset),
			y: snapToGrid(60 + offset),
			width: preset.defaultWidth,
			height: preset.defaultHeight,
			rotation: 0,
			style: {},
		}
		setDraftElements((prev) => [...prev, created])
		setSelected({ kind: 'element', id: created.id })
		setDirty(true)
		const presetLabel = _(preset.label)
		const createdX = created.x
		const createdY = created.y
		setLiveAnnouncement(
			_(msg`Added ${presetLabel} element at (${createdX}, ${createdY})`),
		)
	}

	const handleArchiveSelectedTable = () => {
		if (!canWrite || !selectedTable) return
		const removedLabel = selectedTable.label
		setDraftTables((prev) => prev.filter((t) => t.id !== selectedTable.id))
		setSelected(null)
		setDirty(true)
		setLiveAnnouncement(_(msg`Deleted table ${removedLabel} from floor plan`))
	}

	const handleDeleteSelectedElement = () => {
		if (!canWrite || !selectedElement) return
		const removedLabel = selectedElement.label ?? selectedElement.kind
		setDraftElements((prev) =>
			prev.filter((el) => el.id !== selectedElement.id),
		)
		setSelected(null)
		setDirty(true)
		setLiveAnnouncement(_(msg`Deleted element ${removedLabel} from floor plan`))
	}

	const handleDiscardDraft = () => {
		const nextAreas = areas
			.filter((area) => area.isActive !== false && !area.archivedAt)
			.slice()
			.sort((a, b) => a.sortOrder - b.sortOrder)
		setDraftAreas(nextAreas)
		setDraftTables(
			tables.filter((table) => table.isActive !== false && !table.archivedAt),
		)
		setDraftElements(elements)
		setDirty(false)
		setConfirmLeaveOpen(false)
		setLiveAnnouncement(_(msg`Discarded unsaved floor plan changes`))
	}

	const handleLeaveClick = () => {
		if (dirty) {
			setConfirmLeaveOpen(true)
			return
		}
		onLeave()
	}

	const handleConfirmLeaveWithoutSaving = () => {
		handleDiscardDraft()
		onLeave()
	}

	const handleKeyNudge = (
		event: ReactKeyboardEvent<HTMLElement>,
		itemKind: 'table' | 'element',
		item: { id: string; label: string | null; x: number; y: number },
	) => {
		if (!canWrite) return
		const step = event.shiftKey ? FLOOR_GRID_STEP : 1
		let nextX = item.x
		let nextY = item.y

		if (event.key === 'ArrowLeft') {
			nextX = clampCanvasCoord(item.x - step)
		} else if (event.key === 'ArrowRight') {
			nextX = clampCanvasCoord(item.x + step)
		} else if (event.key === 'ArrowUp') {
			nextY = clampCanvasCoord(item.y - step)
		} else if (event.key === 'ArrowDown') {
			nextY = clampCanvasCoord(item.y + step)
		} else {
			return
		}

		event.preventDefault()
		event.stopPropagation()

		const displayName = item.label || item.id
		const announcement = _(msg`Moved ${displayName} to (${nextX}, ${nextY})`)
		if (itemKind === 'table') {
			updateDraftTable(item.id, { x: nextX, y: nextY }, announcement)
		} else {
			updateDraftElement(item.id, { x: nextX, y: nextY }, announcement)
		}
	}

	useEffect(() => {
		if (!canWrite || !selected) return
		const onWindowKeyDown = (event: KeyboardEvent) => {
			if (event.defaultPrevented) return
			const target = event.target as HTMLElement | null
			if (
				target &&
				(target.tagName === 'INPUT' ||
					target.tagName === 'TEXTAREA' ||
					target.tagName === 'SELECT' ||
					target.isContentEditable)
			) {
				return
			}
			const step = event.shiftKey ? FLOOR_GRID_STEP : 1
			const item =
				selected.kind === 'table'
					? draftTables.find((t) => t.id === selected.id)
					: draftElements.find((e) => e.id === selected.id)
			if (!item) return

			let nextX = item.x
			let nextY = item.y
			if (event.key === 'ArrowLeft') {
				nextX = clampCanvasCoord(item.x - step)
			} else if (event.key === 'ArrowRight') {
				nextX = clampCanvasCoord(item.x + step)
			} else if (event.key === 'ArrowUp') {
				nextY = clampCanvasCoord(item.y - step)
			} else if (event.key === 'ArrowDown') {
				nextY = clampCanvasCoord(item.y + step)
			} else {
				return
			}

			event.preventDefault()
			const displayName =
				selected.kind === 'table'
					? (item as TableDto).label || item.id
					: (item as FloorElementDto).label ||
						(item as FloorElementDto).kind ||
						item.id
			const announcement = _(msg`Moved ${displayName} to (${nextX}, ${nextY})`)
			if (selected.kind === 'table') {
				setDraftTables((prev) =>
					prev.map((t) =>
						t.id === item.id ? { ...t, x: nextX, y: nextY } : t,
					),
				)
			} else {
				setDraftElements((prev) =>
					prev.map((e) =>
						e.id === item.id ? { ...e, x: nextX, y: nextY } : e,
					),
				)
			}
			setDirty(true)
			setLiveAnnouncement(announcement)
		}
		window.addEventListener('keydown', onWindowKeyDown)
		return () => window.removeEventListener('keydown', onWindowKeyDown)
	}, [canWrite, selected, draftTables, draftElements, _])

	const startPointerDrag = (
		event: ReactPointerEvent<HTMLElement>,
		itemKind: 'table' | 'element',
		item: {
			id: string
			x: number
			y: number
			width: number
			height: number
		},
		mode: 'move' | 'resize',
	) => {
		event.stopPropagation()
		setSelected({ kind: itemKind, id: item.id })
		if (!canWrite) return

		dragRef.current = {
			itemKind,
			itemId: item.id,
			mode,
			startClientX: event.clientX,
			startClientY: event.clientY,
			initialX: item.x,
			initialY: item.y,
			initialWidth: item.width,
			initialHeight: item.height,
		}
	}

	const handleCanvasPointerMove = (
		event: ReactPointerEvent<HTMLDivElement>,
	) => {
		const session = dragRef.current
		if (!session || !canWrite) return

		const dx = (event.clientX - session.startClientX) / zoom
		const dy = (event.clientY - session.startClientY) / zoom

		if (session.mode === 'move') {
			const nextX = snapToGrid(session.initialX + dx)
			const nextY = snapToGrid(session.initialY + dy)
			if (session.itemKind === 'table') {
				const tbl = draftTables.find((t) => t.id === session.itemId)
				const itemName = tbl?.label ?? session.itemId
				updateDraftTable(
					session.itemId,
					{ x: nextX, y: nextY },
					_(msg`Moved ${itemName} to (${nextX}, ${nextY})`),
				)
			} else {
				const el = draftElements.find((e) => e.id === session.itemId)
				const itemName = el?.label ?? el?.kind ?? session.itemId
				updateDraftElement(
					session.itemId,
					{ x: nextX, y: nextY },
					_(msg`Moved ${itemName} to (${nextX}, ${nextY})`),
				)
			}
		} else {
			const nextWidth = clampCanvasDimension(
				Math.round((session.initialWidth + dx) / FLOOR_GRID_STEP) *
					FLOOR_GRID_STEP,
			)
			const nextHeight = clampCanvasDimension(
				Math.round((session.initialHeight + dy) / FLOOR_GRID_STEP) *
					FLOOR_GRID_STEP,
			)
			if (session.itemKind === 'table') {
				const tbl = draftTables.find((t) => t.id === session.itemId)
				const itemName = tbl?.label ?? session.itemId
				updateDraftTable(
					session.itemId,
					{ width: nextWidth, height: nextHeight },
					_(msg`Resized ${itemName} to ${nextWidth} by ${nextHeight}`),
				)
			} else {
				const el = draftElements.find((e) => e.id === session.itemId)
				const itemName = el?.label ?? el?.kind ?? session.itemId
				updateDraftElement(
					session.itemId,
					{ width: nextWidth, height: nextHeight },
					_(msg`Resized ${itemName} to ${nextWidth} by ${nextHeight}`),
				)
			}
		}
	}

	const handleCanvasPointerUp = () => {
		dragRef.current = null
	}

	const handleSaveClick = async () => {
		if (!canWrite || saving) return
		const fallbackAreaId = currentAreaId || draftAreas[0]?.id || 'area_default'
		const stripNullish = <T extends Record<string, unknown>>(obj: T): T => {
			const clean: Record<string, unknown> = {}
			for (const [k, v] of Object.entries(obj)) {
				if (v !== null && v !== undefined && v !== '') {
					clean[k] = v
				}
			}
			return clean as T
		}
		const saved = await onSave({
			expectedFloorPlanVersion: floorPlanVersion,
			areas: draftAreas.map((a) =>
				stripNullish({
					...a,
					sort: a.sortOrder,
					onlineBookable: a.isBookableOnline,
				}),
			) as unknown as DiningAreaDto[],
			tables: draftTables.map((t) => {
				const rawShape = String(t.shape ?? 'square')
				const backendShape: TableShape =
					rawShape === 'high_top'
						? 'round'
						: rawShape === 'counter'
							? 'bar'
							: ['round', 'square', 'rect', 'booth', 'bar'].includes(rawShape)
								? (rawShape as TableShape)
								: 'square'
				return stripNullish({
					...t,
					shape: backendShape,
					w: t.width,
					h: t.height,
					onlineBookable: t.isBookableOnline,
				})
			}) as unknown as TableDto[],
			elements: draftElements.map((e) =>
				stripNullish({
					...e,
					areaId: e.areaId || fallbackAreaId,
					w: e.width,
					h: e.height,
				}),
			) as unknown as FloorElementDto[],
			archiveMissingTables: true,
		})
		if (saved) setDirty(false)
	}

	return (
		<div
			className="bg-muted fixed inset-0 z-50 flex h-dvh flex-col overflow-hidden"
			data-testid="floor-plan-editor"
		>
			{/* Screen reader live region for keyboard/pointer coordinates */}
			<div
				aria-live="polite"
				aria-atomic="true"
				className="sr-only"
				data-testid="floor-plan-live-region"
			>
				{liveAnnouncement}
			</div>

			<header className="bg-background flex h-12 shrink-0 items-center gap-3 border-b px-3">
				<Tooltip>
					<TooltipTrigger
						render={
							<Button
								type="button"
								variant="ghost"
								size="icon-xs"
								aria-label={_(msg`Back to tables`)}
								onClick={handleLeaveClick}
								data-testid="floor-plan-leave-button"
							>
								<Icon name="arrow-left" className="size-4 rtl:rotate-180" />
							</Button>
						}
					/>
					<TooltipContent>
						<Trans>Back to tables</Trans>
					</TooltipContent>
				</Tooltip>
				<div className="bg-border h-5 w-px" aria-hidden="true" />
				<div className="flex min-w-0 flex-1 items-center gap-3">
					<h2 className="truncate text-sm font-medium">
						<Trans>Floor plan</Trans>
						<span className="text-muted-foreground"> · {locationName}</span>
					</h2>
					{!canWrite ? (
						<Badge variant="secondary">
							<Trans>Read-only</Trans>
						</Badge>
					) : (
						<span
							role="status"
							className="text-muted-foreground flex items-center gap-1.5 text-xs"
						>
							<span
								aria-hidden="true"
								className={cn(
									'size-1.5 rounded-full',
									dirty ? 'bg-warning' : 'bg-success',
								)}
							/>
							{dirty ? (
								<span data-testid="floor-plan-unsaved-badge">
									<Trans>Unsaved changes</Trans>
								</span>
							) : (
								<Trans>Saved</Trans>
							)}
						</span>
					)}
				</div>
				<div className="flex items-center gap-2">
					{dirty && canWrite ? (
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={handleDiscardDraft}
							data-testid="floor-plan-discard-button"
						>
							<Icon name="undo-2" className="size-4" />
							<Trans>Discard changes</Trans>
						</Button>
					) : null}
					<Button
						type="button"
						size="sm"
						disabled={!canWrite || saving}
						onClick={() => void handleSaveClick()}
						data-testid="floor-plan-save-button"
					>
						<Icon name="check" className="size-4" />
						{saving ? <Trans>Saving…</Trans> : <Trans>Save</Trans>}
					</Button>
				</div>
			</header>

			<AlertDialog open={confirmLeaveOpen} onOpenChange={setConfirmLeaveOpen}>
				<AlertDialogContent data-testid="floor-plan-leave-confirm-banner">
					<AlertDialogHeader>
						<AlertDialogTitle>
							<Trans>Discard your changes?</Trans>
						</AlertDialogTitle>
						<AlertDialogDescription>
							<Trans>
								You have unsaved floor plan changes. If you leave now they are
								lost.
							</Trans>
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>
							<Trans>Keep editing</Trans>
						</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							onClick={handleConfirmLeaveWithoutSaving}
							data-testid="floor-plan-confirm-leave-button"
						>
							<Trans>Discard and leave</Trans>
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>

			{/* Someone else saved first */}
			{conflictMessage ? (
				<Alert
					variant="destructive"
					className="mx-3 mt-3 w-auto shrink-0"
					data-testid="floor-plan-conflict-banner"
				>
					<Icon name="alert-triangle" className="size-4" />
					<AlertTitle>
						<Trans>This floor plan was changed by someone else</Trans>
					</AlertTitle>
					<AlertDescription>
						<p>{conflictMessage}</p>
						<Button
							type="button"
							variant="outline"
							size="sm"
							className="mt-2"
							onClick={() => {
								setDirty(false)
								onReloadLatest()
							}}
							data-testid="floor-plan-reload-button"
						>
							<Icon name="refresh-cw" className="size-3.5" />
							<Trans>Reload latest floor plan</Trans>
						</Button>
					</AlertDescription>
				</Alert>
			) : null}

			{/* Reflowed moves & conflicts feedback after save */}
			{lastReflowedMoves.length > 0 || lastConflicts.length > 0 ? (
				<div
					className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 px-4 pt-3 text-xs"
					data-testid="floor-plan-reflow-summary"
				>
					{lastReflowedMoves.length > 0 ? (
						<span className="text-success">
							<Trans>Reassigned upcoming reservations automatically</Trans> (
							{lastReflowedMoves.length})
						</span>
					) : null}
					{lastConflicts.length > 0 ? (
						<span className="text-warning">
							<Trans>
								Upcoming reservations need manual attention after this
								floor-plan change
							</Trans>{' '}
							({lastConflicts.length})
						</span>
					) : null}
				</div>
			) : null}

			{/* Area tabs and canvas toolbar */}
			<div className="bg-background flex shrink-0 flex-wrap items-center justify-between gap-3 border-b px-3 py-2">
				<div
					className="flex flex-wrap items-center gap-1.5"
					role="tablist"
					aria-label={_(msg`Dining areas`)}
				>
					{draftAreas.map((area) => {
						const isActive = area.id === currentAreaId
						const areaTableCount = draftTables.filter(
							(t) => t.areaId === area.id && t.isActive && !t.archivedAt,
						).length
						return (
							<Button
								key={area.id}
								type="button"
								role="tab"
								aria-selected={isActive}
								variant={isActive ? 'secondary' : 'ghost'}
								size="sm"
								onClick={() => {
									setSelectedAreaId(area.id)
									setSelected(null)
								}}
								data-testid={`floor-area-tab-${area.name}`}
							>
								<span>{area.name}</span>
								<span className="text-muted-foreground tabular-nums">
									{areaTableCount}
								</span>
							</Button>
						)
					})}
				</div>

				<div className="flex flex-wrap items-center gap-2">
					{canWrite ? (
						<>
							<Button
								type="button"
								variant="outline"
								size="sm"
								onClick={handleAddTable}
								data-testid="floor-plan-add-table-button"
							>
								<Icon name="plus" className="size-4" />
								<Trans>Add table</Trans>
							</Button>

							<div className="flex items-center gap-1">
								<Select
									value={newElementKind}
									items={elementKindOptions}
									onValueChange={(next) =>
										next !== null && setNewElementKind(next as FloorElementKind)
									}
								>
									<SelectTrigger
										size="sm"
										className="w-36"
										aria-label={_(msg`Decor element type`)}
										data-testid="floor-plan-element-kind-select"
									>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{elementKindOptions.map((kind) => (
											<SelectItem key={kind.value} value={kind.value}>
												{kind.label}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
								<Button
									type="button"
									variant="outline"
									size="sm"
									onClick={handleAddElement}
									data-testid="floor-plan-add-element-button"
								>
									<Icon name="plus" className="size-3.5" />
									<Trans>Add decor</Trans>
								</Button>
							</div>
						</>
					) : null}

					<div className="flex items-center gap-1 border-s ps-2">
						<Button
							type="button"
							variant="ghost"
							size="icon-sm"
							onClick={() =>
								setZoom((z) =>
									Math.max(0.5, Math.round((z - 0.25) * 100) / 100),
								)
							}
							aria-label={_(msg`Zoom out`)}
							data-testid="floor-plan-zoom-out"
						>
							<Icon name="minus" className="size-3.5" />
						</Button>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							className="tabular-nums"
							onClick={() => setZoom(1)}
							data-testid="floor-plan-zoom-reset"
						>
							{Math.round(zoom * 100)}%
						</Button>
						<Button
							type="button"
							variant="ghost"
							size="icon-sm"
							onClick={() =>
								setZoom((z) => Math.min(2, Math.round((z + 0.25) * 100) / 100))
							}
							aria-label={_(msg`Zoom in`)}
							data-testid="floor-plan-zoom-in"
						>
							<Icon name="plus" className="size-3.5" />
						</Button>
						<Button
							type="button"
							variant={showGrid ? 'secondary' : 'ghost'}
							size="sm"
							aria-pressed={showGrid}
							onClick={() => setShowGrid((g) => !g)}
							data-testid="floor-plan-toggle-grid"
						>
							<Icon name="layout-grid" className="size-3.5" />
							<Trans>Grid</Trans>
						</Button>
					</div>
				</div>
			</div>

			{/* Main Body: Canvas (dir="ltr") + Inspector */}
			<div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto lg:grid-cols-[1fr_340px] lg:overflow-hidden">
				{/* Canvas Viewport */}
				<div
					dir="ltr"
					className="relative min-h-[420px] overflow-auto p-4 lg:min-h-0"
					onPointerMove={handleCanvasPointerMove}
					onPointerUp={handleCanvasPointerUp}
					onClick={() => setSelected(null)}
				>
					<div
						dir="ltr"
						data-testid="floor-plan-canvas-surface"
						className="border-border bg-card relative origin-top-left rounded-lg border shadow-sm select-none"
						style={{
							width: `${FLOOR_CANVAS_MAX}px`,
							height: '720px',
							transform: `scale(${zoom})`,
							transformOrigin: '0 0',
							backgroundImage: showGrid
								? 'radial-gradient(circle, var(--border-strong) 1px, transparent 1px)'
								: 'none',
							backgroundSize: `${FLOOR_GRID_STEP * 2}px ${FLOOR_GRID_STEP * 2}px`,
						}}
					>
						{/* Decor Elements */}
						{visibleElements.map((el) => {
							const isSelected =
								selected?.kind === 'element' && selected.id === el.id
							const elementName = el.label || el.kind
							const elementX = el.x
							const elementY = el.y
							return (
								<div
									key={el.id}
									role="button"
									tabIndex={0}
									aria-label={_(
										msg`Element ${elementName} (${elementX}, ${elementY})`,
									)}
									data-testid={`floor-element-${el.id}`}
									onClick={(e) => {
										e.stopPropagation()
										e.currentTarget.focus()
										setSelected({ kind: 'element', id: el.id })
									}}
									onPointerDown={(e) => {
										e.currentTarget.focus()
										startPointerDrag(e, 'element', el, 'move')
									}}
									onKeyDown={(e) =>
										handleKeyNudge(e, 'element', {
											id: el.id,
											label: el.label ?? el.kind,
											x: el.x,
											y: el.y,
										})
									}
									className={cn(
										'absolute flex items-center justify-center border text-xs font-medium transition-shadow focus-visible:ring-2 focus-visible:outline-none',
										el.kind === 'zone'
											? 'border-border-strong bg-muted/60 text-muted-foreground border-dashed'
											: el.kind === 'plant'
												? 'border-position-green/40 bg-position-green/15 text-foreground rounded-full'
												: 'border-border-strong bg-muted text-foreground rounded',
										isSelected && 'ring-primary z-20 ring-2',
									)}
									style={{
										left: `${el.x}px`,
										top: `${el.y}px`,
										width: `${el.width}px`,
										height: `${el.height}px`,
										transform: `rotate(${el.rotation}deg)`,
										cursor: canWrite ? 'grab' : 'default',
									}}
								>
									<span className="truncate px-1">
										{el.label || el.kind.toUpperCase()}
									</span>

									{isSelected && canWrite ? (
										<div
											role="presentation"
											data-testid={`floor-element-resize-${el.id}`}
											onPointerDown={(e) =>
												startPointerDrag(e, 'element', el, 'resize')
											}
											className="bg-primary absolute end-0 bottom-0 size-3 cursor-se-resize rounded-tl"
										/>
									) : null}
								</div>
							)
						})}

						{/* Tables */}
						{visibleTables.map((table) => {
							const isSelected =
								selected?.kind === 'table' && selected.id === table.id
							const shapeClass =
								table.shape === 'round'
									? 'rounded-full'
									: table.shape === 'booth'
										? 'rounded-2xl border-2'
										: 'rounded-lg'
							const tableName = table.label
							const tableMinCovers = table.minCovers
							const tableMaxCovers = table.maxCovers
							const tableX = table.x
							const tableY = table.y
							return (
								<div
									key={table.id}
									role="button"
									tabIndex={0}
									aria-label={_(
										msg`Table ${tableName}, ${tableMinCovers}-${tableMaxCovers} covers at (${tableX}, ${tableY})`,
									)}
									data-testid={`floor-table-${table.label}`}
									onClick={(e) => {
										e.stopPropagation()
										e.currentTarget.focus()
										setSelected({ kind: 'table', id: table.id })
									}}
									onPointerDown={(e) => {
										e.currentTarget.focus()
										startPointerDrag(e, 'table', table, 'move')
									}}
									onKeyDown={(e) =>
										handleKeyNudge(e, 'table', {
											id: table.id,
											label: table.label,
											x: table.x,
											y: table.y,
										})
									}
									className={cn(
										'border-border bg-background text-foreground absolute flex flex-col items-center justify-center border shadow-sm transition-shadow focus-visible:ring-2 focus-visible:outline-none',
										shapeClass,
										table.isBookableOnline
											? 'border-success/60 bg-success/10'
											: 'border-warning/60 bg-warning/10',
										isSelected && 'ring-primary z-30 shadow-md ring-2',
									)}
									style={{
										left: `${table.x}px`,
										top: `${table.y}px`,
										width: `${table.width}px`,
										height: `${table.height}px`,
										transform: `rotate(${table.rotation}deg)`,
										cursor: canWrite ? 'grab' : 'pointer',
									}}
								>
									<span className="text-xs font-bold">{table.label}</span>
									<span className="text-muted-foreground text-2xs">
										{table.minCovers}–{table.maxCovers}p
									</span>

									{isSelected && canWrite ? (
										<div
											role="presentation"
											data-testid={`floor-table-resize-${table.label}`}
											onPointerDown={(e) =>
												startPointerDrag(e, 'table', table, 'resize')
											}
											className="bg-primary absolute end-0 bottom-0 size-3.5 cursor-se-resize rounded-tl"
										/>
									) : null}
								</div>
							)
						})}
					</div>
				</div>

				{/* Right inspector panel */}
				<aside className="bg-background min-h-0 overflow-y-auto border-t p-4 lg:border-s lg:border-t-0">
					{selectedTable ? (
						<div className="flex flex-col gap-5">
							<div className="flex items-center justify-between gap-2">
								<h3 className="truncate text-sm font-semibold">
									<Trans>Table</Trans>: {selectedTable.label}
								</h3>
								{canWrite ? (
									<AlertDialog>
										<AlertDialogTrigger
											render={
												<Button
													type="button"
													variant="destructive"
													size="sm"
													data-testid="floor-inspector-delete-table"
												>
													<Icon name="trash-2" className="size-3.5" />
													<Trans>Delete</Trans>
												</Button>
											}
										/>
										<AlertDialogContent>
											<AlertDialogHeader>
												<AlertDialogTitle>
													<Trans>Delete this table?</Trans>
												</AlertDialogTitle>
												<AlertDialogDescription>
													<Trans>
														The table leaves the floor plan when you save. Past
														reservations keep their history.
													</Trans>
												</AlertDialogDescription>
											</AlertDialogHeader>
											<AlertDialogFooter>
												<AlertDialogCancel>
													<Trans>Cancel</Trans>
												</AlertDialogCancel>
												<AlertDialogAction
													variant="destructive"
													onClick={handleArchiveSelectedTable}
													data-testid="floor-inspector-delete-table-confirm"
												>
													<Trans>Delete table</Trans>
												</AlertDialogAction>
											</AlertDialogFooter>
										</AlertDialogContent>
									</AlertDialog>
								) : null}
							</div>

							<div className="grid grid-cols-2 gap-3">
								<TextField
									id="inspector-table-label"
									label={<Trans>Label</Trans>}
									value={selectedTable.label}
									disabled={!canWrite}
									onChange={(e) =>
										updateDraftTable(selectedTable.id, {
											label: e.target.value,
										})
									}
									data-testid="floor-inspector-label-input"
								/>
								<SelectField
									id="inspector-table-shape"
									label={<Trans>Shape</Trans>}
									value={selectedTable.shape}
									disabled={!canWrite}
									options={tableShapeOptions}
									onValueChange={(shape) =>
										updateDraftTable(selectedTable.id, {
											shape: shape as TableShape,
										})
									}
								/>
								<NumberField
									id="inspector-min-covers"
									label={<Trans>Fewest guests</Trans>}
									min={1}
									max={99}
									disabled={!canWrite}
									value={selectedTable.minCovers}
									onValueChange={(raw) => {
										const minCovers = Math.max(1, Math.min(99, raw || 1))
										updateDraftTable(selectedTable.id, {
											minCovers,
											maxCovers: Math.max(minCovers, selectedTable.maxCovers),
										})
									}}
								/>
								<NumberField
									id="inspector-max-covers"
									label={<Trans>Most guests</Trans>}
									min={1}
									max={99}
									disabled={!canWrite}
									value={selectedTable.maxCovers}
									onValueChange={(raw) => {
										const maxCovers = Math.max(
											selectedTable.minCovers,
											Math.min(99, raw || 1),
										)
										updateDraftTable(selectedTable.id, { maxCovers })
									}}
								/>
							</div>

							<div className="flex flex-col">
								<SwitchField
									label={<Trans>Bookable online</Trans>}
									checked={selectedTable.isBookableOnline}
									disabled={!canWrite}
									onCheckedChange={(isBookableOnline) =>
										updateDraftTable(selectedTable.id, { isBookableOnline })
									}
								/>
								<SwitchField
									label={<Trans>Can be combined with other tables</Trans>}
									checked={selectedTable.combinable}
									disabled={!canWrite}
									onCheckedChange={(combinable) =>
										updateDraftTable(selectedTable.id, { combinable })
									}
								/>
								<SwitchField
									label={<Trans>Wheelchair accessible</Trans>}
									checked={selectedTable.isAccessible}
									disabled={!canWrite}
									onCheckedChange={(isAccessible) =>
										updateDraftTable(selectedTable.id, { isAccessible })
									}
								/>
							</div>

							<RotationPresets
								value={selectedTable.rotation}
								presets={ROTATION_PRESETS}
								disabled={!canWrite}
								onPick={(deg) => {
									const tableLabel = selectedTable.label
									updateDraftTable(
										selectedTable.id,
										{ rotation: deg },
										_(msg`Rotated ${tableLabel} to ${deg} degrees`),
									)
								}}
							>
								<Input
									id="inspector-rotation"
									type="number"
									min={0}
									max={359}
									disabled={!canWrite}
									aria-label={_(msg`Rotation (degrees)`)}
									value={selectedTable.rotation}
									onChange={(e) =>
										updateDraftTable(selectedTable.id, {
											rotation: normalizeRotation(Number(e.target.value)),
										})
									}
									className="w-20"
									data-testid="floor-inspector-rotation-input"
								/>
							</RotationPresets>

							<Collapsible>
								<CollapsibleTrigger
									render={
										<Button
											type="button"
											variant="ghost"
											size="sm"
											className="self-start"
										/>
									}
								>
									<Icon name="chevron-down" className="size-3.5" />
									<Trans>Position and size</Trans>
								</CollapsibleTrigger>
								<CollapsibleContent>
									<div className="flex flex-col gap-3 pt-2">
										<div className="grid grid-cols-2 gap-3">
											<NumberField
												id="inspector-x"
												label={<Trans>X (0–1200)</Trans>}
												min={0}
												max={1200}
												disabled={!canWrite}
												value={selectedTable.x}
												testId="floor-inspector-x-input"
												onValueChange={(raw) => {
													const nextX = clampCanvasCoord(raw)
													const tableLabel = selectedTable.label
													const currentY = selectedTable.y
													updateDraftTable(
														selectedTable.id,
														{ x: nextX },
														_(
															msg`Moved ${tableLabel} to (${nextX}, ${currentY})`,
														),
													)
												}}
											/>
											<NumberField
												id="inspector-y"
												label={<Trans>Y (0–1200)</Trans>}
												min={0}
												max={1200}
												disabled={!canWrite}
												value={selectedTable.y}
												testId="floor-inspector-y-input"
												onValueChange={(raw) => {
													const nextY = clampCanvasCoord(raw)
													const tableLabel = selectedTable.label
													const currentX = selectedTable.x
													updateDraftTable(
														selectedTable.id,
														{ y: nextY },
														_(
															msg`Moved ${tableLabel} to (${currentX}, ${nextY})`,
														),
													)
												}}
											/>
											<NumberField
												id="inspector-width"
												label={<Trans>Width (20–600)</Trans>}
												min={20}
												max={600}
												step={10}
												disabled={!canWrite}
												value={selectedTable.width}
												testId="floor-inspector-width-input"
												onValueChange={(raw) =>
													updateDraftTable(selectedTable.id, {
														width: clampCanvasDimension(raw),
													})
												}
											/>
											<NumberField
												id="inspector-height"
												label={<Trans>Height (20–600)</Trans>}
												min={20}
												max={600}
												step={10}
												disabled={!canWrite}
												value={selectedTable.height}
												testId="floor-inspector-height-input"
												onValueChange={(raw) =>
													updateDraftTable(selectedTable.id, {
														height: clampCanvasDimension(raw),
													})
												}
											/>
										</div>
									</div>
								</CollapsibleContent>
							</Collapsible>
						</div>
					) : selectedElement ? (
						<div className="flex flex-col gap-5">
							<div className="flex items-center justify-between gap-2">
								<h3 className="truncate text-sm font-semibold">
									<Trans>Decor</Trans>:{' '}
									{selectedElement.label || selectedElement.kind}
								</h3>
								{canWrite ? (
									<Button
										type="button"
										variant="destructive"
										size="sm"
										onClick={handleDeleteSelectedElement}
										data-testid="floor-inspector-delete-element"
									>
										<Icon name="trash-2" className="size-3.5" />
										<Trans>Delete</Trans>
									</Button>
								) : null}
							</div>
							<TextField
								id="inspector-element-label"
								label={<Trans>Element label</Trans>}
								disabled={!canWrite}
								value={selectedElement.label ?? ''}
								onChange={(e) =>
									updateDraftElement(selectedElement.id, {
										label: e.target.value,
									})
								}
							/>
							<div className="grid grid-cols-2 gap-3">
								<NumberField
									id="inspector-el-x"
									label={<Trans>X (0–1200)</Trans>}
									min={0}
									max={1200}
									disabled={!canWrite}
									value={selectedElement.x}
									onValueChange={(raw) =>
										updateDraftElement(selectedElement.id, {
											x: clampCanvasCoord(raw),
										})
									}
								/>
								<NumberField
									id="inspector-el-y"
									label={<Trans>Y (0–1200)</Trans>}
									min={0}
									max={1200}
									disabled={!canWrite}
									value={selectedElement.y}
									onValueChange={(raw) =>
										updateDraftElement(selectedElement.id, {
											y: clampCanvasCoord(raw),
										})
									}
								/>
								<NumberField
									id="inspector-el-width"
									label={<Trans>Width</Trans>}
									min={20}
									max={600}
									disabled={!canWrite}
									value={selectedElement.width}
									onValueChange={(raw) =>
										updateDraftElement(selectedElement.id, {
											width: clampCanvasDimension(raw),
										})
									}
								/>
								<NumberField
									id="inspector-el-height"
									label={<Trans>Height</Trans>}
									min={20}
									max={600}
									disabled={!canWrite}
									value={selectedElement.height}
									onValueChange={(raw) =>
										updateDraftElement(selectedElement.id, {
											height: clampCanvasDimension(raw),
										})
									}
								/>
							</div>
							<RotationPresets
								value={selectedElement.rotation}
								presets={ROTATION_PRESETS}
								disabled={!canWrite}
								onPick={(deg) =>
									updateDraftElement(selectedElement.id, { rotation: deg })
								}
							/>
						</div>
					) : (
						<div className="text-muted-foreground flex flex-col gap-2 py-8 text-center text-sm">
							<p className="text-foreground font-medium">
								<Trans>No item selected</Trans>
							</p>
							<p className="text-xs">
								<Trans>
									Click a table or decor element on the canvas to edit, resize,
									rotate, or nudge it with the keyboard.
								</Trans>
							</p>
							<p className="text-xs">
								<Trans>
									Drag items on the 10-unit grid, or use Arrow keys (1 unit) and
									Shift+Arrow (10 units). Nothing is saved until you click Save.
								</Trans>
							</p>
						</div>
					)}
				</aside>
			</div>
		</div>
	)
}
