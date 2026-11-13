import { type MessageDescriptor } from '@lingui/core'
import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { type StaffConsentMethod } from '@repo/common/marketing-consent'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Checkbox } from '@repo/ui/checkbox'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
import {
	Frame,
	FrameDescription,
	FrameHeader,
	FramePanel,
	FrameTitle,
} from '@repo/ui/frame'
import { Icon } from '@repo/ui/icon'
import { RadioGroup, RadioGroupItem } from '@repo/ui/radio-group'
import { Switch } from '@repo/ui/switch'
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '@repo/ui/table'
import { useEffect, useId, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
	type PeopleClient,
	recordPersonConsent,
	type PersonConsentResult,
	type PersonSubscription,
} from '#app/utils/people/people-api.ts'
import { peopleErrorInfo } from '#app/utils/people/people-errors.ts'
import { formatInstantDate } from '#app/utils/people/people-view.ts'

type Channel = 'email' | 'sms'

const TOPIC_LABELS: Record<string, MessageDescriptor> = {
	drops: msg`Drops`,
	reservations: msg`Reservations`,
}
const CHANNEL_NAMES: Record<string, MessageDescriptor> = {
	sms: msg`SMS`,
	email: msg`Email`,
}
const SOURCE_LABELS: Record<string, MessageDescriptor> = {
	menu: msg`Menu`,
	drops_page: msg`Drops page`,
	drop_page: msg`Drop page`,
	order_success: msg`After an order`,
	profile: msg`Profile`,
	reservation_booking: msg`Booking form`,
	staff: msg`Recorded by staff`,
	checkout: msg`Checkout`,
	signup: msg`Sign-up`,
	form: msg`Form`,
	operator: msg`Staff`,
	import: msg`List import`,
}
const METHOD_LABELS: Record<StaffConsentMethod, MessageDescriptor> = {
	in_person: msg`In person`,
	paper_form: msg`Paper form`,
	phone: msg`By phone`,
}
const METHODS: StaffConsentMethod[] = ['in_person', 'paper_form', 'phone']

function marketingRow(
	subscriptions: PersonSubscription[],
	channel: Channel,
): PersonSubscription | null {
	return (
		subscriptions.find(
			(s) => s.topic === 'marketing' && s.channel === channel,
		) ?? null
	)
}

/**
 * Marketing preferences: the Email and Text switches for the `marketing`
 * topic, where staff can record consent a guest gave in person, on paper or by
 * phone, plus the other topics (reservations, drops) read-only.
 */
