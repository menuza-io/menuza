import { type MessageDescriptor } from '@lingui/core'
import { Plural, Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { cn } from '@repo/ui'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import {
	Frame,
	FrameAction,
	FrameDescription,
	FrameHeader,
	FrameTitle,
} from '@repo/ui/frame'
import { Icon } from '@repo/ui/icon'
import { Skeleton } from '@repo/ui/skeleton'
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '@repo/ui/table'
import {
	type FormEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useState,
} from 'react'
import { Link, useSearchParams } from 'react-router'
import { EmptyState } from '#app/components/empty-state.tsx'
import {
	ConfirmDialog,
	EditSheet,
	SetupNotices,
} from '#app/components/reservations/settings/setup-list-chrome.tsx'
import { SelectField, TextField } from '#app/components/staff/controls.tsx'
import { SheetForm } from '#app/components/staff/sheet-frame.tsx'
import { SwitchField } from '#app/components/staff/switch-field.tsx'
import { requireReservationsAccess } from '#app/utils/reservations/access.server.ts'
import { RESERVATIONS_SECTION_REQUIREMENTS } from '#app/utils/reservations/sections.ts'
import {
	createArea,
	createCombination,
	createTable,
	deleteArea,
	deleteCombination,
	deleteTable,
	type DiningAreaDto,
	extractApiErrorMessage,
	fetchAreas,
	fetchCombinations,
	fetchTables,
	isVersionConflictError,
	type ReflowedMoveDto,
	type SetupConflictDto,
	type TableCombinationDto,
	type TableDto,
	type TableShape,
	updateArea,
	updateTable,
} from '#app/utils/reservations/setup-api.ts'
import { type Route } from './+types/settings.tables.ts'
import { useReservationsSetupContext } from './settings.tsx'

export async function loader({ request, params }: Route.LoaderArgs) {
	await requireReservationsAccess(
		request,
		params.orgSlug,
		RESERVATIONS_SECTION_REQUIREMENTS.settings,
	)
	return null
}

const SHAPE_OPTIONS: ReadonlyArray<{
	value: TableShape
	label: MessageDescriptor
}> = [
	{ value: 'round', label: msg`Round` },
	{ value: 'square', label: msg`Square` },
	{ value: 'rect', label: msg`Rectangle` },
	{ value: 'booth', label: msg`Booth` },
	{ value: 'bar', label: msg`Bar` },
	{ value: 'high_top', label: msg`High-top` },
]

type SheetState =
	| { kind: 'closed' }
	| { kind: 'area'; areaId: string | null }
	| { kind: 'table'; tableId: string | null }
	| { kind: 'combo' }

type PendingConfirm =
	| { kind: 'area'; area: DiningAreaDto }
	| { kind: 'table'; table: TableDto }
	| { kind: 'combo'; combo: TableCombinationDto }

export default function ReservationsSettingsTablesRoute() {
	const { _ } = useLingui()
	const coversLabel = (minCovers: number, maxCovers: number) =>
		_(msg`${minCovers}–${maxCovers} covers`)
	const shapeLabel = (shape: string) => {
		const option = SHAPE_OPTIONS.find((s) => s.value === shape)
		return option ? _(option.label) : shape
	}
	const { orgSlug, selectedLocationId, canWrite, client, refreshSummary } =
		useReservationsSetupContext()
	const [searchParams] = useSearchParams()

	const [areas, setAreas] = useState<DiningAreaDto[]>([])
	const [tables, setTables] = useState<TableDto[]>([])
	const [combos, setCombos] = useState<TableCombinationDto[]>([])
	const [loading, setLoading] = useState(true)
	const [saving, setSaving] = useState(false)
	const [errorMessage, setErrorMessage] = useState<string | null>(null)
	const [conflictBanner, setConflictBanner] = useState<string | null>(null)
	const [feedbackMessage, setFeedbackMessage] = useState<string | null>(null)
	const [mutationConflicts, setMutationConflicts] = useState<
		SetupConflictDto[]
	>([])
	const [mutationReflows, setMutationReflows] = useState<ReflowedMoveDto[]>([])

	const [sheet, setSheet] = useState<SheetState>({ kind: 'closed' })
	const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(
		null,
	)
	const [fieldError, setFieldError] = useState<string | null>(null)

	// Area form
	const [areaName, setAreaName] = useState('')
	const [areaNameAr, setAreaNameAr] = useState('')
	const [areaFloorLabel, setAreaFloorLabel] = useState('')
	const [areaOutdoor, setAreaOutdoor] = useState(false)
	const [areaOnline, setAreaOnline] = useState(true)

	// Table form
	const [tableAreaId, setTableAreaId] = useState('')
	const [tableLabel, setTableLabel] = useState('')
	const [tableMinCovers, setTableMinCovers] = useState(2)
	const [tableMaxCovers, setTableMaxCovers] = useState(4)
	const [tableShape, setTableShape] = useState<TableShape>('square')
	const [tableCombinable, setTableCombinable] = useState(true)
	const [tableOnline, setTableOnline] = useState(true)

	// Combination form
	const [comboName, setComboName] = useState('')
	const [comboMinCovers, setComboMinCovers] = useState(4)
	const [comboMaxCovers, setComboMaxCovers] = useState(8)
	const [comboTableIds, setComboTableIds] = useState<string[]>([])

	const loadAll = useCallback(async () => {
		if (!selectedLocationId) {
			setLoading(false)
			return
		}
		setLoading(true)
		setErrorMessage(null)
		try {
			const [areasRes, tablesRes, combosRes] = await Promise.all([
				fetchAreas(client, selectedLocationId),
				fetchTables(client, selectedLocationId),
				fetchCombinations(client, selectedLocationId),
			])
			const activeAreas = (areasRes.areas ?? []).filter(
				(a) => a.isActive && !a.archivedAt,
			)
			const activeTables = (tablesRes.tables ?? []).filter(
				(t) => t.isActive && !t.archivedAt,
			)
			setAreas(activeAreas)
			setTables(activeTables)
			setCombos(combosRes.combos ?? [])
		} catch (err) {
			setErrorMessage(
				extractApiErrorMessage(
					err,
					_(msg`Failed to load areas, tables, and combinations.`),
				),
			)
		} finally {
			setLoading(false)
		}
	}, [client, selectedLocationId, _])

	useEffect(() => {
		void loadAll()
	}, [loadAll])

	const recordMutationSideEffects = (res?: {
		conflicts?: SetupConflictDto[]
		reflowedMoves?: ReflowedMoveDto[]
	}) => {
		if (res?.conflicts) setMutationConflicts(res.conflicts)
		if (res?.reflowedMoves) setMutationReflows(res.reflowedMoves)
	}

	const refreshAll = async () => {
		await Promise.all([loadAll(), refreshSummary()])
	}

	const closeSheet = () => {
		setSheet({ kind: 'closed' })
		setFieldError(null)
		setErrorMessage(null)
		setConflictBanner(null)
	}

	const startNotices = () => {
		setErrorMessage(null)
		setConflictBanner(null)
		setFeedbackMessage(null)
		setFieldError(null)
	}

	const openArea = (area: DiningAreaDto | null) => {
		startNotices()
		setAreaName(area?.name ?? '')
		setAreaNameAr(area?.nameI18n?.ar ?? '')
		setAreaFloorLabel(area?.floorLabel ?? '')
		setAreaOutdoor(area?.isOutdoor ?? false)
		setAreaOnline(area?.isBookableOnline ?? true)
		setSheet({ kind: 'area', areaId: area?.id ?? null })
	}

	const openTable = (table: TableDto | null) => {
		startNotices()
		setTableAreaId(table?.areaId ?? areas[0]?.id ?? '')
		setTableLabel(table?.label ?? '')
		setTableMinCovers(table?.minCovers ?? 2)
		setTableMaxCovers(table?.maxCovers ?? 4)
		setTableShape(table?.shape ?? 'square')
		setTableCombinable(table?.combinable ?? true)
		setTableOnline(table?.isBookableOnline ?? true)
		setSheet({ kind: 'table', tableId: table?.id ?? null })
	}

	const openCombo = () => {
		startNotices()
		setComboName('')
		setComboMinCovers(4)
		setComboMaxCovers(8)
		setComboTableIds([])
		setSheet({ kind: 'combo' })
	}

	const handleSubmitArea = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault()
		if (!canWrite || !selectedLocationId || sheet.kind !== 'area' || saving)
			return
		startNotices()
		const name = areaName.trim()
		if (!name) {
			setFieldError(_(msg`Enter a name for the dining area.`))
			return
		}
		const editing = sheet.areaId
			? areas.find((a) => a.id === sheet.areaId)
			: null
		setSaving(true)
		try {
			const nameAr = areaNameAr.trim()
			if (editing) {
				const nameI18n = { ...editing.nameI18n, en: name }
				if (nameAr) nameI18n.ar = nameAr
				else delete nameI18n.ar
				const res = await updateArea(client, selectedLocationId, editing.id, {
					expectedVersion: editing.version,
					name,
					nameI18n,
					floorLabel: areaFloorLabel.trim() || null,
					isOutdoor: areaOutdoor,
					isBookableOnline: areaOnline,
				})
				recordMutationSideEffects(res)
				setFeedbackMessage(_(msg`Dining area updated.`))
			} else {
				await createArea(client, selectedLocationId, {
					name,
					nameI18n: { en: name, ...(nameAr ? { ar: nameAr } : {}) },
					floorLabel: areaFloorLabel.trim() || null,
					sortOrder: areas.length,
					isOutdoor: areaOutdoor,
					isBookableOnline: areaOnline,
				})
				setFeedbackMessage(_(msg`Dining area created.`))
			}
			setSheet({ kind: 'closed' })
			await refreshAll()
		} catch (err) {
			if (isVersionConflictError(err)) {
				setConflictBanner(
					_(
						msg`Someone else changed this dining area. Reload to see the latest version, then make your change again.`,
					),
				)
			} else {
				setErrorMessage(
					extractApiErrorMessage(
						err,
						editing
							? _(msg`Failed to update dining area.`)
							: _(msg`Failed to create dining area.`),
					),
				)
			}
		} finally {
			setSaving(false)
		}
	}

	const handleMoveArea = async (area: DiningAreaDto, direction: -1 | 1) => {
		if (!canWrite || !selectedLocationId) return
		const sorted = areas.slice().sort((a, b) => a.sortOrder - b.sortOrder)
		const idx = sorted.findIndex((a) => a.id === area.id)
		const targetIdx = idx + direction
		if (idx < 0 || targetIdx < 0 || targetIdx >= sorted.length) return
		const neighbor = sorted[targetIdx]!

		try {
			await Promise.all([
				updateArea(client, selectedLocationId, area.id, {
					expectedVersion: area.version,
					sortOrder: neighbor.sortOrder,
				}),
				updateArea(client, selectedLocationId, neighbor.id, {
					expectedVersion: neighbor.version,
					sortOrder: area.sortOrder,
				}),
			])
			await loadAll()
		} catch (err) {
			setErrorMessage(
				extractApiErrorMessage(err, _(msg`Failed to reorder dining areas.`)),
			)
		}
	}

	const handleSubmitTable = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault()
		if (!canWrite || !selectedLocationId || sheet.kind !== 'table' || saving)
			return
		startNotices()

		const editing = sheet.tableId
			? tables.find((t) => t.id === sheet.tableId)
			: null
		const targetAreaId = tableAreaId || areas[0]?.id || ''
		if (!targetAreaId) {
			setErrorMessage(_(msg`Create a dining area before adding tables.`))
			return
		}
		if (!tableLabel.trim()) {
			setFieldError(_(msg`Table label is required.`))
			return
		}
		if (tableMinCovers > tableMaxCovers) {
			setErrorMessage(_(msg`Minimum covers cannot exceed maximum covers.`))
			return
		}

		setSaving(true)
		try {
			if (editing) {
				const res = await updateTable(client, selectedLocationId, editing.id, {
					expectedVersion: editing.version,
					label: tableLabel.trim() || editing.label,
					minCovers: tableMinCovers,
					maxCovers: tableMaxCovers,
					...(targetAreaId !== editing.areaId ? { areaId: targetAreaId } : {}),
					...(tableShape !== editing.shape ? { shape: tableShape } : {}),
					...(tableCombinable !== editing.combinable
						? { combinable: tableCombinable }
						: {}),
					...(tableOnline !== editing.isBookableOnline
						? { isBookableOnline: tableOnline }
						: {}),
				})
				recordMutationSideEffects(res)
				const updatedTableLabel = res.table.label
				setFeedbackMessage(_(msg`Table ${updatedTableLabel} updated.`))
			} else {
				const res = await createTable(client, selectedLocationId, {
					areaId: targetAreaId,
					label: tableLabel.trim(),
					minCovers: tableMinCovers,
					maxCovers: tableMaxCovers,
					shape: tableShape,
					combinable: tableCombinable,
					isBookableOnline: tableOnline,
					x: 80 + (tables.length % 8) * 60,
					y: 80 + Math.floor(tables.length / 8) * 80,
					width: 70,
					height: 70,
				})
				recordMutationSideEffects(res)
				const createdTableLabel = res.table.label
				setFeedbackMessage(_(msg`Table ${createdTableLabel} created.`))
			}
			setSheet({ kind: 'closed' })
			await refreshAll()
		} catch (err) {
			if (isVersionConflictError(err)) {
				setConflictBanner(
					_(
						msg`Someone else changed this table. Reload to see the latest version, then make your change again.`,
					),
				)
			} else {
				setErrorMessage(
					extractApiErrorMessage(
						err,
						editing
							? _(msg`Failed to update table.`)
							: _(msg`Failed to create table.`),
					),
				)
			}
		} finally {
			setSaving(false)
		}
	}

	const handleToggleComboTable = (tableId: string) => {
		setComboTableIds((prev) =>
			prev.includes(tableId)
				? prev.filter((id) => id !== tableId)
				: [...prev, tableId],
		)
	}

	const handleSubmitCombo = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault()
		if (!canWrite || !selectedLocationId || saving) return
		startNotices()

		if (!comboName.trim()) {
			setFieldError(_(msg`Combination name is required.`))
			return
		}
		if (comboTableIds.length < 2) {
			setErrorMessage(
				_(msg`Select at least 2 combinable tables to create a combination.`),
			)
			return
		}
		if (comboMinCovers > comboMaxCovers) {
			setErrorMessage(_(msg`Minimum covers cannot exceed maximum covers.`))
			return
		}

		setSaving(true)
		try {
			const res = await createCombination(client, selectedLocationId, {
				name: comboName.trim(),
				minCovers: comboMinCovers,
				maxCovers: comboMaxCovers,
				tableIds: comboTableIds,
				isBookableOnline: true,
			})
			recordMutationSideEffects(res)
			setFeedbackMessage(_(msg`Table combination created.`))
			setSheet({ kind: 'closed' })
			await refreshAll()
		} catch (err) {
			setErrorMessage(
				extractApiErrorMessage(
					err,
					_(msg`Failed to create table combination.`),
				),
			)
		} finally {
			setSaving(false)
		}
	}

	const handleConfirm = async () => {
		const pending = pendingConfirm
		if (!pending || !canWrite || !selectedLocationId || saving) return
		setErrorMessage(null)
		setSaving(true)
		try {
			if (pending.kind === 'area') {
				const res = await deleteArea(
					client,
					selectedLocationId,
					pending.area.id,
				)
				recordMutationSideEffects(res)
				setFeedbackMessage(_(msg`Dining area archived.`))
			} else if (pending.kind === 'table') {
				const res = await deleteTable(
					client,
					selectedLocationId,
					pending.table.id,
				)
				recordMutationSideEffects(res)
				setFeedbackMessage(_(msg`Table archived.`))
			} else {
				const res = await deleteCombination(
					client,
					selectedLocationId,
					pending.combo.id,
				)
				recordMutationSideEffects(res)
				setFeedbackMessage(_(msg`Table combination deleted.`))
			}
			await refreshAll()
		} catch (err) {
			setErrorMessage(
				extractApiErrorMessage(
					err,
					pending.kind === 'area'
						? _(msg`Failed to archive dining area.`)
						: pending.kind === 'table'
							? _(msg`Failed to archive table.`)
							: _(msg`Failed to delete table combination.`),
				),
			)
		} finally {
			setSaving(false)
			setPendingConfirm(null)
		}
	}

	const combinableTables = tables.filter((t) => t.combinable && t.isActive)
	const searchSuffix = searchParams.toString()
		? `?${searchParams.toString()}`
		: ''
	const areaOptions = areas.map((a) => ({ value: a.id, label: a.name }))
	const shapeOptions = SHAPE_OPTIONS.map((s) => ({
		value: s.value,
		label: _(s.label),
	}))

	const sheetOpen = sheet.kind !== 'closed'
	// While a sheet is open it covers the page, so errors show inside it.
	const sheetNotices = (
		<SetupNotices
			errorMessage={sheetOpen ? errorMessage : null}
			errorTestId="setup-tables-error-banner"
			conflictMessage={sheetOpen ? conflictBanner : null}
			conflictTestId="setup-tables-conflict-banner"
			onReload={() => {
				closeSheet()
				void loadAll()
			}}
		/>
	)

	const archiveCopy = (() => {
		if (!pendingConfirm) return null
		if (pendingConfirm.kind === 'area') {
			const areaLabel = pendingConfirm.area.name
			return {
				title: _(msg`Archive ${areaLabel}?`),
				description: _(
					msg`The area and its tables disappear from the floor and from online booking. Upcoming reservations are moved to other tables where possible, or flagged for you to review.`,
				),
				confirm: _(msg`Archive`),
			}
		}
		if (pendingConfirm.kind === 'table') {
			const tableName = pendingConfirm.table.label
			return {
				title: _(msg`Archive table ${tableName}?`),
				description: _(
					msg`The table disappears from the floor and from booking. Upcoming reservations on it are moved to other tables where possible, or flagged for you to review.`,
				),
				confirm: _(msg`Archive`),
			}
		}
		const comboLabel = pendingConfirm.combo.name
		return {
			title: _(msg`Delete combination ${comboLabel}?`),
			description: _(
				msg`The tables stay as they are. Parties will no longer be seated on this combination.`,
			),
			confirm: _(msg`Delete`),
		}
	})()

	return (
		<div className="flex flex-col gap-6" data-testid="setup-tables-page">
			<SetupNotices
				conflictMessage={sheetOpen ? null : conflictBanner}
				conflictTestId="setup-tables-conflict-banner"
				onReload={() => {
					setConflictBanner(null)
					void loadAll()
				}}
				errorMessage={sheetOpen ? null : errorMessage}
				errorTestId="setup-tables-error-banner"
				onDismissError={() => setErrorMessage(null)}
				feedbackMessage={feedbackMessage}
				feedbackTestId="setup-tables-feedback-banner"
				onDismissFeedback={() => setFeedbackMessage(null)}
			/>

			{mutationReflows.length > 0 || mutationConflicts.length > 0 ? (
				<div
					className="bg-muted/40 flex flex-col gap-1 rounded-lg border px-3 py-2 text-sm"
					data-testid="setup-tables-reflow-banner"
				>
					{mutationReflows.length > 0 ? (
						<span className="text-success">
							<Plural
								value={mutationReflows.length}
								one="# upcoming reservation was moved to another table after your change"
								other="# upcoming reservations were moved to other tables after your change"
							/>
						</span>
					) : null}
					{mutationConflicts.length > 0 ? (
						<span className="text-warning">
							<Plural
								value={mutationConflicts.length}
								one="# upcoming reservation needs your review after your change"
								other="# upcoming reservations need your review after your change"
							/>
						</span>
					) : null}
				</div>
			) : null}

			{/* Dining areas */}
			<Frame className="w-full" data-testid="setup-areas-card">
				<FrameHeader>
					<FrameTitle className="font-medium">
						<Trans>Dining areas</Trans>
					</FrameTitle>
					<FrameDescription>
						<Trans>
							Group tables by room, patio, bar or floor. Guests can pick an area
							when it is open for online booking.
						</Trans>
					</FrameDescription>
					<FrameAction>
						<div className="flex flex-wrap items-center gap-1.5">
							<Button
								variant="outline"
								size="sm"
								render={
									<Link
										to={`/${orgSlug}/reservations/settings/floor-plan${searchSuffix}`}
									/>
								}
								data-testid="setup-open-floor-plan-link"
							>
								<Icon name="layout-grid" className="size-4" />
								<Trans>Floor plan designer</Trans>
							</Button>
							{canWrite ? (
								<Button
									type="button"
									variant="outline"
									size="sm"
									onClick={() => openArea(null)}
									data-testid="setup-open-add-area"
								>
									<Icon name="plus" className="size-4" />
									<Trans>Add area</Trans>
								</Button>
							) : null}
						</div>
					</FrameAction>
				</FrameHeader>

				{loading ? (
					<ListSkeleton />
				) : areas.length === 0 ? (
					<div className="border-t p-4" data-testid="setup-areas-empty">
						<EmptyState
							icons={['layout-grid']}
							title={<Trans>No dining areas yet</Trans>}
							description={
								<Trans>
									Add an area such as Main dining or Patio to start.
								</Trans>
							}
						>
							{canWrite ? (
								<Button type="button" size="sm" onClick={() => openArea(null)}>
									<Icon name="plus" className="size-4" />
									<Trans>Add area</Trans>
								</Button>
							) : null}
						</EmptyState>
					</div>
				) : (
					<Table variant="card">
						<TableHeader>
							<TableRow>
								<TableHead>
									<Trans>Name</Trans>
								</TableHead>
								<TableHead>
									<Trans>Floor</Trans>
								</TableHead>
								<TableHead>
									<Trans>Booking</Trans>
								</TableHead>
								<TableHead className="text-end">
									<span className="sr-only">
										<Trans>Actions</Trans>
									</span>
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{areas.map((area, index) => (
								<TableRow
									key={area.id}
									data-testid={`setup-area-row-${area.name}`}
									className={canWrite ? 'cursor-pointer' : undefined}
									onClick={canWrite ? () => openArea(area) : undefined}
								>
									<TableCell className="font-medium">
										<div className="flex flex-wrap items-center gap-x-2">
											<span className="wrap-anywhere">{area.name}</span>
											{area.nameI18n?.ar ? (
												<span
													className="text-muted-foreground text-xs"
													dir="rtl"
												>
													{area.nameI18n.ar}
												</span>
											) : null}
										</div>
									</TableCell>
									<TableCell className="text-muted-foreground">
										{[area.floorLabel, area.isOutdoor ? _(msg`Outdoor`) : null]
											.filter(Boolean)
											.join(' · ') || '—'}
									</TableCell>
									<TableCell>
										{area.isBookableOnline ? (
											<span className="text-muted-foreground text-sm">
												<Trans>Online</Trans>
											</span>
										) : (
											<Badge variant="secondary">
												<Trans>In-house only</Trans>
											</Badge>
										)}
									</TableCell>
									<TableCell className="text-end">
										{canWrite ? (
											<div className="flex items-center justify-end gap-1">
												<Button
													type="button"
													variant="ghost"
													size="icon-sm"
													disabled={index === 0}
													onClick={(event) => {
														event.stopPropagation()
														void handleMoveArea(area, -1)
													}}
													aria-label={_(msg`Move area up`)}
												>
													<Icon name="chevron-up" className="size-4" />
												</Button>
												<Button
													type="button"
													variant="ghost"
													size="icon-sm"
													disabled={index === areas.length - 1}
													onClick={(event) => {
														event.stopPropagation()
														void handleMoveArea(area, 1)
													}}
													aria-label={_(msg`Move area down`)}
												>
													<Icon name="chevron-down" className="size-4" />
												</Button>
												<Button
													type="button"
													variant="ghost"
													size="sm"
													onClick={(event) => {
														event.stopPropagation()
														openArea(area)
													}}
													data-testid={`setup-edit-area-${area.name}`}
												>
													<Trans>Edit</Trans>
												</Button>
												<Button
													type="button"
													variant="ghost"
													size="icon-sm"
													onClick={(event) => {
														event.stopPropagation()
														setPendingConfirm({ kind: 'area', area })
													}}
													aria-label={_(msg`Archive area`)}
													data-testid={`setup-archive-area-${area.name}`}
												>
													<Icon name="trash-2" className="size-4" />
												</Button>
											</div>
										) : (
											<span className="text-muted-foreground text-xs">
												<Trans>Read-only</Trans>
											</span>
										)}
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				)}
			</Frame>

			{/* Tables */}
			<Frame className="w-full" data-testid="setup-tables-card">
				<FrameHeader>
					<FrameTitle className="font-medium">
						<Trans>Tables</Trans>
					</FrameTitle>
					<FrameDescription>
						<Trans>
							Each table has a seating range and can be open to online booking.
							Labels are unique within a location.
						</Trans>
					</FrameDescription>
					{canWrite ? (
						<FrameAction>
							<Button
								type="button"
								size="sm"
								disabled={areas.length === 0}
								onClick={() => openTable(null)}
								data-testid="setup-open-add-table"
							>
								<Icon name="plus" className="size-4" />
								<Trans>Add table</Trans>
							</Button>
						</FrameAction>
					) : null}
				</FrameHeader>

				{loading ? (
					<ListSkeleton />
				) : tables.length === 0 ? (
					<div className="border-t p-4" data-testid="setup-tables-empty">
						<EmptyState
							icons={['square']}
							title={<Trans>No tables yet</Trans>}
							description={
								areas.length === 0 ? (
									<Trans>Add a dining area first, then add its tables.</Trans>
								) : (
									<Trans>Add your first table to start taking bookings.</Trans>
								)
							}
						>
							{canWrite && areas.length > 0 ? (
								<Button type="button" size="sm" onClick={() => openTable(null)}>
									<Icon name="plus" className="size-4" />
									<Trans>Add table</Trans>
								</Button>
							) : null}
						</EmptyState>
					</div>
				) : (
					<Table variant="card">
						<TableHeader>
							<TableRow>
								<TableHead>
									<Trans>Table</Trans>
								</TableHead>
								<TableHead>
									<Trans>Area</Trans>
								</TableHead>
								<TableHead>
									<Trans>Seats</Trans>
								</TableHead>
								<TableHead>
									<Trans>Shape</Trans>
								</TableHead>
								<TableHead>
									<Trans>Booking</Trans>
								</TableHead>
								<TableHead className="text-end">
									<span className="sr-only">
										<Trans>Actions</Trans>
									</span>
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{tables.map((table) => {
								const areaNameForTable =
									areas.find((a) => a.id === table.areaId)?.name ?? '—'
								return (
									<TableRow
										key={table.id}
										data-testid={`setup-table-row-${table.label}`}
										className={canWrite ? 'cursor-pointer' : undefined}
										onClick={canWrite ? () => openTable(table) : undefined}
									>
										<TableCell className="font-semibold wrap-anywhere">
											{table.label}
										</TableCell>
										<TableCell className="text-muted-foreground">
											{areaNameForTable}
										</TableCell>
										<TableCell className="tabular-nums">
											{coversLabel(table.minCovers, table.maxCovers)}
										</TableCell>
										<TableCell className="text-muted-foreground">
											{shapeLabel(table.shape)}
										</TableCell>
										<TableCell>
											{table.isBookableOnline ? (
												<span className="text-muted-foreground text-sm">
													<Trans>Online</Trans>
												</span>
											) : (
												<Badge variant="secondary">
													<Trans>Staff only</Trans>
												</Badge>
											)}
										</TableCell>
										<TableCell className="text-end">
											{canWrite ? (
												<div className="flex items-center justify-end gap-1">
													<Button
														type="button"
														variant="ghost"
														size="sm"
														onClick={(event) => {
															event.stopPropagation()
															openTable(table)
														}}
														data-testid={`setup-edit-table-${table.label}`}
													>
														<Trans>Edit</Trans>
													</Button>
													<Button
														type="button"
														variant="ghost"
														size="icon-sm"
														onClick={(event) => {
															event.stopPropagation()
															setPendingConfirm({ kind: 'table', table })
														}}
														aria-label={_(msg`Archive table`)}
														data-testid={`setup-archive-table-${table.label}`}
													>
														<Icon name="trash-2" className="size-4" />
													</Button>
												</div>
											) : (
												<span className="text-muted-foreground text-xs">
													<Trans>Read-only</Trans>
												</span>
											)}
										</TableCell>
									</TableRow>
								)
							})}
						</TableBody>
					</Table>
				)}
			</Frame>

			{/* Combinations */}
			<Frame className="w-full" data-testid="setup-combos-card">
				<FrameHeader>
					<FrameTitle className="font-medium">
						<Trans>Table combinations</Trans>
					</FrameTitle>
					<FrameDescription>
						<Trans>
							Push two or more combinable tables together to seat larger
							parties. The same set of tables can only be saved once.
						</Trans>
					</FrameDescription>
					{canWrite ? (
						<FrameAction>
							<Button
								type="button"
								variant="outline"
								size="sm"
								disabled={combinableTables.length < 2}
								onClick={openCombo}
								data-testid="setup-open-add-combo"
							>
								<Icon name="plus" className="size-4" />
								<Trans>Add combination</Trans>
							</Button>
						</FrameAction>
					) : null}
				</FrameHeader>

				{loading ? (
					<ListSkeleton />
				) : combos.length === 0 ? (
					<div className="border-t p-4" data-testid="setup-combos-empty">
						<EmptyState
							icons={['users']}
							title={<Trans>No combinations yet</Trans>}
							description={
								combinableTables.length < 2 ? (
									<Trans>
										Mark at least two tables as combinable to create one.
									</Trans>
								) : (
									<Trans>
										Combine tables so hosts can seat larger groups together.
									</Trans>
								)
							}
						/>
					</div>
				) : (
					<Table variant="card">
						<TableHeader>
							<TableRow>
								<TableHead>
									<Trans>Combination</Trans>
								</TableHead>
								<TableHead>
									<Trans>Tables</Trans>
								</TableHead>
								<TableHead>
									<Trans>Seats</Trans>
								</TableHead>
								<TableHead className="text-end">
									<span className="sr-only">
										<Trans>Actions</Trans>
									</span>
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{combos.map((combo) => {
								const memberLabels = combo.tableIds
									.map((id) => tables.find((t) => t.id === id)?.label ?? id)
									.join(' + ')
								return (
									<TableRow
										key={combo.id}
										data-testid={`setup-combo-row-${combo.name}`}
									>
										<TableCell className="font-medium wrap-anywhere">
											{combo.name}
										</TableCell>
										<TableCell className="text-muted-foreground">
											{memberLabels}
										</TableCell>
										<TableCell className="tabular-nums">
											{coversLabel(combo.minCovers, combo.maxCovers)}
										</TableCell>
										<TableCell className="text-end">
											{canWrite ? (
												<Button
													type="button"
													variant="ghost"
													size="icon-sm"
													onClick={() =>
														setPendingConfirm({ kind: 'combo', combo })
													}
													aria-label={_(msg`Delete combination`)}
													data-testid={`setup-delete-combo-${combo.name}`}
												>
													<Icon name="trash-2" className="size-4" />
												</Button>
											) : (
												<span className="text-muted-foreground text-xs">
													<Trans>Read-only</Trans>
												</span>
											)}
										</TableCell>
									</TableRow>
								)
							})}
						</TableBody>
					</Table>
				)}
			</Frame>

			{/* Area sheet */}
			<EditSheet open={sheet.kind === 'area'} onClose={closeSheet}>
				<SheetForm
					title={
						sheet.kind === 'area' && sheet.areaId ? (
							<Trans>Edit dining area</Trans>
						) : (
							<Trans>New dining area</Trans>
						)
					}
					onSubmit={(event) => void handleSubmitArea(event)}
					footer={
						<SheetFooterButtons
							saving={saving}
							onCancel={closeSheet}
							submitTestId={
								sheet.kind === 'area' && sheet.areaId
									? 'setup-save-area-edit-button'
									: 'setup-add-area-button'
							}
							createLabel={<Trans>Add area</Trans>}
							isEdit={sheet.kind === 'area' && Boolean(sheet.areaId)}
						/>
					}
				>
					{sheetNotices}
					<div
						className="flex flex-col gap-5"
						data-testid="setup-create-area-form"
					>
						<TextField
							label={<Trans>Name</Trans>}
							placeholder={_(msg`e.g. Main dining`)}
							value={areaName}
							error={fieldError}
							onChange={(e) => setAreaName(e.target.value)}
							data-testid={
								sheet.kind === 'area' && sheet.areaId
									? 'setup-edit-area-name-input'
									: 'setup-area-name-input'
							}
						/>
						<TextField
							label={<Trans>Name in Arabic</Trans>}
							optional
							dir="rtl"
							placeholder={_(msg`Arabic area name`)}
							value={areaNameAr}
							onChange={(e) => setAreaNameAr(e.target.value)}
							data-testid="setup-area-name-ar-input"
						/>
						<TextField
							label={<Trans>Floor</Trans>}
							optional
							placeholder={_(msg`e.g. Ground floor`)}
							value={areaFloorLabel}
							onChange={(e) => setAreaFloorLabel(e.target.value)}
						/>
						<SwitchField
							label={<Trans>Outdoor</Trans>}
							description={<Trans>A patio, terrace or garden.</Trans>}
							checked={areaOutdoor}
							onCheckedChange={setAreaOutdoor}
						/>
						<SwitchField
							label={<Trans>Open for online booking</Trans>}
							description={
								<Trans>Guests can choose this area when they book.</Trans>
							}
							checked={areaOnline}
							onCheckedChange={setAreaOnline}
						/>
					</div>
				</SheetForm>
			</EditSheet>

			{/* Table sheet */}
			<EditSheet open={sheet.kind === 'table'} onClose={closeSheet}>
				<SheetForm
					title={
						sheet.kind === 'table' && sheet.tableId ? (
							<Trans>Edit table</Trans>
						) : (
							<Trans>New table</Trans>
						)
					}
					onSubmit={(event) => void handleSubmitTable(event)}
					footer={
						<SheetFooterButtons
							saving={saving}
							onCancel={closeSheet}
							submitTestId={
								sheet.kind === 'table' && sheet.tableId
									? 'setup-save-table-edit-button'
									: 'setup-add-table-button'
							}
							createLabel={<Trans>Add table</Trans>}
							isEdit={sheet.kind === 'table' && Boolean(sheet.tableId)}
						/>
					}
				>
					{sheetNotices}
					<div
						className="flex flex-col gap-5"
						data-testid="setup-create-table-form"
					>
						<TextField
							label={<Trans>Table label</Trans>}
							placeholder={_(msg`e.g. T15`)}
							value={tableLabel}
							error={fieldError}
							onChange={(e) => setTableLabel(e.target.value)}
							data-testid={
								sheet.kind === 'table' && sheet.tableId
									? 'setup-edit-table-label-input'
									: 'setup-table-label-input'
							}
						/>
						<SelectField
							label={<Trans>Area</Trans>}
							options={areaOptions}
							value={tableAreaId || areas[0]?.id || ''}
							onValueChange={setTableAreaId}
						/>
						<div className="grid grid-cols-2 gap-4">
							<TextField
								label={<Trans>Fewest guests</Trans>}
								type="number"
								min={1}
								max={99}
								value={tableMinCovers}
								onChange={(e) => setTableMinCovers(Number(e.target.value) || 1)}
								data-testid={
									sheet.kind === 'table' && sheet.tableId
										? 'setup-edit-table-min-input'
										: 'setup-table-min-covers-input'
								}
							/>
							<TextField
								label={<Trans>Most guests</Trans>}
								type="number"
								min={1}
								max={99}
								value={tableMaxCovers}
								onChange={(e) => setTableMaxCovers(Number(e.target.value) || 2)}
								data-testid={
									sheet.kind === 'table' && sheet.tableId
										? 'setup-edit-table-max-input'
										: 'setup-table-max-covers-input'
								}
							/>
						</div>
						<SelectField
							label={<Trans>Shape</Trans>}
							options={shapeOptions}
							value={tableShape}
							onValueChange={(value) => setTableShape(value as TableShape)}
						/>
						<SwitchField
							label={<Trans>Open for online booking</Trans>}
							description={
								<Trans>
									Turn off to keep this table for staff bookings only.
								</Trans>
							}
							checked={tableOnline}
							onCheckedChange={setTableOnline}
						/>
						<SwitchField
							label={<Trans>Can be combined</Trans>}
							description={
								<Trans>Allow it to be pushed together with other tables.</Trans>
							}
							checked={tableCombinable}
							onCheckedChange={setTableCombinable}
						/>
					</div>
				</SheetForm>
			</EditSheet>

			{/* Combination sheet */}
			<EditSheet open={sheet.kind === 'combo'} onClose={closeSheet}>
				<SheetForm
					title={<Trans>New table combination</Trans>}
					description={<Trans>Choose at least two combinable tables.</Trans>}
					onSubmit={(event) => void handleSubmitCombo(event)}
					footer={
						<SheetFooterButtons
							saving={saving}
							onCancel={closeSheet}
							submitTestId="setup-add-combo-button"
							createLabel={<Trans>Create combination</Trans>}
							isEdit={false}
						/>
					}
				>
					{sheetNotices}
					<div
						className="flex flex-col gap-5"
						data-testid="setup-create-combo-form"
					>
						<TextField
							label={<Trans>Name</Trans>}
							placeholder={_(msg`e.g. T1 + T2`)}
							value={comboName}
							error={fieldError}
							onChange={(e) => setComboName(e.target.value)}
							data-testid="setup-combo-name-input"
						/>
						<div className="grid grid-cols-2 gap-4">
							<TextField
								label={<Trans>Fewest guests</Trans>}
								type="number"
								min={1}
								max={99}
								value={comboMinCovers}
								onChange={(e) => setComboMinCovers(Number(e.target.value) || 2)}
								data-testid="setup-combo-min-covers-input"
							/>
							<TextField
								label={<Trans>Most guests</Trans>}
								type="number"
								min={1}
								max={99}
								value={comboMaxCovers}
								onChange={(e) => setComboMaxCovers(Number(e.target.value) || 6)}
								data-testid="setup-combo-max-covers-input"
							/>
						</div>
						<div className="flex flex-col gap-2">
							<span className="text-sm font-medium">
								<Trans>Tables</Trans>
							</span>
							<div className="flex flex-wrap gap-2">
								{combinableTables.map((t) => {
									const checked = comboTableIds.includes(t.id)
									const minCovers = t.minCovers
									const maxCovers = t.maxCovers
									return (
										<Button
											key={t.id}
											type="button"
											variant="outline"
											size="sm"
											aria-pressed={checked}
											onClick={() => handleToggleComboTable(t.id)}
											data-testid={`setup-combo-pick-${t.label}`}
											className={cn(checked && 'border-primary bg-primary/10')}
										>
											{checked ? (
												<Icon name="check" className="size-3.5" />
											) : null}
											<span>{t.label}</span>
											<span className="text-muted-foreground text-xs font-normal tabular-nums">
												{minCovers}–{maxCovers}
											</span>
										</Button>
									)
								})}
							</div>
						</div>
					</div>
				</SheetForm>
			</EditSheet>

			<ConfirmDialog
				open={pendingConfirm !== null}
				onClose={() => setPendingConfirm(null)}
				title={archiveCopy?.title}
				description={archiveCopy?.description}
				cancelLabel={<Trans>Keep it</Trans>}
				confirmLabel={archiveCopy?.confirm}
				pending={saving}
				onConfirm={() => void handleConfirm()}
				confirmTestId="setup-confirm-archive"
			/>
		</div>
	)
}

function ListSkeleton() {
	return (
		<div className="flex flex-col gap-2 border-t p-4" role="status">
			<span className="sr-only">
				<Trans>Loading…</Trans>
			</span>
			<Skeleton className="h-10 w-full" />
			<Skeleton className="h-10 w-full" />
		</div>
	)
}

function SheetFooterButtons({
	saving,
	onCancel,
	submitTestId,
	createLabel,
	isEdit,
}: {
	saving: boolean
	onCancel: () => void
	submitTestId: string
	createLabel: ReactNode
	isEdit: boolean
}) {
	return (
		<>
			<Button type="button" variant="outline" onClick={onCancel}>
				<Trans>Cancel</Trans>
			</Button>
			<Button type="submit" disabled={saving} data-testid={submitTestId}>
				{saving ? (
					<Trans>Saving…</Trans>
				) : isEdit ? (
					<Trans>Save changes</Trans>
				) : (
					createLabel
				)}
			</Button>
		</>
	)
}
