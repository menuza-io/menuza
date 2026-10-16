import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { cn } from '@repo/ui'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/card'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import {
	type KeyboardEvent as ReactKeyboardEvent,
	type PointerEvent as ReactPointerEvent,
	useEffect,
	useMemo,
	useRef,
	useState,
} from 'react'
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
	onSave: (draft: FloorPlanSaveDraft) => Promise<void>
	onReloadLatest: () => void
	onLeave: () => void
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

const TABLE_SHAPES: ReadonlyArray<{ value: TableShape; label: string }> = [
	{ value: 'round', label: 'Round' },
	{ value: 'square', label: 'Square' },
	{ value: 'rect', label: 'Rectangle' },
	{ value: 'booth', label: 'Booth' },
	{ value: 'bar', label: 'Bar seat' },
	{ value: 'high_top', label: 'High-top' },
]

const ELEMENT_KINDS: ReadonlyArray<{
	value: FloorElementKind
	label: string
	defaultWidth: number
	defaultHeight: number
}> = [
	{ value: 'wall', label: 'Wall', defaultWidth: 160, defaultHeight: 20 },
	{ value: 'bar', label: 'Bar counter', defaultWidth: 160, defaultHeight: 60 },
	{ value: 'door', label: 'Door', defaultWidth: 60, defaultHeight: 20 },
	{ value: 'window', label: 'Window', defaultWidth: 120, defaultHeight: 20 },
	{ value: 'label', label: 'Label', defaultWidth: 120, defaultHeight: 40 },
	{ value: 'plant', label: 'Plant', defaultWidth: 40, defaultHeight: 40 },
	{ value: 'zone', label: 'Zone', defaultWidth: 200, defaultHeight: 160 },
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
}: FloorPlanCanvasProps) {
	const { _ } = useLingui()

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
				nameI18n: { en: 'Main Dining' },
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
			label: preset.label,
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
		const presetLabel = preset.label
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
		setLiveAnnouncement(_(msg`Removed table ${removedLabel} from floor plan`))
	}

	const handleDeleteSelectedElement = () => {
		if (!canWrite || !selectedElement) return
		const removedLabel = selectedElement.label ?? selectedElement.kind
		setDraftElements((prev) =>
			prev.filter((el) => el.id !== selectedElement.id),
		)
		setSelected(null)
		setDirty(true)
		setLiveAnnouncement(_(msg`Removed element ${removedLabel} from floor plan`))
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
		await onSave({
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
		setDirty(false)
	}

	return (
		<div
			className="border-border bg-background flex min-h-[720px] flex-col rounded-xl border"
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

			{/* Top Full-Screen Header Bar */}
			<div className="border-border bg-card flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
				<div className="flex flex-wrap items-center gap-3">
					<div>
						<div className="flex items-center gap-2">
							<h2 className="text-foreground text-base font-semibold">
								<Trans>Floor Plan Designer</Trans>
							</h2>
							<Badge variant="outline">
								{locationName} · v{floorPlanVersion}
							</Badge>
							{dirty ? (
								<Badge
									variant="secondary"
									data-testid="floor-plan-unsaved-badge"
								>
									<Trans>Unsaved draft changes</Trans>
								</Badge>
							) : (
								<Badge variant="outline">
									<Trans>Saved</Trans>
								</Badge>
							)}
							{!canWrite ? (
								<Badge variant="secondary">
									<Trans>Read-only</Trans>
								</Badge>
							) : null}
						</div>
						<p className="text-muted-foreground text-xs">
							<Trans>
								Drag tables on the 10-unit grid, or use Arrow keys (1 unit) and
								Shift+Arrow (10 units). Changes stay in a local draft until you
								click Save.
							</Trans>
						</p>
					</div>
				</div>

				<div className="flex flex-wrap items-center gap-2">
					{dirty && canWrite ? (
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={handleDiscardDraft}
							data-testid="floor-plan-discard-button"
						>
							<Icon name="undo-2" className="size-4" />
							<Trans>Discard draft</Trans>
						</Button>
					) : null}

					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={handleLeaveClick}
						data-testid="floor-plan-leave-button"
					>
						<Trans>Leave without saving</Trans>
					</Button>

					<Button
						type="button"
						size="sm"
						disabled={!canWrite || saving}
						onClick={() => void handleSaveClick()}
						data-testid="floor-plan-save-button"
					>
						<Icon name="check" className="size-4" />
						{saving ? <Trans>Saving…</Trans> : <Trans>Save floor plan</Trans>}
					</Button>
				</div>
			</div>

			{/* Leave confirmation banner when draft has unsaved changes */}
			{confirmLeaveOpen ? (
				<div
					className="flex flex-wrap items-center justify-between gap-3 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-sm"
					data-testid="floor-plan-leave-confirm-banner"
				>
					<span className="text-foreground font-medium">
						<Trans>
							You have unsaved floor plan changes. Leave and discard your local
							draft?
						</Trans>
					</span>
					<div className="flex items-center gap-2">
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={() => setConfirmLeaveOpen(false)}
						>
							<Trans>Keep editing</Trans>
						</Button>
						<Button
							type="button"
							variant="destructive"
							size="sm"
							onClick={handleConfirmLeaveWithoutSaving}
							data-testid="floor-plan-confirm-leave-button"
						>
							<Trans>Discard & leave</Trans>
						</Button>
					</div>
				</div>
			) : null}

			{/* 409 Stale Version Conflict Banner */}
			{conflictMessage ? (
				<div
					role="alert"
					className="flex flex-wrap items-center justify-between gap-3 border-b border-amber-500/40 bg-amber-500/15 px-4 py-3 text-sm"
					data-testid="floor-plan-conflict-banner"
				>
					<div className="flex items-center gap-2">
						<Icon
							name="alert-triangle"
							className="size-4 shrink-0 text-amber-600 dark:text-amber-400"
						/>
						<span className="text-foreground font-medium">
							{conflictMessage}
						</span>
					</div>
					<div className="flex items-center gap-2">
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={onReloadLatest}
							data-testid="floor-plan-reload-button"
						>
							<Icon name="refresh-cw" className="size-3.5" />
							<Trans>Reload latest floor plan</Trans>
						</Button>
					</div>
				</div>
			) : null}

			{/* Reflowed moves & conflicts feedback after save */}
			{lastReflowedMoves.length > 0 || lastConflicts.length > 0 ? (
				<div
					className="border-border bg-muted/40 flex flex-wrap items-center justify-between gap-3 border-b px-4 py-2 text-xs"
					data-testid="floor-plan-reflow-summary"
				>
					{lastReflowedMoves.length > 0 ? (
						<span className="text-emerald-700 dark:text-emerald-300">
							<Trans>Reassigned upcoming reservations automatically</Trans> (
							{lastReflowedMoves.length})
						</span>
					) : null}
					{lastConflicts.length > 0 ? (
						<span className="text-amber-700 dark:text-amber-300">
							<Trans>
								Upcoming reservations need manual attention after this
								floor-plan change
							</Trans>{' '}
							({lastConflicts.length})
						</span>
					) : null}
				</div>
			) : null}

			{/* Area Tabs & Canvas Toolbar */}
			<div className="border-border bg-muted/30 flex flex-wrap items-center justify-between gap-3 border-b px-4 py-2.5">
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
								variant={isActive ? 'default' : 'outline'}
								size="sm"
								onClick={() => {
									setSelectedAreaId(area.id)
									setSelected(null)
								}}
								data-testid={`floor-area-tab-${area.name}`}
							>
								<span>{area.name}</span>
								<Badge variant="secondary" className="ml-1.5">
									{areaTableCount}
								</Badge>
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
								<select
									aria-label={_(msg`Decor element type`)}
									value={newElementKind}
									onChange={(e) =>
										setNewElementKind(e.target.value as FloorElementKind)
									}
									className="border-input bg-background text-foreground h-8 rounded-md border px-2 text-xs"
									data-testid="floor-plan-element-kind-select"
								>
									{ELEMENT_KINDS.map((kind) => (
										<option key={kind.value} value={kind.value}>
											{kind.label}
										</option>
									))}
								</select>
								<Button
									type="button"
									variant="outline"
									size="sm"
									onClick={handleAddElement}
									data-testid="floor-plan-add-element-button"
								>
									<Icon name="plus" className="size-3.5" />
									<Trans>Add element</Trans>
								</Button>
							</div>
						</>
					) : null}

					<div className="border-border flex items-center gap-1 border-l pl-2">
						<Button
							type="button"
							variant="outline"
							size="sm"
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
							onClick={() => setZoom(1)}
							data-testid="floor-plan-zoom-reset"
						>
							{Math.round(zoom * 100)}%
						</Button>
						<Button
							type="button"
							variant="outline"
							size="sm"
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
							variant={showGrid ? 'secondary' : 'outline'}
							size="sm"
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
			<div className="grid flex-1 grid-cols-1 lg:grid-cols-[1fr_340px]">
				{/* Canvas Viewport */}
				<div
					dir="ltr"
					className="bg-muted/20 relative min-h-[560px] overflow-auto p-4"
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
								? 'radial-gradient(circle, rgba(148, 163, 184, 0.45) 1px, transparent 1px)'
								: 'none',
							backgroundSize: `${FLOOR_GRID_STEP * 2}px ${FLOOR_GRID_STEP * 2}px`,
						}}
					>
						{/* Decor Elements */}
						{visibleElements.map((el) => {
							const isSelected =
								selected?.kind === 'element' && selected.id === el.id
							return (
								<div
									key={el.id}
									role="button"
									tabIndex={0}
									aria-label={`Element ${el.label || el.kind} (${el.x}, ${el.y})`}
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
											? 'border-dashed border-slate-400/50 bg-slate-500/10 text-slate-700 dark:text-slate-300'
											: el.kind === 'plant'
												? 'rounded-full border-emerald-500/40 bg-emerald-500/15 text-emerald-800 dark:text-emerald-200'
												: 'rounded border-slate-500/50 bg-slate-500/20 text-slate-800 dark:text-slate-200',
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
											className="bg-primary absolute right-0 bottom-0 size-3 cursor-se-resize rounded-tl"
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
							return (
								<div
									key={table.id}
									role="button"
									tabIndex={0}
									aria-label={`Table ${table.label}, ${table.minCovers}-${table.maxCovers} covers at (${table.x}, ${table.y})`}
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
											? 'border-emerald-500/60 bg-emerald-500/10'
											: 'border-amber-500/60 bg-amber-500/10',
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
									<span className="text-muted-foreground text-[10px]">
										{table.minCovers}–{table.maxCovers}p
									</span>

									{isSelected && canWrite ? (
										<div
											role="presentation"
											data-testid={`floor-table-resize-${table.label}`}
											onPointerDown={(e) =>
												startPointerDrag(e, 'table', table, 'resize')
											}
											className="bg-primary absolute right-0 bottom-0 size-3.5 cursor-se-resize rounded-tl"
										/>
									) : null}
								</div>
							)
						})}
					</div>
				</div>

				{/* Right Inspector Panel */}
				<div className="border-border bg-card border-t p-4 lg:border-t-0 lg:border-l">
					{selectedTable ? (
						<Card>
							<CardHeader className="pb-3">
								<div className="flex items-center justify-between">
									<CardTitle className="text-sm font-semibold">
										<Trans>Table Inspector</Trans>: {selectedTable.label}
									</CardTitle>
									{canWrite ? (
										<Button
											type="button"
											variant="destructive"
											size="sm"
											onClick={handleArchiveSelectedTable}
											data-testid="floor-inspector-delete-table"
										>
											<Icon name="trash-2" className="size-3.5" />
											<Trans>Archive</Trans>
										</Button>
									) : null}
								</div>
							</CardHeader>
							<CardContent className="flex flex-col gap-3">
								<div className="grid grid-cols-2 gap-2">
									<div className="flex flex-col gap-1">
										<Label htmlFor="inspector-table-label">
											<Trans>Label</Trans>
										</Label>
										<Input
											id="inspector-table-label"
											value={selectedTable.label}
											disabled={!canWrite}
											onChange={(e) =>
												updateDraftTable(selectedTable.id, {
													label: e.target.value,
												})
											}
											data-testid="floor-inspector-label-input"
										/>
									</div>
									<div className="flex flex-col gap-1">
										<Label htmlFor="inspector-table-shape">
											<Trans>Shape</Trans>
										</Label>
										<select
											id="inspector-table-shape"
											value={selectedTable.shape}
											disabled={!canWrite}
											onChange={(e) =>
												updateDraftTable(selectedTable.id, {
													shape: e.target.value as TableShape,
												})
											}
											className="border-input bg-background text-foreground h-9 rounded-md border px-2 text-sm"
											data-testid="floor-inspector-shape-select"
										>
											{TABLE_SHAPES.map((s) => (
												<option key={s.value} value={s.value}>
													{s.label}
												</option>
											))}
										</select>
									</div>
								</div>

								<div className="grid grid-cols-2 gap-2">
									<div className="flex flex-col gap-1">
										<Label htmlFor="inspector-min-covers">
											<Trans>Min covers</Trans>
										</Label>
										<Input
											id="inspector-min-covers"
											type="number"
											min={1}
											max={99}
											disabled={!canWrite}
											value={selectedTable.minCovers}
											onChange={(e) => {
												const minCovers = Math.max(
													1,
													Math.min(99, Number(e.target.value) || 1),
												)
												updateDraftTable(selectedTable.id, {
													minCovers,
													maxCovers: Math.max(
														minCovers,
														selectedTable.maxCovers,
													),
												})
											}}
										/>
									</div>
									<div className="flex flex-col gap-1">
										<Label htmlFor="inspector-max-covers">
											<Trans>Max covers</Trans>
										</Label>
										<Input
											id="inspector-max-covers"
											type="number"
											min={1}
											max={99}
											disabled={!canWrite}
											value={selectedTable.maxCovers}
											onChange={(e) => {
												const maxCovers = Math.max(
													selectedTable.minCovers,
													Math.min(99, Number(e.target.value) || 1),
												)
												updateDraftTable(selectedTable.id, { maxCovers })
											}}
										/>
									</div>
								</div>

								<div className="grid grid-cols-2 gap-2">
									<div className="flex flex-col gap-1">
										<Label htmlFor="inspector-x">
											<Trans>X (0–1200)</Trans>
										</Label>
										<Input
											id="inspector-x"
											type="number"
											min={0}
											max={1200}
											disabled={!canWrite}
											value={selectedTable.x}
											onChange={(e) => {
												const nextX = clampCanvasCoord(Number(e.target.value))
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
											data-testid="floor-inspector-x-input"
										/>
									</div>
									<div className="flex flex-col gap-1">
										<Label htmlFor="inspector-y">
											<Trans>Y (0–1200)</Trans>
										</Label>
										<Input
											id="inspector-y"
											type="number"
											min={0}
											max={1200}
											disabled={!canWrite}
											value={selectedTable.y}
											onChange={(e) => {
												const nextY = clampCanvasCoord(Number(e.target.value))
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
											data-testid="floor-inspector-y-input"
										/>
									</div>
								</div>

								<div className="grid grid-cols-2 gap-2">
									<div className="flex flex-col gap-1">
										<Label htmlFor="inspector-width">
											<Trans>Width (20–600)</Trans>
										</Label>
										<Input
											id="inspector-width"
											type="number"
											min={20}
											max={600}
											step={10}
											disabled={!canWrite}
											value={selectedTable.width}
											onChange={(e) =>
												updateDraftTable(selectedTable.id, {
													width: clampCanvasDimension(Number(e.target.value)),
												})
											}
											data-testid="floor-inspector-width-input"
										/>
									</div>
									<div className="flex flex-col gap-1">
										<Label htmlFor="inspector-height">
											<Trans>Height (20–600)</Trans>
										</Label>
										<Input
											id="inspector-height"
											type="number"
											min={20}
											max={600}
											step={10}
											disabled={!canWrite}
											value={selectedTable.height}
											onChange={(e) =>
												updateDraftTable(selectedTable.id, {
													height: clampCanvasDimension(Number(e.target.value)),
												})
											}
											data-testid="floor-inspector-height-input"
										/>
									</div>
								</div>

								<div className="flex flex-col gap-1.5">
									<Label htmlFor="inspector-rotation">
										<Trans>Rotation (degrees)</Trans>
									</Label>
									<div className="flex items-center gap-1.5">
										{ROTATION_PRESETS.map((deg) => (
											<Button
												key={deg}
												type="button"
												size="sm"
												variant={
													selectedTable.rotation === deg ? 'default' : 'outline'
												}
												disabled={!canWrite}
												onClick={() => {
													const tableLabel = selectedTable.label
													updateDraftTable(
														selectedTable.id,
														{ rotation: deg },
														_(msg`Rotated ${tableLabel} to ${deg} degrees`),
													)
												}}
											>
												{deg}°
											</Button>
										))}
										<Input
											id="inspector-rotation"
											type="number"
											min={0}
											max={359}
											disabled={!canWrite}
											value={selectedTable.rotation}
											onChange={(e) =>
												updateDraftTable(selectedTable.id, {
													rotation: normalizeRotation(Number(e.target.value)),
												})
											}
											className="w-20"
											data-testid="floor-inspector-rotation-input"
										/>
									</div>
								</div>

								<div className="flex flex-col gap-2 pt-1">
									<label className="flex items-center gap-2 text-xs">
										<input
											type="checkbox"
											checked={selectedTable.isBookableOnline}
											disabled={!canWrite}
											onChange={(e) =>
												updateDraftTable(selectedTable.id, {
													isBookableOnline: e.target.checked,
												})
											}
										/>
										<Trans>Bookable online</Trans>
									</label>
									<label className="flex items-center gap-2 text-xs">
										<input
											type="checkbox"
											checked={selectedTable.combinable}
											disabled={!canWrite}
											onChange={(e) =>
												updateDraftTable(selectedTable.id, {
													combinable: e.target.checked,
												})
											}
										/>
										<Trans>Combinable with other tables</Trans>
									</label>
									<label className="flex items-center gap-2 text-xs">
										<input
											type="checkbox"
											checked={selectedTable.isAccessible}
											disabled={!canWrite}
											onChange={(e) =>
												updateDraftTable(selectedTable.id, {
													isAccessible: e.target.checked,
												})
											}
										/>
										<Trans>Wheelchair accessible</Trans>
									</label>
								</div>
							</CardContent>
						</Card>
					) : selectedElement ? (
						<Card>
							<CardHeader className="pb-3">
								<div className="flex items-center justify-between">
									<CardTitle className="text-sm font-semibold">
										<Trans>Element Inspector</Trans>:{' '}
										{selectedElement.label || selectedElement.kind}
									</CardTitle>
									{canWrite ? (
										<Button
											type="button"
											variant="destructive"
											size="sm"
											onClick={handleDeleteSelectedElement}
											data-testid="floor-inspector-delete-element"
										>
											<Icon name="trash-2" className="size-3.5" />
											<Trans>Remove</Trans>
										</Button>
									) : null}
								</div>
							</CardHeader>
							<CardContent className="flex flex-col gap-3">
								<div className="flex flex-col gap-1">
									<Label htmlFor="inspector-element-label">
										<Trans>Element label</Trans>
									</Label>
									<Input
										id="inspector-element-label"
										disabled={!canWrite}
										value={selectedElement.label ?? ''}
										onChange={(e) =>
											updateDraftElement(selectedElement.id, {
												label: e.target.value,
											})
										}
									/>
								</div>

								<div className="grid grid-cols-2 gap-2">
									<div className="flex flex-col gap-1">
										<Label htmlFor="inspector-el-x">
											<Trans>X (0–1200)</Trans>
										</Label>
										<Input
											id="inspector-el-x"
											type="number"
											min={0}
											max={1200}
											disabled={!canWrite}
											value={selectedElement.x}
											onChange={(e) =>
												updateDraftElement(selectedElement.id, {
													x: clampCanvasCoord(Number(e.target.value)),
												})
											}
										/>
									</div>
									<div className="flex flex-col gap-1">
										<Label htmlFor="inspector-el-y">
											<Trans>Y (0–1200)</Trans>
										</Label>
										<Input
											id="inspector-el-y"
											type="number"
											min={0}
											max={1200}
											disabled={!canWrite}
											value={selectedElement.y}
											onChange={(e) =>
												updateDraftElement(selectedElement.id, {
													y: clampCanvasCoord(Number(e.target.value)),
												})
											}
										/>
									</div>
								</div>

								<div className="grid grid-cols-2 gap-2">
									<div className="flex flex-col gap-1">
										<Label htmlFor="inspector-el-width">
											<Trans>Width</Trans>
										</Label>
										<Input
											id="inspector-el-width"
											type="number"
											min={20}
											max={600}
											disabled={!canWrite}
											value={selectedElement.width}
											onChange={(e) =>
												updateDraftElement(selectedElement.id, {
													width: clampCanvasDimension(Number(e.target.value)),
												})
											}
										/>
									</div>
									<div className="flex flex-col gap-1">
										<Label htmlFor="inspector-el-height">
											<Trans>Height</Trans>
										</Label>
										<Input
											id="inspector-el-height"
											type="number"
											min={20}
											max={600}
											disabled={!canWrite}
											value={selectedElement.height}
											onChange={(e) =>
												updateDraftElement(selectedElement.id, {
													height: clampCanvasDimension(Number(e.target.value)),
												})
											}
										/>
									</div>
								</div>

								<div className="flex flex-col gap-1.5">
									<Label>
										<Trans>Rotation</Trans>
									</Label>
									<div className="flex items-center gap-1.5">
										{ROTATION_PRESETS.map((deg) => (
											<Button
												key={deg}
												type="button"
												size="sm"
												variant={
													selectedElement.rotation === deg
														? 'default'
														: 'outline'
												}
												disabled={!canWrite}
												onClick={() =>
													updateDraftElement(selectedElement.id, {
														rotation: deg,
													})
												}
											>
												{deg}°
											</Button>
										))}
									</div>
								</div>
							</CardContent>
						</Card>
					) : (
						<div className="text-muted-foreground flex flex-col gap-2 py-8 text-center text-sm">
							<p className="text-foreground font-medium">
								<Trans>No item selected</Trans>
							</p>
							<p className="text-xs">
								<Trans>
									Click a table or decor element on the canvas to inspect,
									resize, rotate, or nudge it with the keyboard.
								</Trans>
							</p>
						</div>
					)}
				</div>
			</div>
		</div>
	)
}
