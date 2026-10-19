import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import { Alert, AlertDescription } from '@repo/ui/alert'
import {
	AlertDialog,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from '@repo/ui/alert-dialog'
import { Button } from '@repo/ui/button'
import {
	Frame,
	FrameAction,
	FrameDescription,
	FrameHeader,
	FramePanel,
	FrameTitle,
} from '@repo/ui/frame'
import { Icon } from '@repo/ui/icon'
import { PageHeader } from '@repo/ui/page-header'
import { Skeleton } from '@repo/ui/skeleton'
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '@repo/ui/table'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { EmptyState } from '#app/components/empty-state.tsx'
import { ScheduleSheet } from '#app/components/reservations/experiences/schedule-sheet.tsx'
import { useRevealedErrors } from '#app/components/reservations/settings/use-revealed-errors.ts'
import {
	type Option,
	SelectField,
	TextAreaField,
	TextField,
} from '#app/components/staff/controls.tsx'
import { PageWithBack } from '#app/components/staff/page-back.tsx'
import { SwitchField } from '#app/components/staff/switch-field.tsx'
import {
	useConfirmBlocker,
	useDirtyBeforeUnload,
} from '#app/utils/navigation-guards.ts'
import {
	createSchedule,
	deleteSchedule,
	EXPERIENCE_KINDS,
	EXPERIENCE_LOCALES,
	type ExperienceContext,
	type ExperienceDto,
	type ExperienceKind,
	type ExperienceLocale,
	type ExperienceScheduleDto,
	type ExperienceTransition,
	experienceSchema,
	fetchExperience,
	fetchExperienceContext,
	transitionExperience,
	updateExperience,
	updateSchedule,
} from '#app/utils/reservations/experiences-api.ts'
import {
	conflictCurrent,
	EXPERIENCE_KIND_LABELS,
	EXPERIENCE_LOCALE_LABELS,
	EXPERIENCE_STATUS_LABELS,
	experienceErrorMessages,
	experienceErrorStatus,
	experienceFormToInput,
	experiencePatch,
	experienceToForm,
	type ExperienceFormErrors,
	type ExperienceFormValues,
	formatCalendarDate,
	maskToDays,
	MASK_WEEKDAYS,
	pickExperienceText,
	seatingSummary,
} from '#app/utils/reservations/experiences-view.ts'
import { formatMoney } from '#app/utils/reservations/payments-view.ts'
import { type ReservationsScopedClient } from '#app/utils/reservations/reservations-client.ts'

const NO_POLICY = '__none__'

type Loaded = {
	experience: ExperienceDto
	/** The experience the draft started from; the save sends only the diff. */
	base: ExperienceDto
	context: ExperienceContext
}

type LoadState =
	| { status: 'loading' }
	| { status: 'denied' }
	| { status: 'missing' }
	| { status: 'failed' }
	| ({ status: 'ready' } & Loaded)

/**
 * Edit one experience: names and descriptions in every language, price,
 * policy, party size and capacity behaviour, and its schedules. The details are
 * a local draft with an explicit Save; schedules save from their own sheet.
 * Every write sends the latest version, and a conflict keeps the draft and
 * offers to load the other version or save over it.
 */
export function ExperienceEditor({
	client,
	locationId,
	experienceId,
	listHref,
	canWrite,
	paymentsEnabled,
	today,
}: {
	client: ReservationsScopedClient
	locationId: string
	experienceId: string
	listHref: string
	canWrite: boolean
	paymentsEnabled: boolean
	/** Business date today at this location; the default for a new schedule. */
	today: string
}) {
	const { t, i18n } = useLingui()
	const [state, setState] = useState<LoadState>({ status: 'loading' })
	const [form, setForm] = useState<ExperienceFormValues | null>(null)
	// Derived from the draft on every render and revealed after a save attempt,
	// so a message goes away as soon as the value is valid.
	const liveCurrency = state.status === 'ready' ? state.experience.currency : ''
	const liveParsed = useMemo(
		() => (form ? experienceFormToInput(form, liveCurrency) : null),
		[form, liveCurrency],
	)
	const { errors, attempt } = useRevealedErrors<
		keyof ExperienceFormErrors,
		MessageDescriptor
	>(liveParsed && !liveParsed.ok ? liveParsed.errors : {})
	const [banner, setBanner] = useState<string[]>([])
	const [conflict, setConflict] = useState<ExperienceDto | null>(null)
	const [busy, setBusy] = useState(false)
	const [textLocale, setTextLocale] = useState<ExperienceLocale>(
		(i18n.locale === 'ar' ? 'ar' : 'en') as ExperienceLocale,
	)
	const [sheet, setSheet] = useState<
		{ mode: 'create' } | { mode: 'edit'; id: string } | null
	>(null)
	const [removing, setRemoving] = useState<ExperienceScheduleDto | null>(null)
	const [archiveOpen, setArchiveOpen] = useState(false)
	const requestId = useRef(0)

	const load = useCallback(
		async (signal?: AbortSignal) => {
			const current = (requestId.current += 1)
			try {
				const [experience, context] = await Promise.all([
					fetchExperience(client, locationId, experienceId, signal),
					fetchExperienceContext(
						client,
						locationId,
						{ withPolicies: paymentsEnabled },
						signal,
					),
				])
				if (current !== requestId.current) return
				setState({ status: 'ready', experience, base: experience, context })
				setForm(experienceToForm(experience))
			} catch (error) {
				if (signal?.aborted || current !== requestId.current) return
				const status = experienceErrorStatus(error)
				setState({
					status:
						status === 403 ? 'denied' : status === 404 ? 'missing' : 'failed',
				})
			}
		},
		[client, locationId, experienceId, paymentsEnabled],
	)

	useEffect(() => {
		const controller = new AbortController()
		setState({ status: 'loading' })
		void load(controller.signal)
		return () => controller.abort()
	}, [load])

	const ready = state.status === 'ready' ? state : null
	const dirty = Boolean(
		ready &&
		form &&
		JSON.stringify(form) !== JSON.stringify(experienceToForm(ready.base)),
	)
	useDirtyBeforeUnload(dirty)
	useConfirmBlocker(
		dirty,
		t`You have unsaved changes to this experience. Leave without saving?`,
	)

	const kindOptions: Option[] = useMemo(
		() =>
			EXPERIENCE_KINDS.map((value) => ({
				value,
				label: i18n._(EXPERIENCE_KIND_LABELS[value]),
			})),
		[i18n],
	)
	const localeOptions: Option[] = useMemo(
		() =>
			EXPERIENCE_LOCALES.map((value) => ({
				value,
				label: i18n._(EXPERIENCE_LOCALE_LABELS[value]),
			})),
		[i18n],
	)
	const policyOptions: Option[] = useMemo(
		() => [
			{ value: NO_POLICY, label: i18n._(msg`No payment policy`) },
			...(ready?.context.policies ?? []).map((policy) => ({
				value: policy.id,
				label: policy.name,
			})),
		],
		[ready?.context.policies, i18n],
	)

	if (state.status === 'loading' || (state.status === 'ready' && !form)) {
		return (
			<div className="flex flex-col gap-4" data-testid="experience-loading">
				<Skeleton className="h-8 w-64" />
				<Skeleton className="h-40 w-full" />
				<Skeleton className="h-40 w-full" />
			</div>
		)
	}
	if (state.status !== 'ready' || !form) {
		return (
			<PageWithBack to={listHref} label={t`Experiences`}>
				<Alert variant="destructive" data-testid={`experience-${state.status}`}>
					<AlertDescription>
						<div className="flex flex-wrap items-center gap-3">
							{state.status === 'denied' ? (
								<Trans>You do not have access to this experience.</Trans>
							) : state.status === 'missing' ? (
								<Trans>This experience no longer exists.</Trans>
							) : (
								<>
									<Trans>The experience could not be loaded.</Trans>
									<Button
										type="button"
										size="sm"
										variant="outline"
										onClick={() => {
											setState({ status: 'loading' })
											void load()
										}}
									>
										<Trans>Try again</Trans>
									</Button>
								</>
							)}
						</div>
					</AlertDescription>
				</Alert>
			</PageWithBack>
		)
	}

	const { experience, base, context } = state
	const archived = experience.status === 'archived'
	const editable = canWrite && !archived
	const currency = experience.currency
	const message = (field: keyof ExperienceFormErrors) =>
		errors[field] ? i18n._(errors[field]!) : null

	const set = <K extends keyof ExperienceFormValues>(
		key: K,
		value: ExperienceFormValues[K],
	) => setForm((current) => (current ? { ...current, [key]: value } : current))

	function adopt(next: ExperienceDto, options: { keepDraft?: boolean } = {}) {
		setState((current) =>
			current.status === 'ready'
				? {
						...current,
						experience: next,
						base: options.keepDraft ? current.base : next,
					}
				: current,
		)
		if (!options.keepDraft) setForm(experienceToForm(next))
	}

	/** After a failed write: show why, and keep the version in step with the region. */
	function fail(error: unknown, fallback: MessageDescriptor) {
		const current = experienceSchema.safeParse(conflictCurrent(error))
		if (current.success) {
			// Keep the draft; only the version and schedules follow the region.
			setState((previous) =>
				previous.status === 'ready'
					? { ...previous, experience: current.data }
					: previous,
			)
		}
		return experienceErrorMessages(
			error,
			(descriptor) => i18n._(descriptor),
			fallback,
		)
	}

	async function saveDetails() {
		if (!form) return
		const parsed = experienceFormToInput(form, currency)
		attempt()
		setBanner([])
		if (!parsed.ok) return
		const patch = experiencePatch(base, parsed.input, experience.version)
		if (!patch) return
		setBusy(true)
		try {
			const saved = await updateExperience(
				client,
				locationId,
				experience.id,
				patch,
			)
			setConflict(null)
			adopt(saved)
			toast.success(t`Experience saved.`)
		} catch (error) {
			const current = experienceSchema.safeParse(conflictCurrent(error))
			if (current.success) setConflict(current.data)
			setBanner(fail(error, msg`The experience could not be saved. Try again.`))
		} finally {
			setBusy(false)
		}
	}

	async function transition(action: ExperienceTransition) {
		setBusy(true)
		setBanner([])
		try {
			const next = await transitionExperience(
				client,
				locationId,
				experience.id,
				action,
				experience.version,
			)
			setArchiveOpen(false)
			adopt(next, { keepDraft: dirty })
			toast.success(
				action === 'publish'
					? t`Experience published.`
					: action === 'unpublish'
						? t`Experience moved back to draft.`
						: t`Experience archived.`,
			)
		} catch (error) {
			setArchiveOpen(false)
			setBanner(fail(error, msg`That did not work. Try again.`))
			if (experienceErrorStatus(error) === 404) await load()
		} finally {
			setBusy(false)
		}
	}

	/** Resolves to sentences for the sheet when the save failed, or null. */
	async function saveSchedule(
		body: Parameters<typeof createSchedule>[3],
	): Promise<string[] | null> {
		try {
			const next =
				sheet?.mode === 'edit'
					? await updateSchedule(
							client,
							locationId,
							experience.id,
							sheet.id,
							body,
							experience.version,
						)
					: await createSchedule(
							client,
							locationId,
							experience.id,
							body,
							experience.version,
						)
			adopt(next, { keepDraft: true })
			setSheet(null)
			toast.success(t`Schedule saved.`)
			return null
		} catch (error) {
			// The version follows the region, so saving again works after a conflict.
			return fail(error, msg`The schedule could not be saved. Try again.`)
		}
	}

	async function removeSchedule() {
		if (!removing) return
		setBusy(true)
		try {
			const next = await deleteSchedule(
				client,
				locationId,
				experience.id,
				removing.id,
				experience.version,
			)
			adopt(next, { keepDraft: true })
			setRemoving(null)
			toast.success(t`Schedule removed.`)
		} catch (error) {
			setRemoving(null)
			setBanner(fail(error, msg`The schedule could not be removed. Try again.`))
		} finally {
			setBusy(false)
		}
	}

	const editingSchedule =
		sheet?.mode === 'edit'
			? (experience.schedules.find((schedule) => schedule.id === sheet.id) ??
				null)
			: null

	const name =
		pickExperienceText(experience.nameI18n, i18n.locale) || experience.slug
	const statusLabel = i18n._(EXPERIENCE_STATUS_LABELS[experience.status])

	function daysText(mask: number): string {
		if (mask === 127) return t`Every day`
		return maskToDays(mask)
			.map((on, bit) => (on ? i18n._(MASK_WEEKDAYS[bit]!.short) : null))
			.filter(Boolean)
			.join(', ')
	}

	function restrictionsText(schedule: ExperienceScheduleDto): string {
		const parts: string[] = []
		if (schedule.areaIds?.length) {
			parts.push(
				schedule.areaIds
					.map(
						(id) => context.areas.find((area) => area.id === id)?.name ?? '…',
					)
					.join(', '),
			)
		}
		if (schedule.serviceId) {
			parts.push(
				context.services.find((service) => service.id === schedule.serviceId)
					?.name ?? '…',
			)
		}
		return parts.length > 0 ? parts.join(' · ') : '—'
	}

	function limitsText(schedule: ExperienceScheduleDto): string {
		const parts: string[] = []
		if (schedule.coversCapPerSeating !== null) {
			const cap = i18n.number(schedule.coversCapPerSeating)
			parts.push(t`${cap} per seating`)
		}
		if (schedule.coversCapPerDay !== null) {
			const cap = i18n.number(schedule.coversCapPerDay)
			parts.push(t`${cap} per day`)
		}
		return parts.length > 0 ? parts.join(' · ') : '—'
	}

	const primaryIsSave = dirty && editable
	const priceHint = experience.priceMinor
		? formatMoney(experience.priceMinor, currency, i18n.locale)
		: null

	return (
		<div className="flex flex-col gap-6" data-testid="experience-editor">
			<PageWithBack to={listHref} label={t`Experiences`}>
				<PageHeader
					title={<span className="wrap-anywhere">{name}</span>}
					description={
						<span className="inline-flex items-center gap-2">
							<span
								aria-hidden="true"
								className={
									experience.status === 'published'
										? 'bg-success size-1.5 rounded-full'
										: 'bg-muted-foreground/60 size-1.5 rounded-full'
								}
							/>
							<span data-testid="experience-status">{statusLabel}</span>
							{dirty ? (
								<span className="text-muted-foreground">
									· <Trans>Unsaved changes</Trans>
								</span>
							) : null}
						</span>
					}
					actions={
						editable ? (
							<>
								{experience.status === 'draft' ? (
									<Button
										type="button"
										variant={primaryIsSave ? 'outline' : 'default'}
										disabled={busy || dirty}
										title={dirty ? t`Save your changes first.` : undefined}
										onClick={() => void transition('publish')}
										data-testid="experience-publish"
									>
										<Trans>Publish</Trans>
									</Button>
								) : (
									<Button
										type="button"
										variant="outline"
										disabled={busy || dirty}
										onClick={() => void transition('unpublish')}
										data-testid="experience-unpublish"
									>
										<Trans>Move to draft</Trans>
									</Button>
								)}
								<Button
									type="button"
									variant="outline"
									disabled={busy}
									onClick={() => setArchiveOpen(true)}
									data-testid="experience-archive"
								>
									<Trans>Archive</Trans>
								</Button>
								<Button
									type="button"
									variant={primaryIsSave ? 'default' : 'outline'}
									disabled={busy || !dirty}
									onClick={() => void saveDetails()}
									data-testid="experience-save"
								>
									{busy ? <Trans>Saving…</Trans> : <Trans>Save changes</Trans>}
								</Button>
							</>
						) : null
					}
				/>
			</PageWithBack>

			{archived ? (
				<Alert data-testid="experience-archived">
					<AlertDescription>
						<Trans>
							This experience is archived. It is not shown to guests and cannot
							be changed.
						</Trans>
					</AlertDescription>
				</Alert>
			) : null}

			{conflict ? (
				<Alert variant="destructive" data-testid="experience-conflict">
					<AlertDescription>
						<div className="flex flex-col gap-3">
							<span>
								<Trans>
									Someone else changed this experience while you were editing.
									Your edits are still here.
								</Trans>
							</span>
							<span className="flex flex-wrap gap-2">
								<Button
									type="button"
									size="sm"
									variant="outline"
									onClick={() => {
										adopt(conflict)
										setConflict(null)
										setBanner([])
									}}
									data-testid="experience-use-theirs"
								>
									<Trans>Use their version</Trans>
								</Button>
								<Button
									type="button"
									size="sm"
									onClick={() => {
										setConflict(null)
										setBanner([])
										void saveDetails()
									}}
									data-testid="experience-keep-mine"
								>
									<Trans>Save my changes on top</Trans>
								</Button>
							</span>
						</div>
					</AlertDescription>
				</Alert>
			) : null}

			{banner.length > 0 && !conflict ? (
				<Alert variant="destructive" data-testid="experience-error">
					<AlertDescription>{banner.join(' ')}</AlertDescription>
				</Alert>
			) : null}

			<Frame>
				<FrameHeader>
					<FrameTitle className="font-medium">
						<Trans>Details</Trans>
					</FrameTitle>
					<FrameDescription>
						<Trans>What guests read on your website.</Trans>
					</FrameDescription>
				</FrameHeader>
				<FramePanel className="flex flex-col gap-5">
					<SelectField
						label={<Trans>Language to edit</Trans>}
						hint={
							<Trans>
								Add the name and description in each language your guests use.
								Guests see the closest language you filled in.
							</Trans>
						}
						value={textLocale}
						options={localeOptions}
						onValueChange={(value) => setTextLocale(value as ExperienceLocale)}
						disabled={!editable}
						id="experience-text-locale"
					/>
					<TextField
						label={<Trans>Name</Trans>}
						value={form.names[textLocale] ?? ''}
						onChange={(event) =>
							set('names', { ...form.names, [textLocale]: event.target.value })
						}
						maxLength={140}
						disabled={!editable}
						error={message('name')}
						dir={textLocale === 'ar' ? 'rtl' : 'ltr'}
						data-testid="experience-name"
					/>
					<TextAreaField
						label={<Trans>Description</Trans>}
						optional
						value={form.descriptions[textLocale] ?? ''}
						onChange={(event) =>
							set('descriptions', {
								...form.descriptions,
								[textLocale]: event.target.value,
							})
						}
						maxLength={4000}
						rows={5}
						disabled={!editable}
						dir={textLocale === 'ar' ? 'rtl' : 'ltr'}
						data-testid="experience-description"
					/>
					<TextField
						label={<Trans>Link name</Trans>}
						hint={
							<Trans>
								Used in the web address of the page. Lowercase letters, numbers
								and dashes.
							</Trans>
						}
						value={form.slug}
						onChange={(event) => set('slug', event.target.value)}
						maxLength={64}
						disabled={!editable}
						error={message('slug')}
						dir="ltr"
						data-testid="experience-slug"
					/>
					<SelectField
						label={<Trans>Type</Trans>}
						value={form.kind}
						options={kindOptions}
						onValueChange={(value) => set('kind', value as ExperienceKind)}
						disabled={!editable}
						id="experience-kind"
					/>
					<TextField
						label={<Trans>Image link</Trans>}
						optional
						type="url"
						inputMode="url"
						value={form.imageUrl}
						onChange={(event) => set('imageUrl', event.target.value)}
						disabled={!editable}
						error={message('imageUrl')}
						dir="ltr"
						data-testid="experience-image"
					/>
				</FramePanel>
			</Frame>

			<Frame>
				<FrameHeader>
					<FrameTitle className="font-medium">
						<Trans>Pricing</Trans>
					</FrameTitle>
					<FrameDescription>
						<Trans>
							Guests pay the price, plus any terms from the payment policy, when
							they book.
						</Trans>
					</FrameDescription>
				</FrameHeader>
				<FramePanel className="flex flex-col gap-5">
					<TextField
						label={<Trans>Price ({currency})</Trans>}
						optional
						inputMode="decimal"
						value={form.price}
						onChange={(event) => set('price', event.target.value)}
						disabled={!editable}
						hint={
							priceHint ? (
								<Trans>Saved price: {priceHint}</Trans>
							) : (
								<Trans>Leave empty for a free experience.</Trans>
							)
						}
						error={message('price')}
						data-testid="experience-price"
					/>
					<SwitchField
						label={<Trans>Price is per guest</Trans>}
						description={
							<Trans>
								Off: one price for the whole booking. On: the price is
								multiplied by the party size.
							</Trans>
						}
						checked={form.pricePerCover}
						onCheckedChange={(value) => set('pricePerCover', value)}
						disabled={!editable}
					/>
					{paymentsEnabled ? (
						<SelectField
							label={<Trans>Payment policy</Trans>}
							hint={
								<Trans>
									A prepayment or deposit policy makes guests pay to book. Its
									cancellation terms apply to this experience.
								</Trans>
							}
							value={form.policyId || NO_POLICY}
							options={policyOptions}
							onValueChange={(value) =>
								set('policyId', value === NO_POLICY ? '' : value)
							}
							disabled={!editable}
							id="experience-policy"
						/>
					) : (
						<p className="text-muted-foreground text-sm">
							<Trans>
								Online payments are off, so guests book without paying. Turn
								payments on to take prepayment for this experience.
							</Trans>
						</p>
					)}
				</FramePanel>
			</Frame>

			<Frame>
				<FrameHeader>
					<FrameTitle className="font-medium">
						<Trans>Party size and capacity</Trans>
					</FrameTitle>
				</FrameHeader>
				<FramePanel className="flex flex-col gap-5">
					<div className="grid gap-4 sm:grid-cols-2">
						<TextField
							label={<Trans>Smallest party</Trans>}
							inputMode="numeric"
							value={form.partyMin}
							onChange={(event) => set('partyMin', event.target.value)}
							disabled={!editable}
							error={message('partyMin')}
							data-testid="experience-party-min"
						/>
						<TextField
							label={<Trans>Largest party</Trans>}
							inputMode="numeric"
							value={form.partyMax}
							onChange={(event) => set('partyMax', event.target.value)}
							disabled={!editable}
							error={message('partyMax')}
							data-testid="experience-party-max"
						/>
					</div>
					<SwitchField
						label={<Trans>Uses tables</Trans>}
						description={
							<Trans>
								On: bookings take real tables, limited to the areas you choose
								on each schedule. Off: only the guest limits below apply.
							</Trans>
						}
						checked={form.usesTables}
						onCheckedChange={(value) => set('usesTables', value)}
						disabled={!editable}
					/>
					<SwitchField
						label={<Trans>Exclusive seating</Trans>}
						description={
							<Trans>
								Regular bookings are not offered during an exclusive seating, so
								the whole room serves the experience.
							</Trans>
						}
						checked={form.exclusive}
						onCheckedChange={(value) => set('exclusive', value)}
						disabled={!editable}
					/>
					<TextField
						label={<Trans>Order in lists</Trans>}
						hint={<Trans>Lower numbers come first.</Trans>}
						inputMode="numeric"
						value={form.sort}
						onChange={(event) => set('sort', event.target.value)}
						disabled={!editable}
						error={message('sort')}
					/>
				</FramePanel>
			</Frame>

			<Frame data-testid="experience-schedules">
				<FrameHeader>
					<FrameTitle className="font-medium">
						<Trans>Schedules</Trans>
					</FrameTitle>
					<FrameDescription>
						<Trans>
							When it runs. To change the seatings on certain dates, add a
							schedule limited to those dates.
						</Trans>
					</FrameDescription>
					{editable ? (
						<FrameAction>
							<Button
								type="button"
								variant="outline"
								onClick={() => setSheet({ mode: 'create' })}
								data-testid="schedule-add"
							>
								<Icon name="plus" />
								<Trans>Add schedule</Trans>
							</Button>
						</FrameAction>
					) : null}
				</FrameHeader>
				{experience.schedules.length === 0 ? (
					<FramePanel data-testid="schedules-empty">
						<EmptyState
							icons={['calendar', 'clock', 'users']}
							title={<Trans>No schedules yet</Trans>}
							description={
								<Trans>
									Add the days and times guests can book. Guests cannot book
									this experience until it has a schedule.
								</Trans>
							}
							className="border-0 bg-transparent"
						>
							{editable ? (
								<Button
									type="button"
									onClick={() => setSheet({ mode: 'create' })}
								>
									<Icon name="plus" />
									<Trans>Add schedule</Trans>
								</Button>
							) : null}
						</EmptyState>
					</FramePanel>
				) : (
					<Table variant="card" data-testid="schedules-table">
						<TableHeader>
							<TableRow>
								<TableHead>
									<Trans>Dates</Trans>
								</TableHead>
								<TableHead>
									<Trans>Days</Trans>
								</TableHead>
								<TableHead>
									<Trans>Seatings</Trans>
								</TableHead>
								<TableHead>
									<Trans>Limits</Trans>
								</TableHead>
								<TableHead>
									<Trans>Restricted to</Trans>
								</TableHead>
								<TableHead className="w-28 text-end">
									<span className="sr-only">
										<Trans>Actions</Trans>
									</span>
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{experience.schedules.map((schedule) => {
								const from = formatCalendarDate(schedule.fromDate, i18n.locale)
								const to = formatCalendarDate(schedule.toDate, i18n.locale)
								return (
									<TableRow key={schedule.id} data-testid="schedule-row">
										<TableCell className="min-w-40">
											{schedule.fromDate === schedule.toDate ? (
												from
											) : (
												<Trans>
													{from} to {to}
												</Trans>
											)}
										</TableCell>
										<TableCell>{daysText(schedule.daysMask)}</TableCell>
										<TableCell className="tabular-nums">
											{seatingSummary(schedule, i18n.locale)}
										</TableCell>
										<TableCell className="tabular-nums">
											{limitsText(schedule)}
										</TableCell>
										<TableCell className="text-muted-foreground">
											{restrictionsText(schedule)}
										</TableCell>
										<TableCell className="text-end">
											{editable ? (
												<div className="flex justify-end gap-1">
													<Button
														type="button"
														size="sm"
														variant="ghost"
														onClick={() =>
															setSheet({ mode: 'edit', id: schedule.id })
														}
														data-testid="schedule-edit"
													>
														<Trans>Edit</Trans>
													</Button>
													<Button
														type="button"
														size="icon-sm"
														variant="ghost"
														aria-label={t`Remove schedule`}
														onClick={() => setRemoving(schedule)}
														data-testid="schedule-remove"
													>
														<Icon name="trash-2" />
													</Button>
												</div>
											) : null}
										</TableCell>
									</TableRow>
								)
							})}
						</TableBody>
					</Table>
				)}
			</Frame>

			<ScheduleSheet
				open={
					sheet !== null &&
					(sheet.mode === 'create' || editingSchedule !== null)
				}
				onClose={() => setSheet(null)}
				schedule={editingSchedule}
				today={today}
				usesTables={experience.usesTables}
				context={context}
				onSave={saveSchedule}
			/>

			<AlertDialog
				open={removing !== null}
				onOpenChange={(open) => {
					if (!open && !busy) setRemoving(null)
				}}
			>
				<AlertDialogContent data-testid="schedule-remove-dialog">
					<AlertDialogHeader>
						<AlertDialogTitle>
							<Trans>Remove this schedule?</Trans>
						</AlertDialogTitle>
						<AlertDialogDescription>
							<Trans>
								Guests can no longer book its seatings. Bookings already made
								are kept.
							</Trans>
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={busy}>
							<Trans>Keep schedule</Trans>
						</AlertDialogCancel>
						<Button
							type="button"
							variant="destructive"
							disabled={busy}
							onClick={() => void removeSchedule()}
							data-testid="schedule-remove-confirm"
						>
							<Trans>Remove</Trans>
						</Button>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>

			<AlertDialog
				open={archiveOpen}
				onOpenChange={(open) => {
					if (!open && !busy) setArchiveOpen(false)
				}}
			>
				<AlertDialogContent data-testid="experience-archive-dialog">
					<AlertDialogHeader>
						<AlertDialogTitle>
							<Trans>Archive this experience?</Trans>
						</AlertDialogTitle>
						<AlertDialogDescription>
							<Trans>
								It disappears from your website and cannot be changed again.
								Bookings already made are kept.
							</Trans>
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={busy}>
							<Trans>Keep it</Trans>
						</AlertDialogCancel>
						<Button
							type="button"
							variant="destructive"
							disabled={busy}
							onClick={() => void transition('archive')}
							data-testid="experience-archive-confirm"
						>
							<Trans>Archive</Trans>
						</Button>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	)
}
