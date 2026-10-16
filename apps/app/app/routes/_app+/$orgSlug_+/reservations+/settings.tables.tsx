import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@repo/ui/card'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '@repo/ui/table'
import { type FormEvent, useCallback, useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
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

const SHAPE_OPTIONS: ReadonlyArray<{ value: TableShape; label: string }> = [
	{ value: 'round', label: 'Round' },
	{ value: 'square', label: 'Square' },
	{ value: 'rect', label: 'Rectangle' },
	{ value: 'booth', label: 'Booth' },
	{ value: 'bar', label: 'Bar' },
	{ value: 'high_top', label: 'High-top' },
]

export default function ReservationsSettingsTablesRoute() {
	const { _ } = useLingui()
	const { orgSlug, selectedLocationId, canWrite, client, refreshSummary } =
		useReservationsSetupContext()
	const [searchParams] = useSearchParams()

	const [areas, setAreas] = useState<DiningAreaDto[]>([])
	const [tables, setTables] = useState<TableDto[]>([])
	const [combos, setCombos] = useState<TableCombinationDto[]>([])
	const [loading, setLoading] = useState(true)
	const [errorMessage, setErrorMessage] = useState<string | null>(null)
	const [conflictBanner, setConflictBanner] = useState<string | null>(null)
	const [feedbackMessage, setFeedbackMessage] = useState<string | null>(null)
	const [mutationConflicts, setMutationConflicts] = useState<
		SetupConflictDto[]
	>([])
	const [mutationReflows, setMutationReflows] = useState<ReflowedMoveDto[]>([])

	// Area creation state
	const [areaName, setAreaName] = useState('')
	const [areaNameAr, setAreaNameAr] = useState('')
	const [areaFloorLabel, setAreaFloorLabel] = useState('')
	const [areaOutdoor, setAreaOutdoor] = useState(false)
	const [areaOnline, setAreaOnline] = useState(true)
	const [editingAreaId, setEditingAreaId] = useState<string | null>(null)
	const [editingAreaName, setEditingAreaName] = useState('')

	// Table creation state
	const [newTableAreaId, setNewTableAreaId] = useState('')
	const [newTableLabel, setNewTableLabel] = useState('')
	const [newTableMinCovers, setNewTableMinCovers] = useState(2)
	const [newTableMaxCovers, setNewTableMaxCovers] = useState(4)
	const [newTableShape, setNewTableShape] = useState<TableShape>('square')
	const [newTableCombinable, setNewTableCombinable] = useState(true)
	const [newTableOnline, setNewTableOnline] = useState(true)
	const [editingTableId, setEditingTableId] = useState<string | null>(null)
	const [editingTableLabel, setEditingTableLabel] = useState('')
	const [editingTableMinCovers, setEditingTableMinCovers] = useState(2)
	const [editingTableMaxCovers, setEditingTableMaxCovers] = useState(4)

	// Combination creation state
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
			if (activeAreas.length > 0) {
				setNewTableAreaId((prev) =>
					prev && activeAreas.some((a) => a.id === prev)
						? prev
						: activeAreas[0]!.id,
				)
			}
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

	const handleCreateArea = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault()
		if (!canWrite || !selectedLocationId || !areaName.trim()) return
		setErrorMessage(null)
		setConflictBanner(null)
		setFeedbackMessage(null)

		try {
			await createArea(client, selectedLocationId, {
				name: areaName.trim(),
				nameI18n: {
					en: areaName.trim(),
					...(areaNameAr.trim() ? { ar: areaNameAr.trim() } : {}),
				},
				floorLabel: areaFloorLabel.trim() || null,
				sortOrder: areas.length,
				isOutdoor: areaOutdoor,
				isBookableOnline: areaOnline,
			})
			setAreaName('')
			setAreaNameAr('')
			setAreaFloorLabel('')
			setFeedbackMessage(_(msg`Dining area created.`))
			await Promise.all([loadAll(), refreshSummary()])
		} catch (err) {
			setErrorMessage(
				extractApiErrorMessage(err, _(msg`Failed to create dining area.`)),
			)
		}
	}

	const handleSaveAreaEdit = async (area: DiningAreaDto) => {
		if (!canWrite || !selectedLocationId || !editingAreaName.trim()) return
		setErrorMessage(null)
		setConflictBanner(null)
		try {
			const res = await updateArea(client, selectedLocationId, area.id, {
				expectedVersion: area.version,
				name: editingAreaName.trim(),
				nameI18n: { ...area.nameI18n, en: editingAreaName.trim() },
			})
			recordMutationSideEffects(res)
			setEditingAreaId(null)
			setFeedbackMessage(_(msg`Dining area updated.`))
			await Promise.all([loadAll(), refreshSummary()])
		} catch (err) {
			if (isVersionConflictError(err)) {
				setConflictBanner(
					_(
						msg`This dining area was modified by another operator. Reloading latest data.`,
					),
				)
				await loadAll()
			} else {
				setErrorMessage(
					extractApiErrorMessage(err, _(msg`Failed to update dining area.`)),
				)
			}
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

	const handleArchiveArea = async (areaId: string) => {
		if (!canWrite || !selectedLocationId) return
		setErrorMessage(null)
		try {
			const res = await deleteArea(client, selectedLocationId, areaId)
			recordMutationSideEffects(res)
			setFeedbackMessage(_(msg`Dining area archived.`))
			await Promise.all([loadAll(), refreshSummary()])
		} catch (err) {
			setErrorMessage(
				extractApiErrorMessage(err, _(msg`Failed to archive dining area.`)),
			)
		}
	}

	const handleCreateTable = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault()
		if (!canWrite || !selectedLocationId) return
		setErrorMessage(null)
		setConflictBanner(null)
		setFeedbackMessage(null)

		const targetAreaId = newTableAreaId || areas[0]?.id || ''
		if (!targetAreaId) {
			setErrorMessage(_(msg`Create a dining area before adding tables.`))
			return
		}
		if (!newTableLabel.trim()) {
			setErrorMessage(_(msg`Table label is required.`))
			return
		}
		if (newTableMinCovers > newTableMaxCovers) {
			setErrorMessage(_(msg`Minimum covers cannot exceed maximum covers.`))
			return
		}

		try {
			const res = await createTable(client, selectedLocationId, {
				areaId: targetAreaId,
				label: newTableLabel.trim(),
				minCovers: newTableMinCovers,
				maxCovers: newTableMaxCovers,
				shape: newTableShape,
				combinable: newTableCombinable,
				isBookableOnline: newTableOnline,
				x: 80 + (tables.length % 8) * 60,
				y: 80 + Math.floor(tables.length / 8) * 80,
				width: 70,
				height: 70,
			})
			recordMutationSideEffects(res)
			setNewTableLabel('')
			const createdTableLabel = res.table.label
			setFeedbackMessage(_(msg`Table ${createdTableLabel} created.`))
			await Promise.all([loadAll(), refreshSummary()])
		} catch (err) {
			setErrorMessage(
				extractApiErrorMessage(err, _(msg`Failed to create table.`)),
			)
		}
	}

	const handleSaveTableEdit = async (table: TableDto) => {
		if (!canWrite || !selectedLocationId) return
		setErrorMessage(null)
		if (editingTableMinCovers > editingTableMaxCovers) {
			setErrorMessage(_(msg`Minimum covers cannot exceed maximum covers.`))
			return
		}

		try {
			const res = await updateTable(client, selectedLocationId, table.id, {
				expectedVersion: table.version,
				label: editingTableLabel.trim() || table.label,
				minCovers: editingTableMinCovers,
				maxCovers: editingTableMaxCovers,
			})
			recordMutationSideEffects(res)
			setEditingTableId(null)
			const updatedTableLabel = res.table.label
			setFeedbackMessage(_(msg`Table ${updatedTableLabel} updated.`))
			await Promise.all([loadAll(), refreshSummary()])
		} catch (err) {
			if (isVersionConflictError(err)) {
				setConflictBanner(
					_(
						msg`This table was modified by another operator. Reloading latest tables.`,
					),
				)
				await loadAll()
			} else {
				setErrorMessage(
					extractApiErrorMessage(err, _(msg`Failed to update table.`)),
				)
			}
		}
	}

	const handleArchiveTable = async (tableId: string) => {
		if (!canWrite || !selectedLocationId) return
		setErrorMessage(null)
		try {
			const res = await deleteTable(client, selectedLocationId, tableId)
			recordMutationSideEffects(res)
			setFeedbackMessage(_(msg`Table archived.`))
			await Promise.all([loadAll(), refreshSummary()])
		} catch (err) {
			setErrorMessage(
				extractApiErrorMessage(err, _(msg`Failed to archive table.`)),
			)
		}
	}

	const handleToggleComboTable = (tableId: string) => {
		setComboTableIds((prev) =>
			prev.includes(tableId)
				? prev.filter((id) => id !== tableId)
				: [...prev, tableId],
		)
	}

	const handleCreateCombo = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault()
		if (!canWrite || !selectedLocationId) return
		setErrorMessage(null)
		setFeedbackMessage(null)

		if (!comboName.trim()) {
			setErrorMessage(_(msg`Combination name is required.`))
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

		try {
			const res = await createCombination(client, selectedLocationId, {
				name: comboName.trim(),
				minCovers: comboMinCovers,
				maxCovers: comboMaxCovers,
				tableIds: comboTableIds,
				isBookableOnline: true,
			})
			recordMutationSideEffects(res)
			setComboName('')
			setComboTableIds([])
			setFeedbackMessage(_(msg`Table combination created.`))
			await Promise.all([loadAll(), refreshSummary()])
		} catch (err) {
			setErrorMessage(
				extractApiErrorMessage(
					err,
					_(msg`Failed to create table combination.`),
				),
			)
		}
	}

	const handleDeleteCombo = async (comboId: string) => {
		if (!canWrite || !selectedLocationId) return
		setErrorMessage(null)
		try {
			const res = await deleteCombination(client, selectedLocationId, comboId)
			recordMutationSideEffects(res)
			setFeedbackMessage(_(msg`Table combination deleted.`))
			await Promise.all([loadAll(), refreshSummary()])
		} catch (err) {
			setErrorMessage(
				extractApiErrorMessage(
					err,
					_(msg`Failed to delete table combination.`),
				),
			)
		}
	}

	const combinableTables = tables.filter((t) => t.combinable && t.isActive)
	const searchSuffix = searchParams.toString()
		? `?${searchParams.toString()}`
		: ''

	return (
		<div className="flex flex-col gap-6" data-testid="setup-tables-page">
			{conflictBanner ? (
				<div
					role="alert"
					className="flex items-center justify-between gap-3 rounded-xl border border-amber-500/40 bg-amber-500/15 p-4 text-sm"
					data-testid="setup-tables-conflict-banner"
				>
					<span>{conflictBanner}</span>
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => {
							setConflictBanner(null)
							void loadAll()
						}}
					>
						<Trans>Reload</Trans>
					</Button>
				</div>
			) : null}

			{errorMessage ? (
				<div
					role="alert"
					className="border-destructive/40 bg-destructive/10 text-destructive rounded-xl border px-4 py-3 text-sm"
					data-testid="setup-tables-error-banner"
				>
					{errorMessage}
				</div>
			) : null}

			{feedbackMessage ? (
				<div
					role="status"
					className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-800 dark:text-emerald-200"
					data-testid="setup-tables-feedback-banner"
				>
					{feedbackMessage}
				</div>
			) : null}

			{mutationReflows.length > 0 || mutationConflicts.length > 0 ? (
				<div
					className="border-border bg-muted/40 flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3 text-xs"
					data-testid="setup-tables-reflow-banner"
				>
					{mutationReflows.length > 0 ? (
						<span className="text-emerald-700 dark:text-emerald-300">
							<Trans>
								Reassigned upcoming reservations after table changes
							</Trans>{' '}
							({mutationReflows.length})
						</span>
					) : null}
					{mutationConflicts.length > 0 ? (
						<span className="text-amber-700 dark:text-amber-300">
							<Trans>Upcoming reservations flagged with setup conflicts</Trans>{' '}
							({mutationConflicts.length})
						</span>
					) : null}
				</div>
			) : null}

			{/* Dining Areas Section */}
			<Card data-testid="setup-areas-card">
				<CardHeader className="flex flex-row flex-wrap items-center justify-between gap-4">
					<div>
						<CardTitle>
							<Trans>Dining Areas</Trans>
						</CardTitle>
						<CardDescription>
							<Trans>
								Group tables by room, patio, bar, or floor level. Guests can
								choose online-bookable areas when booking.
							</Trans>
						</CardDescription>
					</div>
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
						<Trans>Open Floor Plan Designer</Trans>
					</Button>
				</CardHeader>
				<CardContent className="flex flex-col gap-4">
					{canWrite ? (
						<form
							onSubmit={(e) => void handleCreateArea(e)}
							className="border-border bg-muted/20 grid grid-cols-1 items-end gap-3 rounded-lg border p-3 sm:grid-cols-2 lg:grid-cols-5"
							data-testid="setup-create-area-form"
						>
							<div className="flex flex-col gap-1">
								<Label htmlFor="new-area-name">
									<Trans>Area name (EN)</Trans>
								</Label>
								<Input
									id="new-area-name"
									placeholder={_(msg`e.g. Main Dining`)}
									value={areaName}
									onChange={(e) => setAreaName(e.target.value)}
									data-testid="setup-area-name-input"
								/>
							</div>
							<div className="flex flex-col gap-1">
								<Label htmlFor="new-area-name-ar">
									<Trans>Area name (AR)</Trans>
								</Label>
								<Input
									id="new-area-name-ar"
									dir="rtl"
									placeholder={_(msg`Arabic area name`)}
									value={areaNameAr}
									onChange={(e) => setAreaNameAr(e.target.value)}
									data-testid="setup-area-name-ar-input"
								/>
							</div>
							<div className="flex flex-col gap-1">
								<Label htmlFor="new-area-floor">
									<Trans>Floor label</Trans>
								</Label>
								<Input
									id="new-area-floor"
									placeholder={_(msg`Ground / Terrace`)}
									value={areaFloorLabel}
									onChange={(e) => setAreaFloorLabel(e.target.value)}
								/>
							</div>
							<div className="flex flex-col gap-1.5 text-xs">
								<label className="flex items-center gap-2">
									<input
										type="checkbox"
										checked={areaOutdoor}
										onChange={(e) => setAreaOutdoor(e.target.checked)}
									/>
									<Trans>Outdoor / Patio</Trans>
								</label>
								<label className="flex items-center gap-2">
									<input
										type="checkbox"
										checked={areaOnline}
										onChange={(e) => setAreaOnline(e.target.checked)}
									/>
									<Trans>Bookable online</Trans>
								</label>
							</div>
							<Button
								type="submit"
								size="sm"
								data-testid="setup-add-area-button"
							>
								<Icon name="plus" className="size-4" />
								<Trans>Add area</Trans>
							</Button>
						</form>
					) : null}

					{loading ? (
						<p className="text-muted-foreground text-sm">
							<Trans>Loading dining areas…</Trans>
						</p>
					) : areas.length === 0 ? (
						<p
							className="text-muted-foreground text-sm"
							data-testid="setup-areas-empty"
						>
							<Trans>No dining areas configured yet.</Trans>
						</p>
					) : (
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>
										<Trans>Name</Trans>
									</TableHead>
									<TableHead>
										<Trans>Floor</Trans>
									</TableHead>
									<TableHead>
										<Trans>Type</Trans>
									</TableHead>
									<TableHead>
										<Trans>Online</Trans>
									</TableHead>
									<TableHead className="text-right">
										<Trans>Actions</Trans>
									</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{areas.map((area, index) => (
									<TableRow
										key={area.id}
										data-testid={`setup-area-row-${area.name}`}
									>
										<TableCell className="font-medium">
											{editingAreaId === area.id ? (
												<div className="flex items-center gap-2">
													<Input
														value={editingAreaName}
														onChange={(e) => setEditingAreaName(e.target.value)}
														className="h-8 w-44"
														data-testid="setup-edit-area-name-input"
													/>
													<Button
														type="button"
														size="sm"
														onClick={() => void handleSaveAreaEdit(area)}
														data-testid="setup-save-area-edit-button"
													>
														<Trans>Save</Trans>
													</Button>
													<Button
														type="button"
														variant="ghost"
														size="sm"
														onClick={() => setEditingAreaId(null)}
													>
														<Trans>Cancel</Trans>
													</Button>
												</div>
											) : (
												<div className="flex items-center gap-2">
													<span>{area.name}</span>
													{area.nameI18n?.ar ? (
														<span className="text-muted-foreground text-xs">
															({area.nameI18n.ar})
														</span>
													) : null}
												</div>
											)}
										</TableCell>
										<TableCell>{area.floorLabel || '—'}</TableCell>
										<TableCell>
											{area.isOutdoor ? (
												<Badge variant="secondary">
													<Trans>Outdoor</Trans>
												</Badge>
											) : (
												<Badge variant="outline">
													<Trans>Indoor</Trans>
												</Badge>
											)}
										</TableCell>
										<TableCell>
											{area.isBookableOnline ? (
												<Badge variant="outline">
													<Trans>Online</Trans>
												</Badge>
											) : (
												<Badge variant="secondary">
													<Trans>In-house only</Trans>
												</Badge>
											)}
										</TableCell>
										<TableCell className="text-right">
											{canWrite ? (
												<div className="flex items-center justify-end gap-1">
													<Button
														type="button"
														variant="ghost"
														size="sm"
														disabled={index === 0}
														onClick={() => void handleMoveArea(area, -1)}
														aria-label={_(msg`Move area up`)}
													>
														<Icon name="chevron-up" className="size-4" />
													</Button>
													<Button
														type="button"
														variant="ghost"
														size="sm"
														disabled={index === areas.length - 1}
														onClick={() => void handleMoveArea(area, 1)}
														aria-label={_(msg`Move area down`)}
													>
														<Icon name="chevron-down" className="size-4" />
													</Button>
													<Button
														type="button"
														variant="outline"
														size="sm"
														onClick={() => {
															setEditingAreaId(area.id)
															setEditingAreaName(area.name)
														}}
														data-testid={`setup-edit-area-${area.name}`}
													>
														<Trans>Edit</Trans>
													</Button>
													<Button
														type="button"
														variant="destructive"
														size="sm"
														onClick={() => void handleArchiveArea(area.id)}
														data-testid={`setup-archive-area-${area.name}`}
													>
														<Trans>Archive</Trans>
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
				</CardContent>
			</Card>

			{/* Tables Section */}
			<Card data-testid="setup-tables-card">
				<CardHeader>
					<CardTitle>
						<Trans>Tables</Trans>
					</CardTitle>
					<CardDescription>
						<Trans>
							Manage active tables, minimum and maximum covers (1–99), shapes,
							and online bookability. Table labels are unique per location.
						</Trans>
					</CardDescription>
				</CardHeader>
				<CardContent className="flex flex-col gap-4">
					{canWrite ? (
						<form
							onSubmit={(e) => void handleCreateTable(e)}
							className="border-border bg-muted/20 grid grid-cols-1 items-end gap-3 rounded-lg border p-3 sm:grid-cols-2 lg:grid-cols-6"
							data-testid="setup-create-table-form"
						>
							<div className="flex flex-col gap-1">
								<Label htmlFor="new-table-area">
									<Trans>Area</Trans>
								</Label>
								<select
									id="new-table-area"
									value={newTableAreaId || areas[0]?.id || ''}
									onChange={(e) => setNewTableAreaId(e.target.value)}
									className="border-input bg-background text-foreground h-9 rounded-md border px-2 text-sm"
									data-testid="setup-table-area-select"
								>
									{areas.map((a) => (
										<option key={a.id} value={a.id}>
											{a.name}
										</option>
									))}
								</select>
							</div>

							<div className="flex flex-col gap-1">
								<Label htmlFor="new-table-label">
									<Trans>Table label</Trans>
								</Label>
								<Input
									id="new-table-label"
									placeholder={_(msg`e.g. T15`)}
									value={newTableLabel}
									onChange={(e) => setNewTableLabel(e.target.value)}
									data-testid="setup-table-label-input"
								/>
							</div>

							<div className="flex flex-col gap-1">
								<Label htmlFor="new-table-min">
									<Trans>Min covers</Trans>
								</Label>
								<Input
									id="new-table-min"
									type="number"
									min={1}
									max={99}
									value={newTableMinCovers}
									onChange={(e) =>
										setNewTableMinCovers(Number(e.target.value) || 1)
									}
									data-testid="setup-table-min-covers-input"
								/>
							</div>

							<div className="flex flex-col gap-1">
								<Label htmlFor="new-table-max">
									<Trans>Max covers</Trans>
								</Label>
								<Input
									id="new-table-max"
									type="number"
									min={1}
									max={99}
									value={newTableMaxCovers}
									onChange={(e) =>
										setNewTableMaxCovers(Number(e.target.value) || 2)
									}
									data-testid="setup-table-max-covers-input"
								/>
							</div>

							<div className="flex flex-col gap-1">
								<Label htmlFor="new-table-shape">
									<Trans>Shape</Trans>
								</Label>
								<select
									id="new-table-shape"
									value={newTableShape}
									onChange={(e) =>
										setNewTableShape(e.target.value as TableShape)
									}
									className="border-input bg-background text-foreground h-9 rounded-md border px-2 text-sm"
									data-testid="setup-table-shape-select"
								>
									{SHAPE_OPTIONS.map((s) => (
										<option key={s.value} value={s.value}>
											{s.label}
										</option>
									))}
								</select>
							</div>

							<div className="flex flex-col gap-2">
								<div className="flex items-center gap-3 text-xs">
									<label className="flex items-center gap-1">
										<input
											type="checkbox"
											checked={newTableCombinable}
											onChange={(e) => setNewTableCombinable(e.target.checked)}
										/>
										<Trans>Combinable</Trans>
									</label>
									<label className="flex items-center gap-1">
										<input
											type="checkbox"
											checked={newTableOnline}
											onChange={(e) => setNewTableOnline(e.target.checked)}
										/>
										<Trans>Online</Trans>
									</label>
								</div>
								<Button
									type="submit"
									size="sm"
									data-testid="setup-add-table-button"
								>
									<Icon name="plus" className="size-4" />
									<Trans>Add table</Trans>
								</Button>
							</div>
						</form>
					) : null}

					{tables.length === 0 ? (
						<p
							className="text-muted-foreground text-sm"
							data-testid="setup-tables-empty"
						>
							<Trans>No active tables in this location.</Trans>
						</p>
					) : (
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>
										<Trans>Label</Trans>
									</TableHead>
									<TableHead>
										<Trans>Area</Trans>
									</TableHead>
									<TableHead>
										<Trans>Capacity</Trans>
									</TableHead>
									<TableHead>
										<Trans>Shape</Trans>
									</TableHead>
									<TableHead>
										<Trans>Flags</Trans>
									</TableHead>
									<TableHead className="text-right">
										<Trans>Actions</Trans>
									</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{tables.map((table) => {
									const areaNameForTable =
										areas.find((a) => a.id === table.areaId)?.name ?? '—'
									const isEditing = editingTableId === table.id
									return (
										<TableRow
											key={table.id}
											data-testid={`setup-table-row-${table.label}`}
										>
											<TableCell className="font-semibold">
												{isEditing ? (
													<Input
														value={editingTableLabel}
														onChange={(e) =>
															setEditingTableLabel(e.target.value)
														}
														className="h-8 w-24"
														data-testid="setup-edit-table-label-input"
													/>
												) : (
													table.label
												)}
											</TableCell>
											<TableCell>{areaNameForTable}</TableCell>
											<TableCell>
												{isEditing ? (
													<div className="flex items-center gap-1.5">
														<Input
															type="number"
															min={1}
															max={99}
															value={editingTableMinCovers}
															onChange={(e) =>
																setEditingTableMinCovers(
																	Number(e.target.value) || 1,
																)
															}
															className="h-8 w-16"
															data-testid="setup-edit-table-min-input"
														/>
														<span>–</span>
														<Input
															type="number"
															min={1}
															max={99}
															value={editingTableMaxCovers}
															onChange={(e) =>
																setEditingTableMaxCovers(
																	Number(e.target.value) || 1,
																)
															}
															className="h-8 w-16"
															data-testid="setup-edit-table-max-input"
														/>
													</div>
												) : (
													`${table.minCovers}–${table.maxCovers} covers`
												)}
											</TableCell>
											<TableCell>{table.shape}</TableCell>
											<TableCell>
												<div className="flex flex-wrap gap-1">
													{table.combinable ? (
														<Badge variant="outline">
															<Trans>Combinable</Trans>
														</Badge>
													) : null}
													{table.isBookableOnline ? (
														<Badge variant="outline">
															<Trans>Online</Trans>
														</Badge>
													) : (
														<Badge variant="secondary">
															<Trans>Staff only</Trans>
														</Badge>
													)}
												</div>
											</TableCell>
											<TableCell className="text-right">
												{canWrite ? (
													isEditing ? (
														<div className="flex items-center justify-end gap-1">
															<Button
																type="button"
																size="sm"
																onClick={() => void handleSaveTableEdit(table)}
																data-testid="setup-save-table-edit-button"
															>
																<Trans>Save</Trans>
															</Button>
															<Button
																type="button"
																variant="ghost"
																size="sm"
																onClick={() => setEditingTableId(null)}
															>
																<Trans>Cancel</Trans>
															</Button>
														</div>
													) : (
														<div className="flex items-center justify-end gap-1">
															<Button
																type="button"
																variant="outline"
																size="sm"
																onClick={() => {
																	setEditingTableId(table.id)
																	setEditingTableLabel(table.label)
																	setEditingTableMinCovers(table.minCovers)
																	setEditingTableMaxCovers(table.maxCovers)
																}}
																data-testid={`setup-edit-table-${table.label}`}
															>
																<Trans>Edit</Trans>
															</Button>
															<Button
																type="button"
																variant="destructive"
																size="sm"
																onClick={() =>
																	void handleArchiveTable(table.id)
																}
																data-testid={`setup-archive-table-${table.label}`}
															>
																<Trans>Archive</Trans>
															</Button>
														</div>
													)
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
				</CardContent>
			</Card>

			{/* Table Combinations Section */}
			<Card data-testid="setup-combos-card">
				<CardHeader>
					<CardTitle>
						<Trans>Table Combinations</Trans>
					</CardTitle>
					<CardDescription>
						<Trans>
							Combine 2 or more combinable tables to seat larger parties.
							Duplicate table sets are automatically prevented.
						</Trans>
					</CardDescription>
				</CardHeader>
				<CardContent className="flex flex-col gap-4">
					{canWrite ? (
						<form
							onSubmit={(e) => void handleCreateCombo(e)}
							className="border-border bg-muted/20 flex flex-col gap-3 rounded-lg border p-3"
							data-testid="setup-create-combo-form"
						>
							<div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
								<div className="flex flex-col gap-1">
									<Label htmlFor="combo-name">
										<Trans>Combination name</Trans>
									</Label>
									<Input
										id="combo-name"
										placeholder={_(msg`e.g. T1 + T2`)}
										value={comboName}
										onChange={(e) => setComboName(e.target.value)}
										data-testid="setup-combo-name-input"
									/>
								</div>
								<div className="flex flex-col gap-1">
									<Label htmlFor="combo-min-covers">
										<Trans>Min covers</Trans>
									</Label>
									<Input
										id="combo-min-covers"
										type="number"
										min={1}
										max={99}
										value={comboMinCovers}
										onChange={(e) =>
											setComboMinCovers(Number(e.target.value) || 2)
										}
										data-testid="setup-combo-min-covers-input"
									/>
								</div>
								<div className="flex flex-col gap-1">
									<Label htmlFor="combo-max-covers">
										<Trans>Max covers</Trans>
									</Label>
									<Input
										id="combo-max-covers"
										type="number"
										min={1}
										max={99}
										value={comboMaxCovers}
										onChange={(e) =>
											setComboMaxCovers(Number(e.target.value) || 6)
										}
										data-testid="setup-combo-max-covers-input"
									/>
								</div>
							</div>

							<div className="flex flex-col gap-1.5">
								<Label>
									<Trans>Select combinable tables (minimum 2)</Trans>
								</Label>
								<div className="flex flex-wrap gap-2">
									{combinableTables.map((t) => {
										const checked = comboTableIds.includes(t.id)
										return (
											<label
												key={t.id}
												className="border-border bg-background flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium"
												data-testid={`setup-combo-pick-${t.label}`}
											>
												<input
													type="checkbox"
													checked={checked}
													onChange={() => handleToggleComboTable(t.id)}
												/>
												<span>
													{t.label} ({t.minCovers}–{t.maxCovers}p)
												</span>
											</label>
										)
									})}
								</div>
							</div>

							<div className="flex justify-end">
								<Button
									type="submit"
									size="sm"
									data-testid="setup-add-combo-button"
								>
									<Icon name="plus" className="size-4" />
									<Trans>Create combination</Trans>
								</Button>
							</div>
						</form>
					) : null}

					{combos.length === 0 ? (
						<p
							className="text-muted-foreground text-sm"
							data-testid="setup-combos-empty"
						>
							<Trans>No table combinations configured yet.</Trans>
						</p>
					) : (
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>
										<Trans>Combination</Trans>
									</TableHead>
									<TableHead>
										<Trans>Member tables</Trans>
									</TableHead>
									<TableHead>
										<Trans>Capacity</Trans>
									</TableHead>
									<TableHead className="text-right">
										<Trans>Actions</Trans>
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
											<TableCell className="font-medium">
												{combo.name}
											</TableCell>
											<TableCell>{memberLabels}</TableCell>
											<TableCell>
												{combo.minCovers}–{combo.maxCovers} covers
											</TableCell>
											<TableCell className="text-right">
												{canWrite ? (
													<Button
														type="button"
														variant="destructive"
														size="sm"
														onClick={() => void handleDeleteCombo(combo.id)}
														data-testid={`setup-delete-combo-${combo.name}`}
													>
														<Trans>Delete</Trans>
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
				</CardContent>
			</Card>
		</div>
	)
}
