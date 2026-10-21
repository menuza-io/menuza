import { type MessageDescriptor } from '@lingui/core'
import { Plural, Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { cn } from '@repo/ui'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { FieldError } from '@repo/ui/field'
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
	useCallback,
	useEffect,
	useMemo,
	useState,
} from 'react'
import { EmptyState } from '#app/components/empty-state.tsx'
import { GeneralErrorBoundary } from '#app/components/error-boundary.tsx'
import { useSheetDirty } from '#app/components/reservations/settings/dirty.ts'
import {
	ConfirmDialog,
	EditSheet,
	SetupNotices,
	useDiscardGuard,
} from '#app/components/reservations/settings/setup-list-chrome.tsx'
import { useRevealedErrors } from '#app/components/reservations/settings/use-revealed-errors.ts'
import { SelectField, TextField } from '#app/components/staff/controls.tsx'
import { SheetForm } from '#app/components/staff/sheet-frame.tsx'
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

const COLOR_TOKENS: ReadonlyArray<{
	token: string
	label: MessageDescriptor
}> = [
	{ token: '1', label: msg`Blue` },
	{ token: '2', label: msg`Green` },
	{ token: '3', label: msg`Amber` },
	{ token: '4', label: msg`Violet` },
	{ token: '5', label: msg`Pink` },
	{ token: '6', label: msg`Cyan` },
	{ token: '7', label: msg`Orange` },
	{ token: '8', label: msg`Lime` },
]

function nextSectionLetter(index: number) {
	return String.fromCharCode(65 + (index % 26))
}

type SheetState =
	{ mode: 'closed' } | { mode: 'create' } | { mode: 'edit'; layoutId: string }

