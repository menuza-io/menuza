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
	type FormEvent,
	useCallback,
	useEffect,
	useMemo,
	useState,
} from 'react'
import { GeneralErrorBoundary } from '#app/components/error-boundary.tsx'
import { requireReservationsAccess } from '#app/utils/reservations/access.server.ts'
import {
	createSectionLayout,
	deleteSectionLayout,
	listSectionLayouts,
	resolveSectionColorHex,
	type RsvSectionLayoutRecord,
	updateSectionLayout,
} from '#app/utils/reservations/book-api.ts'
import { RESERVATIONS_SECTION_REQUIREMENTS } from '#app/utils/reservations/sections.ts'
import {
	type DiningAreaDto,
	extractApiErrorMessage,
	fetchAreas,
	fetchServices,
	fetchTables,
	type ServicePeriodDto,
	type TableDto,
} from '#app/utils/reservations/setup-api.ts'
import { type Route } from './+types/settings.sections.ts'
import { useReservationsSetupContext } from './settings.tsx'

export async function loader({ request, params }: Route.LoaderArgs) {
	await requireReservationsAccess(
		request,
		params.orgSlug,
		RESERVATIONS_SECTION_REQUIREMENTS.settings,
	)
	return null
}

type DraftSectionRow = {
	id?: string
	name: string
	colorToken: string
	tableIds: string[]
}

const COLOR_TOKENS: ReadonlyArray<{ token: string; label: string }> = [
	{ token: '1', label: '1 · Blue' },
	{ token: '2', label: '2 · Emerald' },
	{ token: '3', label: '3 · Amber' },
	{ token: '4', label: '4 · Violet' },
	{ token: '5', label: '5 · Pink' },
	{ token: '6', label: '6 · Cyan' },
	{ token: '7', label: '7 · Orange' },
	{ token: '8', label: '8 · Lime' },
]

function makeInitialDraftSections(): DraftSectionRow[] {
	return [
		{ name: 'Section A', colorToken: '1', tableIds: [] },
		{ name: 'Section B', colorToken: '2', tableIds: [] },
		{ name: 'Patio', colorToken: '3', tableIds: [] },
	]
}