export function PersonMarketingCard({
	client,
	personKey,
	subscriptions,
	email,
	phone,
	hasCustomer,
	canRecord,
	memberNames,
	currentUserId,
	onSubscription,
}: {
	client: PeopleClient
	personKey: string
	subscriptions: PersonSubscription[]
	email: string | null
	phone: string | null
	hasCustomer: boolean
	canRecord: boolean
	/** Operator user id to display name (control-plane data). */
	memberNames: Record<string, string>
	currentUserId?: string | null
	/** The marketing row of a channel after a write; null when none exists. */
	onSubscription: (
		channel: Channel,
		subscription: PersonSubscription | null,
	) => void
}) {
	const { _, i18n } = useLingui()
	const [dialogChannel, setDialogChannel] = useState<Channel | null>(null)
	const [optimistic, setOptimistic] = useState<
		Partial<Record<Channel, boolean>>
	>({})
	const emailSwitch = useRef<HTMLElement | null>(null)
	const smsSwitch = useRef<HTMLElement | null>(null)
	const switches = { email: emailSwitch, sms: smsSwitch }
	// The channel whose switch opened the dialog. Outlives the close, so Base UI
	// can return focus to the right switch when `dialogChannel` is already null.
	const lastChannel = useRef<Channel>('email')

	const others = subscriptions.filter((s) => s.topic !== 'marketing')

	const turnOff = async (channel: Channel) => {
		setOptimistic((prev) => ({ ...prev, [channel]: false }))
		try {
			const result = await recordPersonConsent(client, personKey, {
				channel,
				subscribed: false,
			})
			onSubscription(channel, result.subscription)
		} catch {
			toast.error(_(msg`The change could not be saved. Try again.`))
		} finally {
			setOptimistic((prev) => {
				const next = { ...prev }
				delete next[channel]
				return next
			})
		}
	}

	const rows: Array<{ channel: Channel; label: string; hasContact: boolean }> =
		[
			{ channel: 'email', label: _(msg`Email`), hasContact: Boolean(email) },
			{ channel: 'sms', label: _(msg`Text`), hasContact: Boolean(phone) },
		]

	return (
		<Frame
			role="region"
			aria-labelledby="person-marketing-title"
			data-testid="person-marketing"
		>
			<FrameHeader>
				<FrameTitle id="person-marketing-title">
					<Trans>Marketing preferences</Trans>
				</FrameTitle>
				<FrameDescription>
					<Trans>
						What this person agreed to receive. This is the only place consent
						is recorded; broadcasts and automations follow it.
					</Trans>
				</FrameDescription>
			</FrameHeader>
			<FramePanel>
				<div className="flex flex-col divide-y">
					{rows.map(({ channel, label, hasContact }) => (
						<ChannelRow
							key={channel}
							channel={channel}
							label={label}
							row={marketingRow(subscriptions, channel)}
							optimisticOn={optimistic[channel]}
							hasContact={hasContact}
							hasCustomer={hasCustomer}
							canRecord={canRecord}
							memberNames={memberNames}
							currentUserId={currentUserId ?? null}
							switchRef={switches[channel]}
							onTurnOn={() => {
									lastChannel.current = channel
									setDialogChannel(channel)
								}}
							onTurnOff={() => void turnOff(channel)}
						/>
					))}
				</div>
			</FramePanel>
			{others.length > 0 ? (
				<Table variant="card">
					<TableHeader>
						<TableRow>
							<TableHead>
								<Trans>Topic</Trans>
							</TableHead>
							<TableHead>
								<Trans>Channel</Trans>
							</TableHead>
							<TableHead>
								<Trans>Status</Trans>
							</TableHead>
							<TableHead>
								<Trans>Since</Trans>
							</TableHead>
							<TableHead>
								<Trans>Source</Trans>
							</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{others.map((row) => (
							<TableRow
								key={`${row.topic}:${row.channel}`}
								data-testid={`person-subscription-${row.topic}-${row.channel}`}
							>
								<TableCell>
									{TOPIC_LABELS[row.topic]
										? _(TOPIC_LABELS[row.topic]!)
										: row.topic}
								</TableCell>
								<TableCell>
									{CHANNEL_NAMES[row.channel]
										? _(CHANNEL_NAMES[row.channel]!)
										: row.channel}
								</TableCell>
								<TableCell>
									{row.subscribed ? (
										<Badge variant="success">
											<Trans>Subscribed</Trans>
										</Badge>
									) : (
										<Badge variant="outline">
											<Trans>Unsubscribed</Trans>
										</Badge>
									)}
								</TableCell>
								<TableCell className="text-muted-foreground text-sm">
									{formatInstantDate(
										row.unsubscribedAt ?? row.subscribedAt,
										i18n.locale,
									) ?? '—'}
								</TableCell>
								<TableCell className="text-muted-foreground text-sm">
									{SOURCE_LABELS[row.source]
										? _(SOURCE_LABELS[row.source]!)
										: row.source}
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			) : null}
			<ConsentDialog
				channel={dialogChannel}
				client={client}
				personKey={personKey}
				finalFocus={switches[lastChannel.current]}
				onClose={() => setDialogChannel(null)}
				onRecorded={(channel, result) => {
					onSubscription(channel, result.subscription)
					setDialogChannel(null)
				}}
			/>
		</Frame>
	)
}

function ChannelRow({
	channel,
	label,
	row,
	optimisticOn,
	hasContact,
	hasCustomer,
	canRecord,
	memberNames,
	currentUserId,
	switchRef,
	onTurnOn,
	onTurnOff,
}: {
	channel: Channel
	label: string
	row: PersonSubscription | null
	optimisticOn: boolean | undefined
	hasContact: boolean
	hasCustomer: boolean
	canRecord: boolean
	memberNames: Record<string, string>
	currentUserId: string | null
	switchRef: React.RefObject<HTMLElement | null>
	onTurnOn: () => void
	onTurnOff: () => void
}) {
	const { _, i18n } = useLingui()
	const descriptionId = useId()
	const actualOn = row?.subscribed ?? false
	const checked = optimisticOn ?? actualOn
	const date = (instant: number | null) =>
		formatInstantDate(instant, i18n.locale) ?? '—'

	const coolingUntil = row?.coolingOffUntil
		? Date.parse(row.coolingOffUntil)
		: NaN
	const cooling =
		!actualOn && Number.isFinite(coolingUntil) && coolingUntil > Date.now()

	let hint: string | null = null
	if (canRecord && !actualOn) {
		if (!hasCustomer) {
			hint = _(
				msg`Consent can be recorded once this guest has a customer account.`,
			)
		} else if (cooling) {
			const until = date(coolingUntil)
			hint = _(
				msg`The guest unsubscribed recently. You can record consent again after ${until}.`,
			)
		} else if (!hasContact) {
			hint =
				channel === 'email'
					? _(msg`Add an email address first`)
					: _(msg`Add a phone number first`)
		}
	}

	const disabled =
		!canRecord ||
		optimisticOn !== undefined ||
		(!actualOn && (!hasCustomer || cooling || !hasContact))

	let status: React.ReactNode
	if (checked && row) {
		const staff = row.staff
		const subscribedOn = date(row.subscribedAt)
		if (staff) {
			const isYou = staff.recordedBy === currentUserId
			const name = memberNames[staff.recordedBy] ?? _(msg`a staff member`)
			const method = staff.method ? _(METHOD_LABELS[staff.method]) : null
			let line: string
			if (isYou) {
				line = method
					? _(msg`Recorded by you on ${subscribedOn} (${method})`)
					: _(msg`Recorded by you on ${subscribedOn}`)
			} else {
				line = method
					? _(msg`Recorded by ${name} on ${subscribedOn} (${method})`)
					: _(msg`Recorded by ${name} on ${subscribedOn}`)
			}
			status = (
				<>
					<span className="inline-flex flex-wrap items-center gap-2">
						<Badge variant="secondary">
							<Trans>Recorded by staff</Trans>
						</Badge>
						{row.pending ? (
							<Badge variant="warning">
								<Trans>Pending</Trans>
							</Badge>
						) : null}
					</span>
					<span data-testid={`person-consent-${channel}-staff`}>
						{line}
					</span>
					{row.pending ? (
						<span>
							<Trans>Waiting for the guest to confirm by email</Trans>
						</span>
					) : null}
				</>
			)
		} else {
			const source = SOURCE_LABELS[row.source]
				? _(SOURCE_LABELS[row.source]!)
				: row.source
			status = (
				<>
					{row.pending ? (
						<span className="inline-flex flex-wrap items-center gap-2">
							<Badge variant="warning">
								<Trans>Pending</Trans>
							</Badge>
						</span>
					) : null}
					<span>
						{_(msg`Subscribed on ${subscribedOn} (${source})`)}
					</span>
					{row.pending ? (
						<span>
							<Trans>Waiting for the guest to confirm by email</Trans>
						</span>
					) : null}
				</>
			)
		}
	} else if (row && !row.subscribed) {
		const when = date(row.unsubscribedAt ?? row.subscribedAt)
		status = (
			<span>
				{row.unsubscribedSource === 'self'
					? _(msg`Unsubscribed by the guest on ${when}`)
					: row.unsubscribedSource === 'operator'
						? _(msg`Turned off by staff on ${when}`)
						: row.unsubscribedSource === 'import'
							? _(msg`Removed by a list import on ${when}`)
							: _(msg`Unsubscribed on ${when}`)}
			</span>
		)
	} else if (!checked) {
		status = <Trans>Not subscribed</Trans>
	}

	return (
		<div
			className="flex items-start justify-between gap-4 py-3 first:pt-0 last:pb-0"
			data-testid={`person-consent-${channel}`}
		>
			<div className="flex min-w-0 flex-col gap-1">
				<span className="text-sm font-medium">{label}</span>
				<div
					id={descriptionId}
					className="text-muted-foreground flex flex-col gap-1 text-sm"
				>
					{status}
					{hint ? (
						<span data-testid={`person-consent-${channel}-hint`}>{hint}</span>
					) : null}
				</div>
			</div>
			<Switch
				ref={switchRef}
				checked={checked}
				disabled={disabled}
				aria-label={
					channel === 'email' ? _(msg`Email marketing`) : _(msg`Text marketing`)
				}
				aria-describedby={descriptionId}
				onCheckedChange={(next) => {
					if (next) onTurnOn()
					else onTurnOff()
				}}
				data-testid={`person-consent-${channel}-switch`}
			/>
		</div>
	)
}

function consentErrorMessage(
	err: unknown,
	_: (descriptor: MessageDescriptor) => string,
	locale: string,
): string {
	const { code, status } = peopleErrorInfo(err)
	const until = (err as { until?: string | null } | null)?.until ?? null
	switch (code) {
		case 'cooling_off': {
			const parsed = until ? Date.parse(until) : NaN
			const when = Number.isFinite(parsed)
				? formatInstantDate(parsed, locale)
				: null
			return when
				? _(
						msg`The guest unsubscribed recently. You can record consent again after ${when}.`,
					)
				: _(msg`The guest unsubscribed recently. Try again later.`)
		}
		case 'method_required':
			return _(msg`Choose how the guest gave consent.`)
		case 'attestation_required':
			return _(msg`Confirm that the guest asked to receive marketing.`)
		case 'no_customer':
			return _(
				msg`Consent can be recorded once this guest has a customer account.`,
			)
		case 'email_required':
			return _(msg`Add an email address first`)
		case 'phone_required':
			return _(msg`Add a phone number first`)
		case 'insufficient_permissions':
			return _(msg`You do not have permission to record consent.`)
		default:
			if (status === 403)
				return _(msg`You do not have permission to record consent.`)
			if (status === 404) return _(msg`This customer no longer exists.`)
			return _(msg`The consent could not be recorded. Try again.`)
	}
}

/**
 * Confirmation before staff record consent on a guest's behalf. The wording of
 * the checkbox and the notes here is what `STAFF_CONSENT_TEXT_VERSION` (in
 * `@repo/common/marketing-consent`) identifies: bump that constant whenever
 * this wording changes in a way that matters. The server stores that version
 * itself; the request carries no version.
 */
function ConsentDialog({
	channel,
	client,
	personKey,
	finalFocus,
	onClose,
	onRecorded,
}: {
	channel: Channel | null
	client: PeopleClient
	personKey: string
	finalFocus?: React.RefObject<HTMLElement | null>
	onClose: () => void
	onRecorded: (channel: Channel, result: PersonConsentResult) => void
}) {
	const { _, i18n } = useLingui()
	const [method, setMethod] = useState<StaffConsentMethod | null>(null)
	const [attested, setAttested] = useState(false)
	const [saving, setSaving] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const attestId = useId()
	const open = channel !== null
	// Keep the last channel while the dialog animates out.
	const [shown, setShown] = useState<Channel>('email')
	useEffect(() => {
		if (channel) {
			setShown(channel)
			setMethod(null)
			setAttested(false)
			setError(null)
			setSaving(false)
		}
	}, [channel])
	const current = channel ?? shown
	const isEmail = current === 'email'

	const submit = async (event: React.FormEvent) => {
		event.preventDefault()
		if (!channel || !method || !attested || saving) return
		setSaving(true)
		setError(null)
		try {
			const result = await recordPersonConsent(client, personKey, {
				channel,
				subscribed: true,
				method,
				attested: true,
			})
			if (channel === 'email') {
				if (result.confirmationEmail === 'sent') {
					toast.success(_(msg`Confirmation email sent`))
				} else if (result.confirmationEmail === 'throttled') {
					toast.success(_(msg`Recorded. A confirmation email was sent recently.`))
				} else if (result.subscription?.pending) {
					toast.warning(
						_(
							msg`Consent recorded, but we couldn't send the confirmation email. Try again later.`,
						),
					)
				} else {
					toast.success(_(msg`Consent recorded`))
				}
			} else {
				toast.success(
					_(msg`Consent recorded`),
					result.deliverable === false
						? {
								description: _(
									msg`Texts start once the guest verifies their phone number.`,
								),
							}
						: undefined,
				)
			}
			onRecorded(channel, result)
		} catch (err) {
			setError(consentErrorMessage(err, _, i18n.locale))
			setSaving(false)
		}
	}

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!next && !saving) onClose()
			}}
		>
			<DialogContent
				finalFocus={finalFocus}
				data-testid="person-consent-dialog"
			>
				<DialogHeader>
					<DialogTitle>
						{isEmail ? (
							<Trans>Record consent for email offers</Trans>
						) : (
							<Trans>Record consent for text offers</Trans>
						)}
					</DialogTitle>
					<DialogDescription>
						{isEmail ? (
							<Trans>
								We'll email the guest a link to confirm. It stays pending until
								they do.
							</Trans>
						) : (
							<Trans>
								The guest gets one text confirming the subscription.
							</Trans>
						)}
					</DialogDescription>
				</DialogHeader>
				<form className="flex flex-col gap-4" onSubmit={submit}>
					<fieldset className="flex flex-col gap-2">
						<legend className="mb-2 text-sm font-medium">
							<Trans>How did the guest give consent?</Trans>
						</legend>
						<RadioGroup
							value={method ?? ''}
							onValueChange={(value) => setMethod(value as StaffConsentMethod)}
							disabled={saving}
							aria-label={_(msg`How the guest gave consent`)}
							data-testid="person-consent-method"
						>
							{METHODS.map((value) => {
								const labelId = `${attestId}-${value}`
								return (
									<label
										key={value}
										className="flex items-center gap-2 text-sm"
									>
										<RadioGroupItem
											value={value}
											aria-labelledby={labelId}
											data-testid={`person-consent-method-${value}`}
										/>
										<span id={labelId}>{_(METHOD_LABELS[value])}</span>
									</label>
								)
							})}
						</RadioGroup>
					</fieldset>
					<label className="flex items-start gap-2 text-sm">
						<Checkbox
							checked={attested}
							onCheckedChange={(next) => setAttested(next === true)}
							disabled={saving}
							aria-labelledby={attestId}
							data-testid="person-consent-attest"
						/>
						<span id={attestId}>
							{isEmail ? (
								<Trans>The guest asked to receive marketing by email</Trans>
							) : (
								<Trans>The guest asked to receive marketing by text</Trans>
							)}
						</span>
					</label>
					{error ? (
						<Alert variant="destructive" data-testid="person-consent-error">
							<Icon name="alert-triangle" />
							<AlertDescription>{error}</AlertDescription>
						</Alert>
					) : null}
					<DialogFooter>
						<Button
							type="button"
							variant="ghost"
							disabled={saving}
							onClick={onClose}
						>
							<Trans>Cancel</Trans>
						</Button>
						<Button
							type="submit"
							disabled={saving || !method || !attested}
							data-testid="person-consent-confirm"
						>
							<Trans>Record consent</Trans>
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	)
}