export default function ReservationsSettingsSectionsRoute() {
	const { _ } = useLingui()
	const { selectedLocationId, canWrite, client } = useReservationsSetupContext()

	const makeInitialDraftSections = useCallback(
		(): DraftSectionRow[] => [
			{ name: _(msg`Section A`), colorToken: '1', tableIds: [] },
			{ name: _(msg`Section B`), colorToken: '2', tableIds: [] },
			{ name: _(msg`Patio`), colorToken: '3', tableIds: [] },
		],
		[_],
	)

	const [layouts, setLayouts] = useState<RsvSectionLayoutRecord[]>([])
	const [tables, setTables] = useState<TableDto[]>([])
	const [areas, setAreas] = useState<DiningAreaDto[]>([])
	const [services, setServices] = useState<ServicePeriodDto[]>([])
	const [loading, setLoading] = useState(true)
	const [loadFailed, setLoadFailed] = useState(false)
	const [saving, setSaving] = useState(false)
	const [errorMessage, setErrorMessage] = useState<string | null>(null)
	const [feedbackMessage, setFeedbackMessage] = useState<string | null>(null)

	const [sheet, setSheet] = useState<SheetState>({ mode: 'closed' })
	const [layoutName, setLayoutName] = useState('')
	const [layoutServiceId, setLayoutServiceId] = useState('')
	const [draftSections, setDraftSections] = useState<DraftSectionRow[]>([])
	// Derived on every render, revealed after a submit attempt or blur, so a
	// message goes away as soon as the value is valid.
	const liveFieldErrors: Partial<Record<'name' | 'sections', string>> = {}
	if (sheet.mode !== 'closed') {
		if (!layoutName.trim()) {
			liveFieldErrors.name = _(msg`Please enter a name for the section layout.`)
		}
		if (!draftSections.some((sec) => sec.name.trim().length > 0)) {
			liveFieldErrors.sections = _(
				msg`Add at least one named section to the layout.`,
			)
		}
	}
	const {
		errors: fieldErrors,
		attempt: attemptSubmit,
		touch: touchField,
		reset: resetFieldErrors,
	} = useRevealedErrors(liveFieldErrors)
	const [pendingDelete, setPendingDelete] =
		useState<RsvSectionLayoutRecord | null>(null)

	const loadAll = useCallback(async () => {
		if (!selectedLocationId) {
			setLoading(false)
			return
		}
		setLoading(true)
		setErrorMessage(null)
		setLoadFailed(false)
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
		} catch {
			// Plain copy only: the server's own wording is never shown here.
			setLoadFailed(true)
			setErrorMessage(
				_(msg`The section layouts for this location could not be loaded.`),
			)
		} finally {
			setLoading(false)
		}
	}, [client, selectedLocationId, _])

	useEffect(() => {
		void loadAll()
	}, [loadAll])

	const areaNameById = useMemo(() => {
		const map = new Map<string, string>()
		for (const area of areas) {
			map.set(area.id, area.name)
		}
		return map
	}, [areas])

	const serviceNameById = useMemo(() => {
		const map = new Map<string, string>()
		for (const svc of services) {
			map.set(svc.id, svc.name)
		}
		return map
	}, [services])

	const serviceOptions = useMemo(
		() => [
			{ value: '', label: _(msg`All services`) },
			...services.map((svc) => ({ value: svc.id, label: svc.name })),
		],
		[services, _],
	)

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

	const closeSheet = () => {
		setSheet({ mode: 'closed' })
		resetFieldErrors()
		setErrorMessage(null)
	}

	const openCreate = () => {
		setSheet({ mode: 'create' })
		setLayoutName('')
		setLayoutServiceId('')
		setDraftSections(makeInitialDraftSections())
		resetFieldErrors()
		setErrorMessage(null)
		setFeedbackMessage(null)
	}

	const openEdit = (layout: RsvSectionLayoutRecord) => {
		setSheet({ mode: 'edit', layoutId: layout.id })
		setLayoutName(layout.name)
		setLayoutServiceId(layout.serviceId ?? '')
		setDraftSections(
			layout.sections.map((sec, idx) => ({
				id: sec.id,
				name: sec.name,
				colorToken: sec.colorToken || String((idx % 8) + 1),
				tableIds: [...sec.tableIds],
			})),
		)
		resetFieldErrors()
		setErrorMessage(null)
		setFeedbackMessage(null)
	}

	const handleAddSection = () => {
		const nextIdx = draftSections.length
		const letter = nextSectionLetter(nextIdx)
		setDraftSections((prev) => [
			...prev,
			{
				name: _(msg`Section ${letter}`),
				colorToken: String((nextIdx % 8) + 1),
				tableIds: [],
			},
		])
	}

	const handleRemoveSection = (idx: number) => {
		setDraftSections((prev) => prev.filter((_s, i) => i !== idx))
	}

	const handleSubmit = async (event: FormEvent) => {
		event.preventDefault()
		if (!canWrite || saving || sheet.mode === 'closed') return

		if (!attemptSubmit()) return
		const trimmedName = layoutName.trim()
		const validSections = draftSections
			.map((sec, idx) => ({
				...(sec.id ? { id: sec.id } : {}),
				name: sec.name.trim(),
				colorToken: sec.colorToken || String((idx % 8) + 1),
				sort: idx,
				tableIds: sec.tableIds,
			}))
			.filter((sec) => sec.name.length > 0)

		setSaving(true)
		setErrorMessage(null)
		setFeedbackMessage(null)
		try {
			if (sheet.mode === 'create') {
				if (!selectedLocationId) return
				const created = await createSectionLayout(client, {
					locationId: selectedLocationId,
					name: trimmedName,
					serviceId: layoutServiceId || null,
					sections: validSections,
				})
				setLayouts((prev) => [...prev, created])
				const createdName = created.name
				setFeedbackMessage(_(msg`Section layout "${createdName}" created.`))
			} else {
				const layoutId = sheet.layoutId
				const updated = await updateSectionLayout(client, layoutId, {
					name: trimmedName,
					serviceId: layoutServiceId || null,
					sections: validSections,
				})
				setLayouts((prev) =>
					prev.map((item) => (item.id === layoutId ? updated : item)),
				)
				const updatedName = updated.name
				setFeedbackMessage(_(msg`Section layout "${updatedName}" updated.`))
			}
			setSheet({ mode: 'closed' })
		} catch (err) {
			setErrorMessage(
				extractApiErrorMessage(
					err,
					sheet.mode === 'create'
						? _(msg`Failed to create section layout.`)
						: _(msg`Failed to update section layout.`),
				),
			)
		} finally {
			setSaving(false)
		}
	}

	const handleConfirmDelete = async () => {
		const layout = pendingDelete
		if (!layout || !canWrite || saving) return
		setSaving(true)
		setErrorMessage(null)
		setFeedbackMessage(null)
		try {
			await deleteSectionLayout(client, layout.id)
			setLayouts((prev) => prev.filter((item) => item.id !== layout.id))
			const deletedName = layout.name
			setFeedbackMessage(_(msg`Section layout "${deletedName}" deleted.`))
		} catch (err) {
			setErrorMessage(
				extractApiErrorMessage(err, _(msg`Failed to delete section layout.`)),
			)
		} finally {
			setSaving(false)
			setPendingDelete(null)
		}
	}

	const sheetOpen = sheet.mode !== 'closed'
	// While the sheet is open it covers the page, so the error shows inside it.
	const sheetError = sheetOpen ? errorMessage : null
	const pageError = sheetOpen ? null : errorMessage
	const dirty = useSheetDirty(
		sheet.mode === 'closed'
			? null
			: sheet.mode === 'edit'
				? `edit:${sheet.layoutId}`
				: 'create',
		[layoutName, layoutServiceId, draftSections],
	)
	const { requestClose, discardDialog } = useDiscardGuard(dirty, closeSheet)

	// Map tableId -> section index & name for showing ownership and preventing duplicates
	const ownerByTableId = new Map<string, { idx: number; name: string }>()
	draftSections.forEach((sec, idx) => {
		for (const tid of sec.tableIds) {
			ownerByTableId.set(tid, { idx, name: sec.name || `#${idx + 1}` })
		}
	})
	const prefix = sheet.mode === 'edit' ? 'edit' : 'create'

	return (
		<div
			className="flex flex-col gap-6"
			data-testid="reservations-settings-sections-page"
		>
			<SetupNotices
				errorMessage={pageError}
				errorTestId="sections-error-banner"
				onDismissError={() => setErrorMessage(null)}
				onRetry={loadFailed ? () => void loadAll() : undefined}
				feedbackMessage={feedbackMessage}
				feedbackTestId="sections-feedback-banner"
				onDismissFeedback={() => setFeedbackMessage(null)}
			/>

			<Frame className="w-full" data-testid="saved-section-layouts-card">
				<FrameHeader>
					<FrameTitle className="font-medium">
						<Trans>Server sections</Trans>
					</FrameTitle>
					<FrameDescription>
						<Trans>
							Split your tables into colored sections, one per server. Hosts see
							them on the floor and can seat guests by section.
						</Trans>
					</FrameDescription>
					{canWrite ? (
						<FrameAction>
							<Button
								type="button"
								size="sm"
								onClick={openCreate}
								data-testid="section-layout-open-create"
							>
								<Icon name="plus" className="size-4" />
								<Trans>New layout</Trans>
							</Button>
						</FrameAction>
					) : null}
				</FrameHeader>

				{loading ? (
					<div
						className="flex flex-col gap-2 border-t p-4"
						data-testid="section-layouts-loading"
						role="status"
					>
						<span className="sr-only">
							<Trans>Loading section layouts…</Trans>
						</span>
						<Skeleton className="h-10 w-full" />
						<Skeleton className="h-10 w-full" />
					</div>
				) : layouts.length === 0 ? (
					<div className="border-t p-4" data-testid="section-layouts-empty">
						<EmptyState
							icons={['layout-grid']}
							title={<Trans>No section layouts yet</Trans>}
							description={
								<Trans>
									Create a layout to give each server their own group of tables.
								</Trans>
							}
						>
							{canWrite ? (
								<Button type="button" size="sm" onClick={openCreate}>
									<Icon name="plus" className="size-4" />
									<Trans>New layout</Trans>
								</Button>
							) : null}
						</EmptyState>
					</div>
				) : (
					<div data-testid="section-layouts-list">
						<Table variant="card">
							<TableHeader>
								<TableRow>
									<TableHead>
										<Trans>Layout</Trans>
									</TableHead>
									<TableHead>
										<Trans>Service</Trans>
									</TableHead>
									<TableHead>
										<Trans>Sections</Trans>
									</TableHead>
									<TableHead className="text-end">
										<span className="sr-only">
											<Trans>Actions</Trans>
										</span>
									</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{layouts.map((layout) => (
									<TableRow
										key={layout.id}
										data-testid={`section-layout-card-${layout.id}`}
										data-layout-name={layout.name}
										className={canWrite ? 'cursor-pointer' : undefined}
										onClick={canWrite ? () => openEdit(layout) : undefined}
									>
										<TableCell className="font-medium wrap-anywhere">
											{layout.name}
										</TableCell>
										<TableCell className="text-muted-foreground">
											{layout.serviceId
												? (serviceNameById.get(layout.serviceId) ?? '—')
												: _(msg`All services`)}
										</TableCell>
										<TableCell>
											<div className="flex flex-wrap items-center gap-x-4 gap-y-1">
												{layout.sections.map((sec) => {
													const tableCount = sec.tableIds.length
													return (
														<span
															key={sec.id}
															className="flex items-center gap-1.5 text-sm"
															data-testid={`saved-section-item-${sec.id}`}
														>
															<span
																className="inline-block size-2.5 shrink-0 rounded-full"
																style={{
																	backgroundColor: resolveSectionColorHex(
																		sec.colorToken,
																	),
																}}
																aria-hidden="true"
															/>
															<span>{sec.name}</span>
															<span className="text-muted-foreground text-xs">
																<Plural
																	value={tableCount}
																	one="# table"
																	other="# tables"
																/>
															</span>
														</span>
													)
												})}
											</div>
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
															openEdit(layout)
														}}
														data-testid={`section-layout-edit-${layout.id}`}
													>
														<Icon name="pencil" className="size-3.5" />
														<Trans>Edit</Trans>
													</Button>
													<Button
														type="button"
														variant="ghost"
														size="icon-sm"
														aria-label={_(msg`Delete layout`)}
														disabled={saving}
														onClick={(event) => {
															event.stopPropagation()
															setPendingDelete(layout)
														}}
														data-testid={`section-layout-delete-${layout.id}`}
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
					</div>
				)}
			</Frame>

			<EditSheet open={sheetOpen} onClose={requestClose} wide>
				<SheetForm
					title={
						sheet.mode === 'edit' ? (
							<Trans>Edit section layout</Trans>
						) : (
							<Trans>New section layout</Trans>
						)
					}
					description={
						<Trans>
							Each table belongs to at most one section. Choosing a table that
							is in another section moves it here.
						</Trans>
					}
					onSubmit={(event) => void handleSubmit(event)}
					footer={
						<>
							<Button
								type="button"
								variant="outline"
								onClick={requestClose}
								data-testid="section-layout-cancel-edit"
							>
								<Trans>Cancel</Trans>
							</Button>
							<Button
								type="submit"
								disabled={saving || !canWrite}
								data-testid={
									sheet.mode === 'edit'
										? 'section-layout-save-edit'
										: 'section-layout-create-submit'
								}
							>
								{saving ? (
									<Trans>Saving…</Trans>
								) : sheet.mode === 'edit' ? (
									<Trans>Save changes</Trans>
								) : (
									<Trans>Create layout</Trans>
								)}
							</Button>
						</>
					}
				>
					<SetupNotices
						errorMessage={sheetError}
						errorTestId="sections-error-banner"
					/>
					<div
						data-testid={`section-layout-edit-form-${sheet.mode === 'edit' ? sheet.layoutId : 'new'}`}
						className="flex flex-col gap-5"
					>
						<TextField
							label={<Trans>Layout name</Trans>}
							placeholder={_(msg`e.g. Dinner 3-server`)}
							value={layoutName}
							disabled={!canWrite || saving}
							error={fieldErrors.name}
							onBlur={() => touchField('name')}
							onChange={(e) => setLayoutName(e.target.value)}
							data-testid={
								sheet.mode === 'edit'
									? 'edit-section-layout-name-input'
									: 'section-layout-name-input'
							}
						/>
						<SelectField
							label={<Trans>Applies to</Trans>}
							hint={
								<Trans>
									Pick a service to use this layout only during that service.
								</Trans>
							}
							options={serviceOptions}
							value={layoutServiceId}
							disabled={!canWrite || saving}
							onValueChange={setLayoutServiceId}
						/>

						<div className="flex items-center justify-between gap-3">
							<h3 className="text-sm font-medium">
								<Trans>Sections</Trans>
							</h3>
							{canWrite ? (
								<Button
									type="button"
									variant="outline"
									size="sm"
									onClick={handleAddSection}
									data-testid={`${prefix}-section-layout-add-section`}
								>
									<Icon name="plus" className="size-3.5" />
									<Trans>Add section</Trans>
								</Button>
							) : null}
						</div>

						{fieldErrors.sections ? (
							<FieldError>{fieldErrors.sections}</FieldError>
						) : null}
						<div className="flex flex-col gap-3">
							{draftSections.map((sec, idx) => (
								<div
									key={sec.id ?? `draft-${idx}`}
									className="bg-muted/20 flex flex-col gap-3 rounded-lg border p-3"
									data-testid={`${prefix}-section-row-${idx}`}
								>
									<div className="flex items-end gap-2">
										<TextField
											className="min-w-0 flex-1"
											label={<Trans>Section name</Trans>}
											value={sec.name}
											disabled={!canWrite}
											placeholder={_(msg`e.g. Section A`)}
											onChange={(e) => {
												const val = e.target.value
												setDraftSections((prev) =>
													prev.map((item, i) =>
														i === idx ? { ...item, name: val } : item,
													),
												)
											}}
											data-testid={`${prefix}-section-name-input-${idx}`}
										/>
										{canWrite && draftSections.length > 1 ? (
											<Button
												type="button"
												variant="ghost"
												size="icon"
												aria-label={_(msg`Remove section`)}
												onClick={() => handleRemoveSection(idx)}
												data-testid={`${prefix}-section-remove-${idx}`}
											>
												<Icon name="trash-2" className="size-4" />
											</Button>
										) : null}
									</div>

									<div
										className="flex flex-wrap items-center gap-2"
										role="group"
										aria-label={_(msg`Section color`)}
									>
										{COLOR_TOKENS.map((ct) => {
											const isSelected = sec.colorToken === ct.token
											const colorName = _(ct.label)
											return (
												<button
													key={ct.token}
													type="button"
													disabled={!canWrite}
													aria-pressed={isSelected}
													onClick={() => {
														setDraftSections((prev) =>
															prev.map((item, i) =>
																i === idx
																	? { ...item, colorToken: ct.token }
																	: item,
															),
														)
													}}
													title={colorName}
													aria-label={colorName}
													data-testid={`${prefix}-section-color-token-${idx}-${ct.token}`}
													className={cn(
														'focus-visible:ring-ring size-6 rounded-full border transition-shadow focus-visible:ring-2 focus-visible:outline-none',
														isSelected &&
															'ring-foreground ring-offset-background ring-2 ring-offset-2',
													)}
													style={{
														backgroundColor: resolveSectionColorHex(ct.token),
													}}
												/>
											)
										})}
									</div>

									<div className="flex flex-col gap-1.5">
										<span className="text-muted-foreground text-xs">
											<Trans>Tables in this section</Trans>
										</span>
										<div className="flex flex-wrap items-center gap-1.5">
											{tables.length === 0 ? (
												<span className="text-muted-foreground text-xs">
													<Trans>
														No active tables yet. Add tables under Floor first.
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
														<Button
															key={table.id}
															type="button"
															variant="outline"
															size="sm"
															disabled={!canWrite}
															aria-pressed={isAssignedHere}
															onClick={() => {
																setDraftSections((prev) =>
																	toggleTableInSections(prev, idx, table.id),
																)
															}}
															data-testid={`${prefix}-section-table-toggle-${idx}-${table.id}`}
															data-table-label={table.label}
															className={cn(
																isAssignedHere &&
																	'border-primary bg-primary/10',
																isAssignedElsewhere && 'text-muted-foreground',
															)}
														>
															{isAssignedHere ? (
																<Icon name="check" className="size-3.5" />
															) : null}
															<span>{table.label}</span>
															{areaName ? (
																<span className="text-muted-foreground text-xs font-normal">
																	{areaName}
																</span>
															) : null}
															{isAssignedElsewhere && owner ? (
																<Badge variant="secondary">{owner.name}</Badge>
															) : null}
														</Button>
													)
												})
											)}
										</div>
									</div>
								</div>
							))}
						</div>
					</div>
				</SheetForm>
			</EditSheet>

			{discardDialog}

			<ConfirmDialog
				open={pendingDelete !== null}
				onClose={() => setPendingDelete(null)}
				title={<Trans>Delete this layout?</Trans>}
				description={
					<Trans>
						The layout and its sections are removed. Reservations are not
						changed.
					</Trans>
				}
				cancelLabel={<Trans>Keep it</Trans>}
				confirmLabel={saving ? <Trans>Deleting…</Trans> : <Trans>Delete</Trans>}
				pending={saving}
				onConfirm={() => void handleConfirmDelete()}
				confirmTestId="section-layout-confirm-delete"
			/>
		</div>
	)
}

export function ErrorBoundary() {
	return <GeneralErrorBoundary />
}