export default function ReservationsSettingsSectionsRoute() {
	const { _ } = useLingui()
	const { selectedLocationId, canWrite, client } = useReservationsSetupContext()

	const [layouts, setLayouts] = useState<RsvSectionLayoutRecord[]>([])
	const [tables, setTables] = useState<TableDto[]>([])
	const [areas, setAreas] = useState<DiningAreaDto[]>([])
	const [services, setServices] = useState<ServicePeriodDto[]>([])
	const [loading, setLoading] = useState(true)
	const [saving, setSaving] = useState(false)
	const [errorMessage, setErrorMessage] = useState<string | null>(null)
	const [feedbackMessage, setFeedbackMessage] = useState<string | null>(null)

	// Create form state
	const [newLayoutName, setNewLayoutName] = useState('')
	const [newLayoutServiceId, setNewLayoutServiceId] = useState('')
	const [draftSections, setDraftSections] = useState<DraftSectionRow[]>(
		makeInitialDraftSections,
	)

	// Edit state
	const [editingLayoutId, setEditingLayoutId] = useState<string | null>(null)
	const [editingLayoutName, setEditingLayoutName] = useState('')
	const [editingLayoutServiceId, setEditingLayoutServiceId] = useState('')
	const [editingSections, setEditingSections] = useState<DraftSectionRow[]>([])

	const loadAll = useCallback(async () => {
		if (!selectedLocationId) {
			setLoading(false)
			return
		}
		setLoading(true)
		setErrorMessage(null)
		try {
			const [layoutsRes, tablesRes, areasRes, servicesRes] = await Promise.all([
				listSectionLayouts(client, selectedLocationId),
				fetchTables(client, selectedLocationId),
				fetchAreas(client, selectedLocationId),
				fetchServices(client, selectedLocationId),
			])
			setLayouts(layoutsRes)
			setTables(tablesRes.tables.filter((t) => !t.archivedAt))
			setAreas(areasRes.areas.filter((a) => !a.archivedAt))
			setServices(servicesRes.services.filter((s) => !s.archivedAt))
		} catch (err) {
			setErrorMessage(
				extractApiErrorMessage(
					err,
					_(msg`Failed to load section layouts for this location.`),
				),
			)
		} finally {
			setLoading(false)
		}
	}, [client, selectedLocationId, _])

	useEffect(() => {
		void loadAll()
	}, [loadAll])

	const tableById = useMemo(() => {
		const map = new Map<string, TableDto>()
		for (const table of tables) {
			map.set(table.id, table)
		}
		return map
	}, [tables])

	const areaNameById = useMemo(() => {
		const map = new Map<string, string>()
		for (const area of areas) {
			map.set(area.id, area.name)
		}
		return map
	}, [areas])

	// Toggle table assignment inside a section list, enforcing uniqueness across sections in the layout (VAL-HOST-019)
	const toggleTableInSections = (
		list: DraftSectionRow[],
		sectionIdx: number,
		tableId: string,
	): DraftSectionRow[] => {
		const target = list[sectionIdx]
		if (!target) return list
		const alreadyInTarget = target.tableIds.includes(tableId)

		return list.map((sec, idx) => {
			if (idx === sectionIdx) {
				return {
					...sec,
					tableIds: alreadyInTarget
						? sec.tableIds.filter((id) => id !== tableId)
						: [...sec.tableIds, tableId],
				}
			}
			// Remove from any other section in this layout so a table never belongs to two sections
			if (!alreadyInTarget && sec.tableIds.includes(tableId)) {
				return {
					...sec,
					tableIds: sec.tableIds.filter((id) => id !== tableId),
				}
			}
			return sec
		})
	}

	const handleAddDraftSection = () => {
		const nextIdx = draftSections.length
		const nextColor = String((nextIdx % 8) + 1)
		setDraftSections((prev) => [
			...prev,
			{
				name: `Section ${String.fromCharCode(65 + (nextIdx % 26))}`,
				colorToken: nextColor,
				tableIds: [],
			},
		])
	}

	const handleRemoveDraftSection = (idx: number) => {
		setDraftSections((prev) => prev.filter((_s, i) => i !== idx))
	}

	const handleCreateLayout = async (e: FormEvent) => {
		e.preventDefault()
		if (!canWrite || !selectedLocationId || saving) return

		const trimmedName = newLayoutName.trim()
		if (!trimmedName) {
			setErrorMessage(_(msg`Please enter a name for the section layout.`))
			return
		}
		const validSections = draftSections
			.map((sec, idx) => ({
				name: sec.name.trim(),
				colorToken: sec.colorToken || String((idx % 8) + 1),
				sort: idx,
				tableIds: sec.tableIds,
			}))
			.filter((sec) => sec.name.length > 0)

		if (validSections.length === 0) {
			setErrorMessage(_(msg`Add at least one named section to the layout.`))
			return
		}

		setSaving(true)
		setErrorMessage(null)
		setFeedbackMessage(null)
		try {
			const created = await createSectionLayout(client, {
				locationId: selectedLocationId,
				name: trimmedName,
				serviceId: newLayoutServiceId || null,
				sections: validSections,
			})
			setLayouts((prev) => [...prev, created])
			setNewLayoutName('')
			setNewLayoutServiceId('')
			setDraftSections(makeInitialDraftSections())
			setFeedbackMessage(_(msg`Section layout "${created.name}" created.`))
		} catch (err) {
			setErrorMessage(
				extractApiErrorMessage(err, _(msg`Failed to create section layout.`)),
			)
		} finally {
			setSaving(false)
		}
	}

	const startEditingLayout = (layout: RsvSectionLayoutRecord) => {
		setEditingLayoutId(layout.id)
		setEditingLayoutName(layout.name)
		setEditingLayoutServiceId(layout.serviceId ?? '')
		setEditingSections(
			layout.sections.map((sec, idx) => ({
				id: sec.id,
				name: sec.name,
				colorToken: sec.colorToken || String((idx % 8) + 1),
				tableIds: [...sec.tableIds],
			})),
		)
		setErrorMessage(null)
		setFeedbackMessage(null)
	}

	const cancelEditingLayout = () => {
		setEditingLayoutId(null)
		setEditingLayoutName('')
		setEditingLayoutServiceId('')
		setEditingSections([])
	}

	const handleAddEditingSection = () => {
		const nextIdx = editingSections.length
		const nextColor = String((nextIdx % 8) + 1)
		setEditingSections((prev) => [
			...prev,
			{
				name: `Section ${String.fromCharCode(65 + (nextIdx % 26))}`,
				colorToken: nextColor,
				tableIds: [],
			},
		])
	}

	const handleRemoveEditingSection = (idx: number) => {
		setEditingSections((prev) => prev.filter((_s, i) => i !== idx))
	}

	const handleSaveEditLayout = async (layoutId: string) => {
		if (!canWrite || saving) return
		const trimmedName = editingLayoutName.trim()
		if (!trimmedName) {
			setErrorMessage(_(msg`Layout name is required.`))
			return
		}
		const validSections = editingSections
			.map((sec, idx) => ({
				...(sec.id ? { id: sec.id } : {}),
				name: sec.name.trim(),
				colorToken: sec.colorToken || String((idx % 8) + 1),
				sort: idx,
				tableIds: sec.tableIds,
			}))
			.filter((sec) => sec.name.length > 0)

		if (validSections.length === 0) {
			setErrorMessage(_(msg`At least one section is required.`))
			return
		}

		setSaving(true)
		setErrorMessage(null)
		setFeedbackMessage(null)
		try {
			const updated = await updateSectionLayout(client, layoutId, {
				name: trimmedName,
				serviceId: editingLayoutServiceId || null,
				sections: validSections,
			})
			setLayouts((prev) =>
				prev.map((item) => (item.id === layoutId ? updated : item)),
			)
			cancelEditingLayout()
			setFeedbackMessage(_(msg`Section layout "${updated.name}" updated.`))
		} catch (err) {
			setErrorMessage(
				extractApiErrorMessage(err, _(msg`Failed to update section layout.`)),
			)
		} finally {
			setSaving(false)
		}
	}

	const handleDeleteLayout = async (layout: RsvSectionLayoutRecord) => {
		if (!canWrite || saving) return
		setSaving(true)
		setErrorMessage(null)
		setFeedbackMessage(null)
		try {
			await deleteSectionLayout(client, layout.id)
			setLayouts((prev) => prev.filter((item) => item.id !== layout.id))
			if (editingLayoutId === layout.id) {
				cancelEditingLayout()
			}
			setFeedbackMessage(_(msg`Section layout "${layout.name}" deleted.`))
		} catch (err) {
			setErrorMessage(
				extractApiErrorMessage(err, _(msg`Failed to delete section layout.`)),
			)
		} finally {
			setSaving(false)
		}
	}

	const renderSectionBuilder = (
		sectionsList: DraftSectionRow[],
		setSectionsList: React.Dispatch<React.SetStateAction<DraftSectionRow[]>>,
		onAddSection: () => void,
		onRemoveSection: (idx: number) => void,
		prefix: 'create' | 'edit',
	) => {
		// Map tableId -> section index & name for showing ownership and preventing duplicates
		const ownerByTableId = new Map<string, { idx: number; name: string }>()
		sectionsList.forEach((sec, idx) => {
			for (const tid of sec.tableIds) {
				ownerByTableId.set(tid, { idx, name: sec.name || `#${idx + 1}` })
			}
		})

		return (
			<div className="flex flex-col gap-4">
				<div className="flex items-center justify-between">
					<Label className="text-sm font-semibold">
						<Trans>Sections & Table Sets</Trans>
					</Label>
					{canWrite ? (
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={onAddSection}
							data-testid={`${prefix}-section-layout-add-section`}
						>
							<Icon name="plus" className="mr-1 size-3.5" />
							<Trans>Add section</Trans>
						</Button>
					) : null}
				</div>

				<p className="text-muted-foreground text-xs">
					<Trans>
						Each table can belong to at most one section in a layout. Clicking a
						table assigned to another section moves it to the selected section.
					</Trans>
				</p>

				<div className="flex flex-col gap-3">
					{sectionsList.map((sec, idx) => {
						const hex = resolveSectionColorHex(sec.colorToken)
						return (
							<div
								key={sec.id ?? `draft-${idx}`}
								className="border-border bg-muted/20 flex flex-col gap-3 rounded-lg border p-3"
								data-testid={`${prefix}-section-row-${idx}`}
							>
								<div className="flex flex-wrap items-center justify-between gap-3">
									<div className="flex flex-1 flex-wrap items-center gap-3">
										<span
											className="inline-block size-4 shrink-0 rounded-full border"
											style={{ backgroundColor: hex }}
											aria-hidden="true"
										/>
										<div className="min-w-44 flex-1">
											<Input
												value={sec.name}
												disabled={!canWrite}
												onChange={(e) => {
													const val = e.target.value
													setSectionsList((prev) =>
														prev.map((item, i) =>
															i === idx ? { ...item, name: val } : item,
														),
													)
												}}
												placeholder={_(msg`Section name (e.g. Section A)`)}
												data-testid={`${prefix}-section-name-input-${idx}`}
											/>
										</div>

										<div className="flex items-center gap-1.5">
											<Label className="text-muted-foreground text-xs">
												<Trans>Color</Trans>
											</Label>
											<select
												value={sec.colorToken}
												disabled={!canWrite}
												onChange={(e) => {
													const val = e.target.value
													setSectionsList((prev) =>
														prev.map((item, i) =>
															i === idx ? { ...item, colorToken: val } : item,
														),
													)
												}}
												className="border-input bg-background rounded-md border px-2 py-1.5 text-xs"
												data-testid={`${prefix}-section-color-select-${idx}`}
											>
												{COLOR_TOKENS.map((ct) => (
													<option key={ct.token} value={ct.token}>
														{ct.label}
													</option>
												))}
											</select>
											<div className="flex items-center gap-1">
												{COLOR_TOKENS.map((ct) => {
													const swatchHex = resolveSectionColorHex(ct.token)
													const isSelected = sec.colorToken === ct.token
													return (
														<button
															key={ct.token}
															type="button"
															disabled={!canWrite}
															onClick={() => {
																setSectionsList((prev) =>
																	prev.map((item, i) =>
																		i === idx
																			? { ...item, colorToken: ct.token }
																			: item,
																	),
																)
															}}
															title={ct.label}
															aria-label={`Color token ${ct.token}`}
															data-testid={`${prefix}-section-color-token-${idx}-${ct.token}`}
															className={`size-5 rounded-full border transition ${
																isSelected
																	? 'ring-primary scale-110 ring-2 ring-offset-1'
																	: 'opacity-75 hover:opacity-100'
															}`}
															style={{ backgroundColor: swatchHex }}
														/>
													)
												})}
											</div>
										</div>
									</div>

									{canWrite && sectionsList.length > 1 ? (
										<Button
											type="button"
											variant="ghost"
											size="sm"
											onClick={() => onRemoveSection(idx)}
											data-testid={`${prefix}-section-remove-${idx}`}
										>
											<Icon name="trash-2" className="size-4" />
										</Button>
									) : null}
								</div>

								{/* Table multi-select pills */}
								<div className="flex flex-wrap items-center gap-1.5">
									{tables.length === 0 ? (
										<span className="text-muted-foreground text-xs">
											<Trans>
												No active tables found. Create tables in the Tables &
												Areas tab first.
											</Trans>
										</span>
									) : (
										tables.map((table) => {
											const isAssignedHere = sec.tableIds.includes(table.id)
											const owner = ownerByTableId.get(table.id)
											const isAssignedElsewhere =
												Boolean(owner) && owner!.idx !== idx
											const areaName = areaNameById.get(table.areaId)

											return (
												<button
													key={table.id}
													type="button"
													disabled={!canWrite}
													onClick={() => {
														setSectionsList((prev) =>
															toggleTableInSections(prev, idx, table.id),
														)
													}}
													data-testid={`${prefix}-section-table-toggle-${idx}-${table.id}`}
													data-table-label={table.label}
													className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium transition ${
														isAssignedHere
															? 'border-primary bg-primary text-primary-foreground shadow-xs'
															: isAssignedElsewhere
																? 'border-border bg-muted/60 text-muted-foreground hover:border-primary/50'
																: 'border-border bg-background text-foreground hover:bg-accent'
													}`}
												>
													<span>{table.label}</span>
													{areaName ? (
														<span className="text-[10px] opacity-75">
															({areaName})
														</span>
													) : null}
													{isAssignedElsewhere && owner ? (
														<span className="rounded bg-amber-500/20 px-1 text-[10px] text-amber-700 dark:text-amber-300">
															{owner.name}
														</span>
													) : null}
												</button>
											)
										})
									)}
								</div>
							</div>
						)
					})}
				</div>
			</div>
		)
	}

	return (
		<div
			className="flex flex-col gap-6"
			data-testid="reservations-settings-sections-page"
		>
			{errorMessage ? (
				<div
					role="alert"
					className="border-destructive/40 bg-destructive/10 text-destructive flex items-center justify-between gap-3 rounded-xl border px-4 py-3 text-sm"
					data-testid="sections-error-banner"
				>
					<span>{errorMessage}</span>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						onClick={() => setErrorMessage(null)}
					>
						<Icon name="x" className="size-4" />
					</Button>
				</div>
			) : null}

			{feedbackMessage ? (
				<div
					role="status"
					className="flex items-center justify-between gap-3 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-800 dark:text-emerald-200"
					data-testid="sections-feedback-banner"
				>
					<span>{feedbackMessage}</span>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						onClick={() => setFeedbackMessage(null)}
					>
						<Icon name="x" className="size-4" />
					</Button>
				</div>
			) : null}

			{/* Create section layout card */}
			<Card data-testid="create-section-layout-card">
				<CardHeader>
					<CardTitle>
						<Trans>Create Section Layout</Trans>
					</CardTitle>
					<CardDescription>
						<Trans>
							Group tables into color-coded server sections (tokens 1–8) for
							floor overlays and shift server assignments.
						</Trans>
					</CardDescription>
				</CardHeader>
				<CardContent>
					<form
						onSubmit={(e) => void handleCreateLayout(e)}
						className="flex flex-col gap-4"
						data-testid="create-section-layout-form"
					>
						<div className="grid gap-4 sm:grid-cols-2">
							<div className="flex flex-col gap-1.5">
								<Label htmlFor="section-layout-name">
									<Trans>Layout Name</Trans>
								</Label>
								<Input
									id="section-layout-name"
									value={newLayoutName}
									disabled={!canWrite || saving}
									onChange={(e) => setNewLayoutName(e.target.value)}
									placeholder={_(msg`e.g. Dinner 3-server`)}
									data-testid="section-layout-name-input"
								/>
							</div>

							<div className="flex flex-col gap-1.5">
								<Label htmlFor="section-layout-service">
									<Trans>Link to Service Period (optional)</Trans>
								</Label>
								<select
									id="section-layout-service"
									value={newLayoutServiceId}
									disabled={!canWrite || saving}
									onChange={(e) => setNewLayoutServiceId(e.target.value)}
									className="border-input bg-background h-9 rounded-md border px-3 text-sm"
									data-testid="section-layout-service-select"
								>
									<option value="">{_(msg`All / Unlinked`)}</option>
									{services.map((svc) => (
										<option key={svc.id} value={svc.id}>
											{svc.name}
										</option>
									))}
								</select>
							</div>
						</div>

						{renderSectionBuilder(
							draftSections,
							setDraftSections,
							handleAddDraftSection,
							handleRemoveDraftSection,
							'create',
						)}

						{canWrite ? (
							<div className="flex justify-end">
								<Button
									type="submit"
									disabled={saving}
									data-testid="section-layout-create-submit"
								>
									<Icon name="plus" className="mr-1.5 size-4" />
									{saving ? (
										<Trans>Saving…</Trans>
									) : (
										<Trans>Create Section Layout</Trans>
									)}
								</Button>
							</div>
						) : null}
					</form>
				</CardContent>
			</Card>

			{/* Existing section layouts */}
			<Card data-testid="saved-section-layouts-card">
				<CardHeader>
					<CardTitle>
						<Trans>Saved Section Layouts</Trans> ({layouts.length})
					</CardTitle>
					<CardDescription>
						<Trans>
							Manage existing server section configurations for this location.
						</Trans>
					</CardDescription>
				</CardHeader>
				<CardContent>
					{loading ? (
						<p
							className="text-muted-foreground py-6 text-sm"
							data-testid="section-layouts-loading"
						>
							<Trans>Loading section layouts…</Trans>
						</p>
					) : layouts.length === 0 ? (
						<p
							className="text-muted-foreground py-6 text-sm"
							data-testid="section-layouts-empty"
						>
							<Trans>
								No section layouts configured for this location yet.
							</Trans>
						</p>
					) : (
						<div
							className="flex flex-col gap-4"
							data-testid="section-layouts-list"
						>
							{layouts.map((layout) => {
								const isEditing = editingLayoutId === layout.id

								return (
									<div
										key={layout.id}
										className="border-border bg-card flex flex-col gap-4 rounded-xl border p-4"
										data-testid={`section-layout-card-${layout.id}`}
										data-layout-name={layout.name}
									>
										{isEditing ? (
											<div
												className="flex flex-col gap-4"
												data-testid={`section-layout-edit-form-${layout.id}`}
											>
												<div className="grid gap-4 sm:grid-cols-2">
													<div className="flex flex-col gap-1.5">
														<Label>
															<Trans>Layout Name</Trans>
														</Label>
														<Input
															value={editingLayoutName}
															onChange={(e) =>
																setEditingLayoutName(e.target.value)
															}
															data-testid="edit-section-layout-name-input"
														/>
													</div>
													<div className="flex flex-col gap-1.5">
														<Label>
															<Trans>Link to Service Period (optional)</Trans>
														</Label>
														<select
															value={editingLayoutServiceId}
															onChange={(e) =>
																setEditingLayoutServiceId(e.target.value)
															}
															className="border-input bg-background h-9 rounded-md border px-3 text-sm"
															data-testid="edit-section-layout-service-select"
														>
															<option value="">{_(msg`All / Unlinked`)}</option>
															{services.map((svc) => (
																<option key={svc.id} value={svc.id}>
																	{svc.name}
																</option>
															))}
														</select>
													</div>
												</div>

												{renderSectionBuilder(
													editingSections,
													setEditingSections,
													handleAddEditingSection,
													handleRemoveEditingSection,
													'edit',
												)}

												<div className="flex items-center justify-end gap-2">
													<Button
														type="button"
														variant="outline"
														size="sm"
														onClick={cancelEditingLayout}
														data-testid="section-layout-cancel-edit"
													>
														<Trans>Cancel</Trans>
													</Button>
													<Button
														type="button"
														size="sm"
														disabled={saving}
														onClick={() => void handleSaveEditLayout(layout.id)}
														data-testid="section-layout-save-edit"
													>
														<Icon name="check" className="mr-1 size-4" />
														<Trans>Save Changes</Trans>
													</Button>
												</div>
											</div>
										) : (
											<>
												<div className="flex flex-wrap items-center justify-between gap-2">
													<div className="flex items-center gap-2">
														<h3 className="text-base font-semibold">
															{layout.name}
														</h3>
														<Badge variant="secondary">
															{layout.sections.length}{' '}
															{layout.sections.length === 1
																? _(msg`section`)
																: _(msg`sections`)}
														</Badge>
													</div>

													{canWrite ? (
														<div className="flex items-center gap-2">
															<Button
																type="button"
																variant="outline"
																size="sm"
																onClick={() => startEditingLayout(layout)}
																data-testid={`section-layout-edit-${layout.id}`}
															>
																<Icon name="pencil" className="mr-1 size-3.5" />
																<Trans>Edit</Trans>
															</Button>
															<Button
																type="button"
																variant="destructive"
																size="sm"
																disabled={saving}
																onClick={() => void handleDeleteLayout(layout)}
																data-testid={`section-layout-delete-${layout.id}`}
															>
																<Icon
																	name="trash-2"
																	className="mr-1 size-3.5"
																/>
																<Trans>Delete</Trans>
															</Button>
														</div>
													) : null}
												</div>

												<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
													{layout.sections.map((sec) => {
														const hex = resolveSectionColorHex(sec.colorToken)
														return (
															<div
																key={sec.id}
																className="border-border bg-muted/20 flex flex-col gap-2 rounded-lg border p-3"
																data-testid={`saved-section-item-${sec.id}`}
															>
																<div className="flex items-center justify-between gap-2">
																	<div className="flex items-center gap-2">
																		<span
																			className="inline-block size-3.5 rounded-full"
																			style={{ backgroundColor: hex }}
																		/>
																		<span className="text-sm font-medium">
																			{sec.name}
																		</span>
																	</div>
																	<Badge variant="outline" className="text-xs">
																		<Trans>Color</Trans> {sec.colorToken}
																	</Badge>
																</div>
																<div className="flex flex-wrap gap-1">
																	{sec.tableIds.length === 0 ? (
																		<span className="text-muted-foreground text-xs">
																			<Trans>No tables assigned</Trans>
																		</span>
																	) : (
																		sec.tableIds.map((tid) => {
																			const tbl = tableById.get(tid)
																			return (
																				<Badge
																					key={tid}
																					variant="secondary"
																					className="text-xs"
																				>
																					{tbl?.label ?? tid}
																				</Badge>
																			)
																		})
																	)}
																</div>
															</div>
														)
													})}
												</div>
											</>
										)}
									</div>
								)
							})}
						</div>
					)}
				</CardContent>
			</Card>
		</div>
	)
}

export function ErrorBoundary() {
	return <GeneralErrorBoundary />
}
