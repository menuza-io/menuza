import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	MAX_CATERING_CUSTOM_QUESTIONS,
	MAX_CATERING_CUTOFFS,
	defaultCateringSettings,
	type CateringSettings,
} from '@repo/common/catering'
import { currencyExponent } from '@repo/common/money'
import { Button } from '@repo/ui/button'
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@repo/ui/card'
import { Checkbox } from '@repo/ui/checkbox'
import { Icon } from '@repo/ui/icon'
import { Label } from '@repo/ui/label'
import { Separator } from '@repo/ui/separator'
import { Switch } from '@repo/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@repo/ui/tabs'
import { Textarea } from '@repo/ui/textarea'
import { useEffect, useId, useState } from 'react'
import { useFetcher } from 'react-router'
import { SelectField, TextField } from '#app/components/staff/controls.tsx'

type View = {
	enabled: boolean
	canEdit?: boolean
	quotesFlag?: boolean
	timeZone?: string
	locales?: string[]
	defaultLocale?: string
	settings?: CateringSettings
	members?: Array<{ userId: string; label: string }>
	ok?: boolean
	error?: string
	issues?: string[]
}

type Localized = Record<string, string> | null | undefined

/** One text in each of the site's languages, a tab per language. */
function LocalizedText({
	id,
	label,
	locales,
	value,
	onChange,
	rows = 2,
	disabled,
}: {
	id: string
	label: React.ReactNode
	locales: string[]
	value: Localized
	onChange: (next: Record<string, string>) => void
	rows?: number
	disabled?: boolean
}) {
	const [active, setActive] = useState(locales[0] ?? 'en')
	const current = value ?? {}
	const set = (locale: string, text: string) =>
		onChange({ ...current, [locale]: text.slice(0, 500) })
	return (
		<div className="grid gap-1">
			<Label htmlFor={`${id}-${active}`}>{label}</Label>
			{locales.length > 1 ? (
				<Tabs value={active} onValueChange={setActive}>
					<TabsList>
						{locales.map((locale) => (
							<TabsTrigger key={locale} value={locale}>
								{locale.toUpperCase()}
							</TabsTrigger>
						))}
					</TabsList>
					{locales.map((locale) => (
						<TabsContent key={locale} value={locale} className="mt-2">
							<Textarea
								id={`${id}-${locale}`}
								dir="auto"
								rows={rows}
								disabled={disabled}
								value={current[locale] ?? ''}
								onChange={(event) => set(locale, event.target.value)}
							/>
						</TabsContent>
					))}
				</Tabs>
			) : (
				<Textarea
					id={`${id}-${active}`}
					dir="auto"
					rows={rows}
					disabled={disabled}
					value={current[active] ?? ''}
					onChange={(event) => set(active, event.target.value)}
				/>
			)}
		</div>
	)
}

const QUESTION_HELP = {
	cutlery: msg`Do you provide plates, napkins and cutlery?`,
	dietary: msg`Which dietary needs can you meet?`,
	staff: msg`Do you offer set-up and serving staff?`,
} as const

const ERRORS: Record<string, ReturnType<typeof msg>> = {
	invalid_settings: msg`Some of these settings are not valid. Check them and try again.`,
	invalid_request: msg`That did not work. Try again.`,
}

function majorText(minor: number | null, currency: string): string {
	if (minor === null) return ''
	return String(minor / 10 ** currencyExponent(currency))
}

function toMinor(text: string, currency: string): number | null {
	const value = Number(text.replace(',', '.'))
	if (!text.trim() || !Number.isFinite(value) || value < 0) return null
	return Math.round(value * 10 ** currencyExponent(currency))
}

/**
 * Settings, Locations, Catering (#124, #255, #361, #325): catering for this
 * location. The notice and window, the limits, whether guests pay now or ask for
 * a quote, the members told about new requests, the order-by cutoffs for
 * holiday dates, the deposit and its reminders, and the answers shown on the
 * catering page and given to the phone agent. Shown only while the
 * organization has catering on. Business settings only: no guest data.
 */
export function LocationCateringCard({
	orgSlug,
	locationId,
	currency,
}: {
	orgSlug: string
	locationId: string
	currency: string
}) {
	const { _ } = useLingui()
	const baseId = useId()
	const url = `/${orgSlug}/settings/locations/${locationId}/catering`
	const fetcher = useFetcher<View>()
	const [data, setData] = useState<View | null>(null)
	const [draft, setDraft] = useState<CateringSettings>(
		defaultCateringSettings(),
	)
	const [minText, setMinText] = useState('')
	const [maxText, setMaxText] = useState('')

	useEffect(() => {
		if (fetcher.state === 'idle' && !fetcher.data && !data) {
			void fetcher.load(url)
		}
	}, [fetcher, url, data])
	useEffect(() => {
		if (!fetcher.data) return
		if ('settings' in fetcher.data || fetcher.data.enabled === false) {
			setData(fetcher.data)
		}
	}, [fetcher.data])
	useEffect(() => {
		if (!data?.settings) return
		setDraft(data.settings)
		setMinText(majorText(data.settings.minMinor, currency))
		setMaxText(majorText(data.settings.maxMinor, currency))
	}, [data, currency])

	if (!data?.enabled) return null
	const canEdit = data.canEdit === true
	const saving = fetcher.state !== 'idle'
	const locales = data.locales?.length ? data.locales : ['en']
	const members = data.members ?? []
	const failed = fetcher.state === 'idle' && fetcher.data?.ok === false
	const errorText = failed
		? (fetcher.data?.issues?.[0] ??
			(fetcher.data?.error && ERRORS[fetcher.data.error]
				? _(ERRORS[fetcher.data.error]!)
				: _(msg`That did not work. Try again.`)))
		: null
	const saved = fetcher.state === 'idle' && fetcher.data?.ok === true
	const timeZone = data.timeZone ?? ''

	const set = (patch: Partial<CateringSettings>) =>
		setDraft((current) => ({ ...current, ...patch }))
	const setDeposit = (patch: Partial<CateringSettings['deposit']>) =>
		setDraft((current) => ({
			...current,
			deposit: { ...current.deposit, ...patch },
		}))
	const intField = (text: string, fallback: number) => {
		const value = Number(text)
		return Number.isFinite(value) ? Math.round(value) : fallback
	}
	const save = () =>
		void fetcher.submit(
			{
				intent: 'save',
				settings: JSON.stringify({
					...draft,
					minMinor: toMinor(minText, currency),
					maxMinor: toMinor(maxText, currency),
				}),
			},
			{ method: 'POST', action: url },
		)

	const quoteOptions = [
		{ value: 'off', label: _(msg`Guests pay when they order`) },
		{ value: 'optional', label: _(msg`Guests may pay or ask for a quote`) },
		{ value: 'required', label: _(msg`Guests ask for a quote first`) },
	]
	const standard = draft.questions.standard as Record<string, Localized>

	return (
		<Card data-testid="location-catering-card">
			<CardHeader>
				<CardTitle className="flex items-center gap-2 text-base">
					<Icon name="building" className="size-4" />
					<Trans>Catering</Trans>
				</CardTitle>
				<CardDescription>
					<Trans>
						Take catering orders with lead times and limits, send quotes guests
						pay online, close dates for holidays, take a deposit and answer the
						questions guests ask.
					</Trans>
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-6">
				<div className="flex items-center justify-between gap-3">
					<Label htmlFor={`${baseId}-enabled`}>
						<Trans>Take catering orders at this location</Trans>
					</Label>
					<Switch
						id={`${baseId}-enabled`}
						checked={draft.enabled}
						disabled={!canEdit}
						onCheckedChange={(checked) => set({ enabled: checked })}
					/>
				</div>

				<section className="space-y-3" aria-labelledby={`${baseId}-rules`}>
					<h3 id={`${baseId}-rules`} className="text-base font-medium">
						<Trans>Lead time and limits</Trans>
					</h3>
					<div className="grid gap-3 sm:grid-cols-2">
						<TextField
							id={`${baseId}-notice`}
							label={<Trans>Minimum notice (hours)</Trans>}
							type="number"
							min={0}
							max={1440}
							disabled={!canEdit}
							value={draft.noticeHours}
							onChange={(event) =>
								set({ noticeHours: intField(event.target.value, 24) })
							}
						/>
						<TextField
							id={`${baseId}-ahead`}
							label={<Trans>How far ahead guests can order (days)</Trans>}
							type="number"
							min={1}
							max={365}
							disabled={!canEdit}
							value={draft.maxDaysAhead}
							onChange={(event) =>
								set({ maxDaysAhead: intField(event.target.value, 60) })
							}
						/>
						<TextField
							id={`${baseId}-min`}
							label={<Trans>Minimum order ({currency})</Trans>}
							optional
							inputMode="decimal"
							disabled={!canEdit}
							value={minText}
							onChange={(event) => setMinText(event.target.value)}
						/>
						<TextField
							id={`${baseId}-max`}
							label={<Trans>Maximum order ({currency})</Trans>}
							optional
							inputMode="decimal"
							disabled={!canEdit}
							value={maxText}
							onChange={(event) => setMaxText(event.target.value)}
						/>
						<TextField
							id={`${baseId}-guests`}
							label={<Trans>Maximum guests</Trans>}
							optional
							type="number"
							min={1}
							disabled={!canEdit}
							value={draft.maxGuests ?? ''}
							onChange={(event) =>
								set({
									maxGuests: event.target.value
										? intField(event.target.value, 1)
										: null,
								})
							}
						/>
						<SelectField
							id={`${baseId}-quote`}
							label={<Trans>Payment</Trans>}
							options={quoteOptions}
							value={draft.quoteMode}
							disabled={!canEdit || !data.quotesFlag}
							hint={
								data.quotesFlag ? undefined : (
									<Trans>Quotes are not turned on for your account.</Trans>
								)
							}
							onValueChange={(value) =>
								value &&
								set({ quoteMode: value as CateringSettings['quoteMode'] })
							}
						/>
					</div>
					<div className="flex flex-wrap gap-3">
						{(['pickup', 'delivery'] as const).map((key) => (
							<label
								key={key}
								className="hover:bg-muted/40 flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2"
							>
								<Checkbox
									checked={draft.fulfillments[key]}
									disabled={!canEdit}
									onCheckedChange={(checked) =>
										set({
											fulfillments: {
												...draft.fulfillments,
												[key]: checked === true,
											},
										})
									}
								/>
								<span className="text-sm font-medium">
									{key === 'pickup' ? (
										<Trans>Pickup</Trans>
									) : (
										<Trans>Delivery</Trans>
									)}
								</span>
							</label>
						))}
					</div>
				</section>
				<Separator />

				<section className="space-y-3" aria-labelledby={`${baseId}-people`}>
					<h3 id={`${baseId}-people`} className="text-base font-medium">
						<Trans>Tell these members about catering</Trans>
					</h3>
					<p className="text-muted-foreground text-sm">
						<Trans>
							They get a notice for a new quote request or order. The notice
							never includes what the guest wrote.
						</Trans>
					</p>
					<ul className="grid gap-2 sm:grid-cols-2">
						{members.map((member) => (
							<li key={member.userId}>
								<label className="hover:bg-muted/40 flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2">
									<Checkbox
										checked={draft.alertUserIds.includes(member.userId)}
										disabled={!canEdit}
										onCheckedChange={(checked) =>
											set({
												alertUserIds:
													checked === true
														? [...draft.alertUserIds, member.userId].slice(
																0,
																25,
															)
														: draft.alertUserIds.filter(
																(id) => id !== member.userId,
															),
											})
										}
									/>
									<span className="text-sm wrap-anywhere">{member.label}</span>
								</label>
							</li>
						))}
					</ul>
				</section>
				<Separator />

				<section className="space-y-3" aria-labelledby={`${baseId}-deposit`}>
					<h3 id={`${baseId}-deposit`} className="text-base font-medium">
						<Trans>Deposit and balance</Trans>
					</h3>
					<div className="grid gap-3 sm:grid-cols-3">
						<TextField
							id={`${baseId}-deposit-percent`}
							label={<Trans>Deposit (percent, 0 is pay in full)</Trans>}
							type="number"
							min={0}
							max={100}
							disabled={!canEdit}
							value={draft.deposit.percent}
							onChange={(event) =>
								setDeposit({ percent: intField(event.target.value, 0) })
							}
						/>
						<TextField
							id={`${baseId}-deposit-due`}
							label={<Trans>Balance due (days before the event)</Trans>}
							type="number"
							min={0}
							max={60}
							disabled={!canEdit}
							value={draft.deposit.balanceDueDaysBeforeEvent}
							onChange={(event) =>
								setDeposit({
									balanceDueDaysBeforeEvent: intField(event.target.value, 3),
								})
							}
						/>
						<TextField
							id={`${baseId}-deposit-reminder`}
							label={<Trans>Reminder (days before it is due, 0 is off)</Trans>}
							type="number"
							min={0}
							max={14}
							disabled={!canEdit}
							value={draft.deposit.reminderDaysBeforeDue}
							onChange={(event) =>
								setDeposit({
									reminderDaysBeforeDue: intField(event.target.value, 2),
								})
							}
						/>
					</div>
					<p className="text-muted-foreground text-xs">
						<Trans>
							Guests get one reminder before the balance is due and one when it
							is overdue, never between 9 PM and 8 AM. You can change one
							order&apos;s due date or void its balance from Orders, Catering.
						</Trans>
					</p>
				</section>
				<Separator />

				<section className="space-y-3" aria-labelledby={`${baseId}-cutoffs`}>
					<h3 id={`${baseId}-cutoffs`} className="text-base font-medium">
						<Trans>Order-by cutoffs</Trans>
					</h3>
					<p className="text-muted-foreground text-sm">
						<Trans>
							Close the dates of a holiday or season at a set time, in this
							location&apos;s time zone ({timeZone}). Orders already placed and
							quotes already sent are never changed.
						</Trans>
					</p>
					{draft.cutoffs.length === 0 ? (
						<p className="text-muted-foreground text-sm">
							<Trans>No cutoffs.</Trans>
						</p>
					) : (
						<ul className="space-y-3" data-testid="catering-cutoffs">
							{draft.cutoffs.map((cutoff, index) => {
								const update = (patch: Partial<typeof cutoff>) =>
									set({
										cutoffs: draft.cutoffs.map((candidate, at) =>
											at === index ? { ...candidate, ...patch } : candidate,
										),
									})
								return (
									<li
										key={cutoff.id}
										className="space-y-2 rounded-md border p-3"
									>
										<div className="grid gap-3 sm:grid-cols-4">
											<TextField
												id={`${baseId}-from-${index}`}
												label={<Trans>Event dates from</Trans>}
												type="date"
												disabled={!canEdit}
												value={cutoff.from}
												onChange={(event) =>
													update({ from: event.target.value })
												}
											/>
											<TextField
												id={`${baseId}-to-${index}`}
												label={<Trans>To</Trans>}
												type="date"
												disabled={!canEdit}
												value={cutoff.to}
												onChange={(event) => update({ to: event.target.value })}
											/>
											<TextField
												id={`${baseId}-by-date-${index}`}
												label={<Trans>Order by (date)</Trans>}
												type="date"
												disabled={!canEdit}
												value={cutoff.orderByDate}
												onChange={(event) =>
													update({ orderByDate: event.target.value })
												}
											/>
											<TextField
												id={`${baseId}-by-time-${index}`}
												label={<Trans>Order by (time)</Trans>}
												type="time"
												disabled={!canEdit}
												value={cutoff.orderByTime}
												onChange={(event) =>
													update({ orderByTime: event.target.value })
												}
											/>
										</div>
										<LocalizedText
											id={`${baseId}-cutoff-note-${index}`}
											label={<Trans>Note shown to guests</Trans>}
											locales={locales}
											value={cutoff.note as Localized}
											disabled={!canEdit}
											onChange={(next) => update({ note: next })}
										/>
										{canEdit ? (
											<Button
												variant="ghost"
												size="sm"
												onClick={() =>
													set({
														cutoffs: draft.cutoffs.filter(
															(_, at) => at !== index,
														),
													})
												}
											>
												<Trans>Remove cutoff</Trans>
											</Button>
										) : null}
									</li>
								)
							})}
						</ul>
					)}
					{canEdit && draft.cutoffs.length < MAX_CATERING_CUTOFFS ? (
						<Button
							variant="outline"
							size="sm"
							onClick={() =>
								set({
									cutoffs: [
										...draft.cutoffs,
										{
											id: crypto.randomUUID(),
											from: '',
											to: '',
											orderByDate: '',
											orderByTime: '17:00',
											note: null,
										},
									],
								})
							}
						>
							<Trans>Add a cutoff</Trans>
						</Button>
					) : null}
				</section>
				<Separator />

				<section className="space-y-3" aria-labelledby={`${baseId}-qna`}>
					<h3 id={`${baseId}-qna`} className="text-base font-medium">
						<Trans>Good to know</Trans>
					</h3>
					<p className="text-muted-foreground text-sm">
						<Trans>
							Guests see these answers on the catering page and the phone agent
							gives the same ones. Notice, minimum order, delivery and deposit
							are filled in from the settings above. A question you leave empty
							is not shown.
						</Trans>
					</p>
					{(['cutlery', 'dietary', 'staff'] as const).map((key) => (
						<LocalizedText
							key={key}
							id={`${baseId}-q-${key}`}
							label={_(QUESTION_HELP[key])}
							locales={locales}
							value={standard[key]}
							disabled={!canEdit}
							onChange={(next) =>
								set({
									questions: {
										...draft.questions,
										standard: { ...draft.questions.standard, [key]: next },
									},
								})
							}
						/>
					))}
					<LocalizedText
						id={`${baseId}-cancel`}
						label={<Trans>Cancellation policy</Trans>}
						locales={locales}
						value={draft.deposit.cancellationNote as Localized}
						disabled={!canEdit}
						onChange={(next) => setDeposit({ cancellationNote: next })}
					/>
					{draft.questions.custom.map((entry, index) => {
						const update = (patch: Partial<typeof entry>) =>
							set({
								questions: {
									...draft.questions,
									custom: draft.questions.custom.map((candidate, at) =>
										at === index ? { ...candidate, ...patch } : candidate,
									),
								},
							})
						return (
							<div key={entry.id} className="space-y-2 rounded-md border p-3">
								<LocalizedText
									id={`${baseId}-custom-q-${index}`}
									label={<Trans>Your question</Trans>}
									locales={locales}
									rows={1}
									value={entry.question as Localized}
									disabled={!canEdit}
									onChange={(next) => update({ question: next })}
								/>
								<LocalizedText
									id={`${baseId}-custom-a-${index}`}
									label={<Trans>Your answer</Trans>}
									locales={locales}
									value={entry.answer as Localized}
									disabled={!canEdit}
									onChange={(next) => update({ answer: next })}
								/>
								{canEdit ? (
									<Button
										variant="ghost"
										size="sm"
										onClick={() =>
											set({
												questions: {
													...draft.questions,
													custom: draft.questions.custom.filter(
														(_, at) => at !== index,
													),
												},
											})
										}
									>
										<Trans>Remove question</Trans>
									</Button>
								) : null}
							</div>
						)
					})}
					{canEdit &&
					draft.questions.custom.length < MAX_CATERING_CUSTOM_QUESTIONS ? (
						<Button
							variant="outline"
							size="sm"
							onClick={() =>
								set({
									questions: {
										...draft.questions,
										custom: [
											...draft.questions.custom,
											{ id: crypto.randomUUID(), question: {}, answer: {} },
										],
									},
								})
							}
						>
							<Trans>Add a question</Trans>
						</Button>
					) : null}
				</section>

				{errorText ? (
					<p role="alert" className="text-destructive text-sm">
						{errorText}
					</p>
				) : null}
				{saved ? (
					<p role="status" className="text-sm">
						<Trans>Saved.</Trans>
					</p>
				) : null}
				{canEdit ? (
					<Button disabled={saving} data-testid="catering-save" onClick={save}>
						<Trans>Save catering settings</Trans>
					</Button>
				) : null}
			</CardContent>
		</Card>
	)
}
