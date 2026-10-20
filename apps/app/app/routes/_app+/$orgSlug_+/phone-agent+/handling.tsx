import { type MessageDescriptor } from '@lingui/core'
import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	AUTO_RESOLVE_DAYS,
	type CallTag,
	NOTIFICATION_EVENTS,
	type NotificationEvent,
	type PhoneAgentContact,
	type PhraseKey,
	TRANSFER_HOURS_MODES,
	type TransferCase,
	type TransferHoursMode,
} from '@repo/phone-agent'
import { AnnotatedLayout, AnnotatedSection } from '@repo/ui/annotated-layout'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Card, CardContent } from '@repo/ui/card'
import { Checkbox } from '@repo/ui/checkbox'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@repo/ui/select'
import { Switch } from '@repo/ui/switch'
import { Textarea } from '@repo/ui/textarea'
import { useEffect, useState } from 'react'
import { Link, useLoaderData, useParams } from 'react-router'
import { GeneralErrorBoundary } from '#app/components/error-boundary.tsx'
import { formatDateTime } from '#app/components/phone-agent/call-data.ts'
import {
	PhraseOverridesSection,
	usePhraseDrafts,
} from '#app/components/phone-agent/phrase-fields.tsx'
import { PhoneAgentSettingsHeader } from '#app/components/phone-agent/settings-nav.tsx'
import {
	FieldErrorText,
	localId,
	SettingsSaveBar,
	useSettingsFormState,
	useUnsavedChangesWarning,
} from '#app/components/phone-agent/settings-page.tsx'
import { type Route } from './+types/handling.ts'

export { action, loader } from './handling.server.ts'

type LoaderData = Route.ComponentProps['loaderData']

const HOURS_LABELS: Record<TransferHoursMode, MessageDescriptor> = {
	always: msg`Any time`,
	business_hours: msg`Only while you're open`,
}

const RETRY_OPTIONS = [0, 1, 2] as const

/** Lines spoken around a transfer, edited with the transfer settings. */
const TRANSFER_PHRASE_KEYS: PhraseKey[] = [
	'hold',
	'transfer_connecting',
	'transfer_no_answer',
	'transfer_unavailable',
	'transfer_text_offer',
	'transfer_text_sent',
	'transfer_text_failed',
]

/** Lines a call flow step uses when it has no message of its own. */
const FLOW_PHRASE_KEYS: PhraseKey[] = [
	'menu_retry',
	'menu_invalid',
	'voicemail_prompt',
	'voicemail_saved',
	'voicemail_failed',
	'voicemail_empty',
	'text_link_sent',
	'text_link_blocked',
]

/** Lines the rating step uses. */
const CSAT_PHRASE_KEYS: PhraseKey[] = [
	'csat_question',
	'csat_thanks',
	'csat_low',
]

const EVENT_COPY: Record<
	NotificationEvent,
	{ label: MessageDescriptor; hint: MessageDescriptor }
> = {
	every_call: {
		label: msg`Every call`,
		hint: msg`A summary after each call. Can be a lot of texts on busy days.`,
	},
	voicemail: {
		label: msg`Voicemail`,
		hint: msg`A caller left a voicemail.`,
	},
	callback_request: {
		label: msg`Callback requests`,
		hint: msg`A caller asked someone to call them back.`,
	},
	link_sent: {
		label: msg`Links sent`,
		hint: msg`The agent texted a caller a link.`,
	},
	transfer_no_answer: {
		label: msg`Missed transfers`,
		hint: msg`The agent tried to transfer a call and nobody answered.`,
	},
	complaint: {
		label: msg`Complaints`,
		hint: msg`A caller was unhappy or reported a problem.`,
	},
	low_rating: {
		label: msg`Low ratings`,
		hint: msg`A caller rated the call 1 or 2 out of 5.`,
	},
	important_tag: {
		label: msg`Important tags`,
		hint: msg`The call got a tag you marked important.`,
	},
}

export default function PhoneAgentHandling() {
	const data = useLoaderData<LoaderData>()
	const [flowDirty, setFlowDirty] = useState(false)
	const [transfersDirty, setTransfersDirty] = useState(false)
	const [ratingsDirty, setRatingsDirty] = useState(false)
	const [afterCallDirty, setAfterCallDirty] = useState(false)
	useUnsavedChangesWarning(
		data.canUpdate &&
			(flowDirty || transfersDirty || ratingsDirty || afterCallDirty),
	)
	return (
		<div className="flex flex-col gap-8">
			<PhoneAgentSettingsHeader active="handling" />
			<AnnotatedLayout>
				<CallFlowSection publishedFlow={data.publishedFlow} />
				<FlowLinesSection
					phrases={data.phrases}
					languages={data.languages}
					businessName={data.businessName}
					versions={data.versions}
					canUpdate={data.canUpdate}
					onDirtyChange={setFlowDirty}
				/>
				<div id="transfers" className="scroll-mt-6">
					<TransfersSection
						safety={data.safety}
						escalationPhone={data.escalationPhone}
						transfers={data.transfers}
						contacts={data.contacts}
						transferCases={data.transferCases}
						phrases={data.phrases}
						languages={data.languages}
						businessName={data.businessName}
						versions={data.versions}
						canUpdate={data.canUpdate}
						onDirtyChange={setTransfersDirty}
					/>
				</div>
				<RatingsSection
					csatEnabled={data.csatEnabled}
					phrases={data.phrases}
					languages={data.languages}
					businessName={data.businessName}
					versions={data.versions}
					canUpdate={data.canUpdate}
					onDirtyChange={setRatingsDirty}
				/>
				<div id="after-the-call" className="scroll-mt-6">
					<AfterCallSection
						notifications={data.notifications}
						followUp={data.followUp}
						tags={data.tags}
						versions={data.versions}
						canUpdate={data.canUpdate}
						canUpdateAlerts={data.canUpdateAlerts}
						onDirtyChange={setAfterCallDirty}
					/>
				</div>
			</AnnotatedLayout>
		</div>
	)
}

function CallFlowSection({
	publishedFlow,
}: {
	publishedFlow: LoaderData['publishedFlow']
}) {
	const { _, i18n } = useLingui()
	const { orgSlug = '' } = useParams()
	const flowVersion = publishedFlow?.version ?? 0
	const publishedOn = formatDateTime(
		publishedFlow?.publishedAt ?? null,
		i18n.locale,
	)
	return (
		<AnnotatedSection
			title={<Trans>Call flow</Trans>}
			description={
				<Trans>
					The steps the agent follows on each call. The standard flow works for
					most businesses, so change it only if your calls need a different
					order.
				</Trans>
			}
		>
			<Card>
				<CardContent className="flex flex-wrap items-center justify-between gap-4">
					<div className="flex min-w-0 flex-col gap-1">
						<p className="text-sm font-medium">
							{publishedFlow ? (
								<Trans>Using a custom call flow</Trans>
							) : (
								<Trans>Using the standard call flow</Trans>
							)}
						</p>
						<p className="text-muted-foreground text-xs">
							{publishedFlow
								? _(msg`Version ${flowVersion}, published ${publishedOn}`)
								: _(
										msg`Nothing is published yet, so calls use the default phone menu.`,
									)}
						</p>
					</div>
					<Button
						variant="outline"
						size="sm"
						render={<Link to={`/${orgSlug}/phone-agent/flow`} />}
					>
						{publishedFlow ? (
							<Trans>Edit call flow</Trans>
						) : (
							<Trans>Customize call flow</Trans>
						)}
					</Button>
				</CardContent>
			</Card>
		</AnnotatedSection>
	)
}

/** The flow-step lines: saved on their own because the flow itself is a link. */
function FlowLinesSection({
	phrases,
	languages,
	businessName,
	versions,
	canUpdate,
	onDirtyChange,
}: {
	phrases: LoaderData['phrases']
	languages: LoaderData['languages']
	businessName: string
	versions: LoaderData['versions']
	canUpdate: boolean
	onDirtyChange: (dirty: boolean) => void
}) {
	const drafts = usePhraseDrafts(phrases)
	const form = useSettingsFormState({
		saved: { phrases },
		versions,
		draft: { phrases: drafts.drafts },
		reset: (saved) => drafts.reset(saved.phrases),
		canUpdate,
	})
	const { pending, fieldErrors, save, dirty } = form
	useEffect(() => {
		onDirtyChange(dirty)
	}, [dirty, onDirtyChange])
	const disabled = !canUpdate || pending
	return (
		<form
			className="flex flex-col gap-6"
			onSubmit={(event) => {
				event.preventDefault()
				save({ phrases: drafts.collect() })
			}}
		>
			<AnnotatedSection
				title={<Trans>Lines the flow uses</Trans>}
				description={
					<Trans>
						Played when a step has no message of its own: a keypad menu
						repeating, a voicemail being saved, or a link being texted.
					</Trans>
				}
			>
				<Card>
					<CardContent className="flex flex-col gap-5">
						<PhraseOverridesSection
							keys={FLOW_PHRASE_KEYS}
							languages={languages}
							phrases={drafts}
							fieldErrors={fieldErrors}
							disabled={disabled}
							businessName={businessName}
						/>
						<FieldErrorText error={fieldErrors.phrases} />
					</CardContent>
				</Card>
			</AnnotatedSection>
			<SettingsSaveBar
				canUpdate={canUpdate}
				form={form}
				label={<Trans>Save flow lines</Trans>}
			/>
		</form>
	)
}

function TransfersSection({
	safety,
	escalationPhone,
	transfers: savedTransfers,
	contacts: savedContacts,
	transferCases: savedCases,
	phrases,
	languages,
	businessName,
	versions,
	canUpdate,
	onDirtyChange,
}: {
	safety: LoaderData['safety']
	escalationPhone: LoaderData['escalationPhone']
	transfers: LoaderData['transfers']
	contacts: LoaderData['contacts']
	transferCases: LoaderData['transferCases']
	phrases: LoaderData['phrases']
	languages: LoaderData['languages']
	businessName: string
	versions: LoaderData['versions']
	canUpdate: boolean
	onDirtyChange: (dirty: boolean) => void
}) {
	const { _ } = useLingui()
	const [on, setOn] = useState(!safety.transfersDisabled)
	const [staffPhone, setStaffPhone] = useState(escalationPhone ?? '')
	const [transfers, setTransfers] = useState(savedTransfers)
	const [contacts, setContacts] = useState(savedContacts)
	const [cases, setCases] = useState(savedCases)
	const [ringTimeout, setRingTimeout] = useState(
		String(savedTransfers.ringTimeoutSeconds),
	)
	const drafts = usePhraseDrafts(phrases)
	const form = useSettingsFormState({
		saved: {
			on: !safety.transfersDisabled,
			staffPhone: escalationPhone ?? '',
			transfers: savedTransfers,
			contacts: savedContacts,
			transferCases: savedCases,
			phrases,
		},
		versions,
		draft: {
			on,
			staffPhone,
			transfers,
			contacts,
			cases,
			ringTimeout,
			phrases: drafts.drafts,
		},
		reset: (saved) => {
			setOn(saved.on)
			setStaffPhone(saved.staffPhone)
			setTransfers(saved.transfers)
			setRingTimeout(String(saved.transfers.ringTimeoutSeconds))
			setContacts(saved.contacts)
			setCases(saved.transferCases)
			drafts.reset(saved.phrases)
		},
		canUpdate,
	})
	const { pending, fieldErrors, save, dirty } = form
	useEffect(() => {
		onDirtyChange(dirty)
	}, [dirty, onDirtyChange])
	const disabled = !canUpdate || pending

	const usedContactIds = new Set(cases.map((item) => item.contactId))

	function updateContact(id: string, patch: Partial<PhoneAgentContact>) {
		setContacts((current) =>
			current.map((contact) =>
				contact.id === id ? { ...contact, ...patch } : contact,
			),
		)
	}
	function updateCase(id: string, patch: Partial<TransferCase>) {
		setCases((current) =>
			current.map((item) => (item.id === id ? { ...item, ...patch } : item)),
		)
	}

	return (
		<form
			className="flex flex-col gap-6"
			onSubmit={(event) => {
				event.preventDefault()
				save({
					safety: { ...safety, transfersDisabled: !on },
					escalationPhone: staffPhone.trim() || null,
					autoEscalate: Boolean(staffPhone.trim()),
					transfers: {
						...transfers,
						ringTimeoutSeconds: Number(ringTimeout),
					},
					contacts: contacts.map((contact) => ({
						...contact,
						role: contact.role?.trim() || null,
					})),
					transferCases: cases,
					phrases: drafts.collect(),
				})
			}}
		>
			<AnnotatedSection
				title={<Trans>Transfers</Trans>}
				description={
					<Trans>
						Hand a caller to a person when the agent can't help, when they press
						0, or when a case below matches.
					</Trans>
				}
			>
				<Card>
					<CardContent className="flex flex-col gap-5">
						<div className="flex items-center justify-between gap-4">
							<div className="flex flex-col gap-1">
								<Label htmlFor="transfers-enabled">
									<Trans>Let the agent transfer calls</Trans>
								</Label>
								<p className="text-muted-foreground text-xs">
									<Trans>
										When off, the agent takes a message instead of transferring.
									</Trans>
								</p>
							</div>
							<Switch
								id="transfers-enabled"
								checked={on}
								disabled={disabled}
								onCheckedChange={(checked) => setOn(checked)}
							/>
						</div>

						<div className="flex flex-col gap-1.5">
							<Label htmlFor="transfer-staff-phone">
								<Trans>Staff phone</Trans>
							</Label>
							<Input
								id="transfer-staff-phone"
								type="tel"
								inputMode="tel"
								placeholder="+15551234567"
								value={staffPhone}
								disabled={disabled}
								aria-invalid={fieldErrors.escalationPhone ? true : undefined}
								onChange={(event) => setStaffPhone(event.target.value.trim())}
							/>
							<p className="text-muted-foreground text-xs">
								{staffPhone ? (
									<Trans>
										The agent moves callers here when it can't help. Use a
										number staff answer directly, not one that forwards back to
										the agent.
									</Trans>
								) : (
									<Trans>
										No staff phone, so only the transfer cases below transfer
										calls.
									</Trans>
								)}
							</p>
							<FieldErrorText error={fieldErrors.escalationPhone} />
						</div>

						<div className="flex flex-col gap-1.5">
							<Label htmlFor="transfer-hours">
								<Trans>Transfer calls</Trans>
							</Label>
							<HoursSelect
								id="transfer-hours"
								value={transfers.hours}
								disabled={disabled}
								onChange={(hours) =>
									setTransfers((current) => ({ ...current, hours }))
								}
							/>
							<p className="text-muted-foreground text-xs">
								<Trans>
									Outside these times the agent takes a message instead.
								</Trans>
							</p>
						</div>
						<div className="flex items-center justify-between gap-4">
							<div className="flex flex-col gap-1">
								<Label htmlFor="transfer-press-zero">
									<Trans>Press 0 to reach staff</Trans>
								</Label>
								<p className="text-muted-foreground text-xs">
									<Trans>
										Callers can press 0 at any time to be transferred.
									</Trans>
								</p>
							</div>
							<Switch
								id="transfer-press-zero"
								checked={transfers.pressZeroForStaff}
								disabled={disabled}
								onCheckedChange={(checked) =>
									setTransfers((current) => ({
										...current,
										pressZeroForStaff: checked,
									}))
								}
							/>
						</div>
						<div className="flex items-center justify-between gap-4">
							<div className="flex flex-col gap-1">
								<Label htmlFor="transfer-text-offer">
									<Trans>Offer a text if nobody answers</Trans>
								</Label>
								<p className="text-muted-foreground text-xs">
									<Trans>
										Before transferring, the agent asks if it may text the
										caller a link they can use should nobody pick up.
									</Trans>
								</p>
							</div>
							<Switch
								id="transfer-text-offer"
								checked={transfers.offerTextWhenNoAnswer}
								disabled={disabled}
								onCheckedChange={(checked) =>
									setTransfers((current) => ({
										...current,
										offerTextWhenNoAnswer: checked,
									}))
								}
							/>
						</div>
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="transfer-ring-timeout">
								<Trans>Ring for (seconds)</Trans>
							</Label>
							<Input
								id="transfer-ring-timeout"
								type="number"
								min={10}
								max={60}
								step={1}
								className="w-32"
								value={ringTimeout}
								disabled={disabled}
								aria-invalid={
									fieldErrors['transfers.ringTimeoutSeconds'] ? true : undefined
								}
								onChange={(event) => setRingTimeout(event.target.value)}
							/>
							<FieldErrorText
								error={fieldErrors['transfers.ringTimeoutSeconds']}
							/>
						</div>

						<PhraseOverridesSection
							keys={TRANSFER_PHRASE_KEYS}
							languages={languages}
							phrases={drafts}
							fieldErrors={fieldErrors}
							disabled={disabled}
							businessName={businessName}
						/>
						<FieldErrorText error={fieldErrors.phrases} />
					</CardContent>
				</Card>
			</AnnotatedSection>

			<AnnotatedSection
				title={<Trans>Contacts</Trans>}
				description={
					<Trans>
						People or departments the agent can transfer to, like a manager. Use
						numbers that don't forward to the agent.
					</Trans>
				}
			>
				<Card>
					<CardContent className="flex flex-col gap-4">
						{contacts.length === 0 ? (
							<p className="text-muted-foreground text-sm">
								<Trans>No contacts yet.</Trans>
							</p>
						) : null}
						{contacts.map((contact, index) => {
							const inUse = usedContactIds.has(contact.id)
							const phoneError = fieldErrors[`contacts.${index}.phone`]
							const nameError =
								fieldErrors[`contacts.${index}.name`] ??
								fieldErrors[`contacts.${index}.id`]
							const roleError = fieldErrors[`contacts.${index}.role`]
							return (
								<div
									key={contact.id}
									className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]"
								>
									<Input
										aria-label={_(msg`Name`)}
										placeholder={_(msg`Name`)}
										value={contact.name}
										maxLength={80}
										required
										disabled={disabled}
										aria-invalid={nameError ? true : undefined}
										onChange={(event) =>
											updateContact(contact.id, {
												name: event.target.value,
											})
										}
									/>
									<Input
										aria-label={_(msg`Role`)}
										placeholder={_(msg`Role (optional)`)}
										value={contact.role ?? ''}
										maxLength={80}
										disabled={disabled}
										aria-invalid={roleError ? true : undefined}
										onChange={(event) =>
											updateContact(contact.id, {
												role: event.target.value,
											})
										}
									/>
									<Input
										type="tel"
										inputMode="tel"
										aria-label={_(msg`Phone`)}
										placeholder="+15551234567"
										value={contact.phone}
										required
										disabled={disabled}
										aria-invalid={phoneError ? true : undefined}
										onChange={(event) =>
											updateContact(contact.id, {
												phone: event.target.value.trim(),
											})
										}
									/>
									<Button
										type="button"
										variant="ghost"
										size="icon"
										disabled={disabled || inUse}
										title={inUse ? _(msg`Used by a transfer case`) : undefined}
										aria-label={_(msg`Remove contact`)}
										onClick={() =>
											setContacts((current) =>
												current.filter((item) => item.id !== contact.id),
											)
										}
									>
										<Icon name="trash-2" />
									</Button>
									<div className="flex flex-col gap-1 sm:col-span-4">
										<FieldErrorText error={nameError} />
										<FieldErrorText error={roleError} />
										<FieldErrorText error={phoneError} />
									</div>
								</div>
							)
						})}
						<Button
							type="button"
							variant="outline"
							size="sm"
							className="self-start"
							disabled={disabled || contacts.length >= 20}
							onClick={() =>
								setContacts((current) => [
									...current,
									{
										id: localId('contact'),
										name: '',
										phone: '',
										role: null,
									},
								])
							}
						>
							<Icon name="user-plus" />
							<Trans>Add contact</Trans>
						</Button>
						<FieldErrorText error={fieldErrors.contacts} />
					</CardContent>
				</Card>
			</AnnotatedSection>

			<AnnotatedSection
				title={<Trans>Transfer cases</Trans>}
				description={
					<Trans>
						Describe when the agent should transfer to a specific contact. For
						example: "Questions about large group bookings".
					</Trans>
				}
			>
				<Card>
					<CardContent className="flex flex-col gap-5">
						{cases.length === 0 ? (
							<p className="text-muted-foreground text-sm">
								{contacts.length ? (
									<Trans>No transfer cases yet.</Trans>
								) : (
									<Trans>Add a contact first.</Trans>
								)}
							</p>
						) : null}
						{cases.map((item, index) => {
							const caseNumber = index + 1
							const whenError =
								fieldErrors[`transferCases.${index}.when`] ??
								fieldErrors[`transferCases.${index}.id`]
							return (
								<fieldset
									key={item.id}
									className="border-border flex flex-col gap-3 rounded-md border p-4"
								>
									<legend className="sr-only">
										<Trans>Transfer case {caseNumber}</Trans>
									</legend>
									<div className="flex items-start gap-2">
										<div className="flex flex-1 flex-col gap-1.5">
											<Label htmlFor={`case-when-${item.id}`}>
												<Trans>Transfer when</Trans>
											</Label>
											<Textarea
												id={`case-when-${item.id}`}
												rows={2}
												maxLength={300}
												required
												value={item.when}
												disabled={disabled}
												aria-invalid={whenError ? true : undefined}
												onChange={(event) =>
													updateCase(item.id, { when: event.target.value })
												}
											/>
											<FieldErrorText error={whenError} />
										</div>
										<Button
											type="button"
											variant="ghost"
											size="icon"
											disabled={disabled}
											aria-label={_(msg`Remove transfer case`)}
											onClick={() =>
												setCases((current) =>
													current.filter((other) => other.id !== item.id),
												)
											}
										>
											<Icon name="trash-2" />
										</Button>
									</div>
									<div className="grid gap-3 sm:grid-cols-3">
										<div className="flex flex-col gap-1.5">
											<Label htmlFor={`case-contact-${item.id}`}>
												<Trans>Transfer to</Trans>
											</Label>
											<Select
												value={item.contactId}
												disabled={disabled}
												items={contacts.map((contact) => ({
													value: contact.id,
													label: contact.name || contact.phone,
												}))}
												onValueChange={(value) => {
													if (value)
														updateCase(item.id, {
															contactId: String(value),
														})
												}}
											>
												<SelectTrigger
													id={`case-contact-${item.id}`}
													className="w-full"
													aria-invalid={
														fieldErrors[`transferCases.${index}.contactId`]
															? true
															: undefined
													}
												>
													<SelectValue />
												</SelectTrigger>
												<SelectContent>
													{contacts.map((contact) => (
														<SelectItem key={contact.id} value={contact.id}>
															{contact.name || contact.phone}
														</SelectItem>
													))}
												</SelectContent>
											</Select>
											<FieldErrorText
												error={fieldErrors[`transferCases.${index}.contactId`]}
											/>
										</div>
										<div className="flex flex-col gap-1.5">
											<Label htmlFor={`case-hours-${item.id}`}>
												<Trans>When</Trans>
											</Label>
											<HoursSelect
												id={`case-hours-${item.id}`}
												value={item.hours}
												disabled={disabled}
												onChange={(hours) => updateCase(item.id, { hours })}
											/>
										</div>
										<div className="flex flex-col gap-1.5">
											<Label htmlFor={`case-retries-${item.id}`}>
												<Trans>If nobody answers</Trans>
											</Label>
											<Select
												value={String(item.retries)}
												disabled={disabled}
												items={RETRY_OPTIONS.map((retries) => ({
													value: String(retries),
													label:
														retries === 0
															? _(msg`Don't retry`)
															: _(msg`Try ${retries} more times`),
												}))}
												onValueChange={(value) => {
													if (value != null)
														updateCase(item.id, { retries: Number(value) })
												}}
											>
												<SelectTrigger
													id={`case-retries-${item.id}`}
													className="w-full"
												>
													<SelectValue />
												</SelectTrigger>
												<SelectContent>
													{RETRY_OPTIONS.map((retries) => (
														<SelectItem key={retries} value={String(retries)}>
															{retries === 0
																? _(msg`Don't retry`)
																: _(msg`Try ${retries} more times`)}
														</SelectItem>
													))}
												</SelectContent>
											</Select>
										</div>
									</div>
									<div className="flex items-center gap-2">
										<Switch
											id={`case-active-${item.id}`}
											checked={item.isActive}
											disabled={disabled}
											onCheckedChange={(checked) =>
												updateCase(item.id, { isActive: checked })
											}
										/>
										<Label htmlFor={`case-active-${item.id}`}>
											<Trans>Active</Trans>
										</Label>
									</div>
								</fieldset>
							)
						})}
						<Button
							type="button"
							variant="outline"
							size="sm"
							className="self-start"
							disabled={disabled || !contacts.length || cases.length >= 20}
							onClick={() =>
								setCases((current) => [
									...current,
									{
										id: localId('case'),
										contactId: contacts[0]!.id,
										when: '',
										hours: 'business_hours',
										retries: 0,
										isActive: true,
									},
								])
							}
						>
							<Icon name="plus" />
							<Trans>Add transfer case</Trans>
						</Button>
					</CardContent>
				</Card>
			</AnnotatedSection>
			<SettingsSaveBar
				canUpdate={canUpdate}
				form={form}
				label={<Trans>Save transfers</Trans>}
			/>
		</form>
	)
}

function HoursSelect({
	id,
	value,
	disabled,
	onChange,
}: {
	id: string
	value: TransferHoursMode
	disabled: boolean
	onChange: (value: TransferHoursMode) => void
}) {
	const { _ } = useLingui()
	return (
		<Select
			value={value}
			disabled={disabled}
			items={TRANSFER_HOURS_MODES.map((mode) => ({
				value: mode,
				label: _(HOURS_LABELS[mode]),
			}))}
			onValueChange={(next) => {
				const mode = TRANSFER_HOURS_MODES.find((item) => item === next)
				if (mode) onChange(mode)
			}}
		>
			<SelectTrigger id={id} className="w-full">
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				{TRANSFER_HOURS_MODES.map((mode) => (
					<SelectItem key={mode} value={mode}>
						{_(HOURS_LABELS[mode])}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	)
}

function RatingsSection({
	csatEnabled,
	phrases,
	languages,
	businessName,
	versions,
	canUpdate,
	onDirtyChange,
}: {
	csatEnabled: LoaderData['csatEnabled']
	phrases: LoaderData['phrases']
	languages: LoaderData['languages']
	businessName: string
	versions: LoaderData['versions']
	canUpdate: boolean
	onDirtyChange: (dirty: boolean) => void
}) {
	const [askRating, setAskRating] = useState(csatEnabled)
	const drafts = usePhraseDrafts(phrases)
	const form = useSettingsFormState({
		saved: { csatEnabled, phrases },
		versions,
		draft: { csatEnabled: askRating, phrases: drafts.drafts },
		reset: (saved) => {
			setAskRating(saved.csatEnabled)
			drafts.reset(saved.phrases)
		},
		canUpdate,
	})
	const { pending, fieldErrors, save, dirty } = form
	useEffect(() => {
		onDirtyChange(dirty)
	}, [dirty, onDirtyChange])
	const disabled = !canUpdate || pending
	return (
		<form
			className="flex flex-col gap-6"
			onSubmit={(event) => {
				event.preventDefault()
				save({ csatEnabled: askRating, phrases: drafts.collect() })
			}}
		>
			<AnnotatedSection
				title={<Trans>Call ratings</Trans>}
				description={
					<Trans>
						Ask callers to rate the call from 1 to 5 before it ends. Ratings and
						the caller's mood appear on the Calls page and in Reports.
					</Trans>
				}
			>
				<Card>
					<CardContent className="flex flex-col gap-5">
						<div className="flex items-center justify-between gap-4">
							<Label htmlFor="csat-enabled">
								<Trans>Ask for a rating</Trans>
							</Label>
							<Switch
								id="csat-enabled"
								checked={askRating}
								disabled={disabled}
								onCheckedChange={(checked) => setAskRating(checked)}
							/>
						</div>
						{askRating ? (
							<PhraseOverridesSection
								keys={CSAT_PHRASE_KEYS}
								languages={languages}
								phrases={drafts}
								fieldErrors={fieldErrors}
								disabled={disabled}
								businessName={businessName}
							/>
						) : null}
						<FieldErrorText error={fieldErrors.phrases} />
					</CardContent>
				</Card>
			</AnnotatedSection>
			<SettingsSaveBar
				canUpdate={canUpdate}
				form={form}
				label={<Trans>Save ratings</Trans>}
			/>
		</form>
	)
}

function AfterCallSection({
	notifications: savedNotifications,
	followUp: savedFollowUp,
	tags: savedTags,
	versions,
	canUpdate,
	canUpdateAlerts,
	onDirtyChange,
}: {
	notifications: LoaderData['notifications']
	followUp: LoaderData['followUp']
	tags: LoaderData['tags']
	versions: LoaderData['versions']
	canUpdate: boolean
	canUpdateAlerts: boolean
	onDirtyChange: (dirty: boolean) => void
}) {
	const { _ } = useLingui()
	const [notifications, setNotifications] = useState(savedNotifications)
	const [followUp, setFollowUp] = useState(savedFollowUp)
	const [tags, setTags] = useState(savedTags)
	const form = useSettingsFormState({
		saved: {
			notifications: savedNotifications,
			followUp: savedFollowUp,
			tags: savedTags,
		},
		versions,
		draft: { notifications, followUp, tags },
		reset: (saved) => {
			setNotifications(saved.notifications)
			setFollowUp(saved.followUp)
			setTags(saved.tags)
		},
		canUpdate,
	})
	const { pending, fieldErrors, save, dirty } = form
	useEffect(() => {
		onDirtyChange(dirty)
	}, [dirty, onDirtyChange])
	const disabled = !canUpdate || pending
	const alertsDisabled = disabled || !canUpdateAlerts

	const hasRecipients =
		notifications.smsNumbers.length > 0 || notifications.emails.length > 0

	function toggleEvent(event: NotificationEvent, on: boolean) {
		setNotifications((current) => ({
			...current,
			events: on
				? NOTIFICATION_EVENTS.filter(
						(item) => item === event || current.events.includes(item),
					)
				: current.events.filter((item) => item !== event),
		}))
	}
	function updateTag(id: string, patch: Partial<CallTag>) {
		setTags((current) =>
			current.map((tag) => (tag.id === id ? { ...tag, ...patch } : tag)),
		)
	}

	return (
		<form
			className="flex flex-col gap-6"
			onSubmit={(event) => {
				event.preventDefault()
				save({
					...(canUpdateAlerts ? { notifications } : {}),
					followUp,
					tags,
				})
			}}
		>
			<AnnotatedSection
				title={<Trans>After the call</Trans>}
				description={
					<Trans>
						Alerts for your team, how calls that need follow-up close on their
						own, and tags to find them later.
					</Trans>
				}
			>
				<Card>
					<CardContent className="flex flex-col gap-5">
						{canUpdate && !canUpdateAlerts ? (
							<p
								role="status"
								className="text-muted-foreground flex items-start gap-2 text-sm"
							>
								<Icon name="lock" className="mt-0.5 shrink-0" />
								<Trans>
									Only people who can view calls can change staff alerts,
									because alerts include callers' numbers and call summaries.
								</Trans>
							</p>
						) : null}
						<FieldErrorText error={fieldErrors.notifications} />
						<ListInput
							id="smsNumbers"
							label={<Trans>Text these numbers</Trans>}
							hint={<Trans>Up to 4 mobile numbers, like +15551234567.</Trans>}
							values={notifications.smsNumbers}
							max={4}
							type="tel"
							placeholder="+15551234567"
							disabled={alertsDisabled}
							errors={Object.fromEntries(
								Object.entries(fieldErrors)
									.filter(([key]) => key.startsWith('notifications.smsNumbers'))
									.map(([key, value]) => [
										key.replace('notifications.', ''),
										value,
									]),
							)}
							onChange={(smsNumbers) =>
								setNotifications((current) => ({ ...current, smsNumbers }))
							}
						/>
						<ListInput
							id="emails"
							label={<Trans>Email these addresses</Trans>}
							hint={<Trans>Up to 5 addresses.</Trans>}
							values={notifications.emails}
							max={5}
							type="email"
							placeholder={_(msg`manager@example.com`)}
							disabled={alertsDisabled}
							errors={Object.fromEntries(
								Object.entries(fieldErrors)
									.filter(([key]) => key.startsWith('notifications.emails'))
									.map(([key, value]) => [
										key.replace('notifications.', ''),
										value,
									]),
							)}
							onChange={(emails) =>
								setNotifications((current) => ({ ...current, emails }))
							}
						/>
						<fieldset className="flex flex-col gap-3">
							<legend className="mb-1 text-sm font-medium">
								<Trans>Send an alert for</Trans>
							</legend>
							{NOTIFICATION_EVENTS.map((event) => (
								<label key={event} className="flex items-start gap-3 text-sm">
									<Checkbox
										className="mt-0.5"
										checked={notifications.events.includes(event)}
										disabled={alertsDisabled}
										onCheckedChange={(checked) =>
											toggleEvent(event, checked === true)
										}
									/>
									<span className="flex flex-col gap-0.5">
										<span>{_(EVENT_COPY[event].label)}</span>
										<span className="text-muted-foreground text-xs">
											{_(EVENT_COPY[event].hint)}
										</span>
									</span>
								</label>
							))}
						</fieldset>
						<div className="flex items-center justify-between gap-4">
							<Label htmlFor="notify-link">
								<Trans>Include a link to the call</Trans>
							</Label>
							<Switch
								id="notify-link"
								checked={notifications.includeCallLink}
								disabled={alertsDisabled}
								onCheckedChange={(checked) =>
									setNotifications((current) => ({
										...current,
										includeCallLink: checked,
									}))
								}
							/>
						</div>
						{!hasRecipients && notifications.events.length ? (
							<p className="text-muted-foreground text-xs">
								<Trans>Add a number or email to start sending alerts.</Trans>
							</p>
						) : null}
						<p className="text-muted-foreground text-xs">
							<Trans>Test calls never send alerts.</Trans>
						</p>
					</CardContent>
				</Card>
			</AnnotatedSection>

			<AnnotatedSection
				title={<Trans>Calls that need follow-up</Trans>}
				description={
					<Trans>
						Voicemails, callback requests, missed transfers, complaints, and low
						ratings stay open on the Calls page until someone marks them
						complete.
					</Trans>
				}
			>
				<Card>
					<CardContent className="flex flex-col gap-5">
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="follow-up-auto-resolve">
								<Trans>Mark complete automatically</Trans>
							</Label>
							<Select
								value={String(followUp.autoResolveAfterDays)}
								disabled={disabled}
								items={AUTO_RESOLVE_DAYS.map((days) => ({
									value: String(days),
									label:
										days === 0 ? _(msg`Never`) : _(msg`After ${days} days`),
								}))}
								onValueChange={(value) => {
									if (value != null)
										setFollowUp((current) => ({
											...current,
											autoResolveAfterDays: Number(value),
										}))
								}}
							>
								<SelectTrigger id="follow-up-auto-resolve" className="w-48">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{AUTO_RESOLVE_DAYS.map((days) => (
										<SelectItem key={days} value={String(days)}>
											{days === 0 ? _(msg`Never`) : _(msg`After ${days} days`)}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
							<p className="text-muted-foreground text-xs">
								<Trans>Calls with an important tag always stay open.</Trans>
							</p>
						</div>
						<div className="flex items-center justify-between gap-4">
							<div className="flex flex-col gap-1">
								<Label htmlFor="follow-up-transferred">
									<Trans>Keep transferred calls open</Trans>
								</Label>
								<p className="text-muted-foreground text-xs">
									<Trans>
										Useful if staff should log what happened after a transfer.
									</Trans>
								</p>
							</div>
							<Switch
								id="follow-up-transferred"
								checked={followUp.keepTransferredOpen}
								disabled={disabled}
								onCheckedChange={(checked) =>
									setFollowUp((current) => ({
										...current,
										keepTransferredOpen: checked,
									}))
								}
							/>
						</div>
					</CardContent>
				</Card>
			</AnnotatedSection>

			<AnnotatedSection
				title={<Trans>Tags</Trans>}
				description={
					<Trans>
						Label calls to find them later. With automatic tagging on, the agent
						applies the tag when the description fits the call.
					</Trans>
				}
			>
				<Card>
					<CardContent className="flex flex-col gap-4">
						{tags.map((tag, index) => {
							const nameError =
								fieldErrors[`tags.${index}.name`] ??
								fieldErrors[`tags.${index}.id`]
							const descriptionError = fieldErrors[`tags.${index}.description`]
							return (
								<fieldset
									key={index}
									className="border-border flex flex-col gap-3 rounded-md border p-4"
								>
									<legend className="sr-only">
										{tag.name || _(msg`New tag`)}
									</legend>
									<div className="flex items-center gap-2">
										<Input
											aria-label={_(msg`Tag name`)}
											placeholder={_(msg`Tag name`)}
											value={tag.name}
											maxLength={40}
											required
											disabled={disabled}
											aria-invalid={nameError ? true : undefined}
											onChange={(event) =>
												updateTag(tag.id, { name: event.target.value })
											}
										/>
										<Button
											type="button"
											variant="ghost"
											size="icon"
											disabled={disabled}
											aria-label={_(msg`Remove tag`)}
											onClick={() =>
												setTags((current) =>
													current.filter((item) => item.id !== tag.id),
												)
											}
										>
											<Icon name="trash-2" />
										</Button>
									</div>
									<FieldErrorText error={nameError} />
									<Input
										aria-label={_(msg`When to apply`)}
										placeholder={_(
											msg`When to apply, e.g. The caller mentions an allergy`,
										)}
										value={tag.description}
										maxLength={200}
										disabled={disabled}
										aria-invalid={descriptionError ? true : undefined}
										onChange={(event) =>
											updateTag(tag.id, {
												description: event.target.value,
											})
										}
									/>
									<FieldErrorText error={descriptionError} />
									<div className="flex flex-wrap gap-6">
										<label className="flex items-center gap-2 text-sm">
											<Switch
												checked={tag.autoApply}
												disabled={disabled || !tag.description.trim()}
												onCheckedChange={(checked) =>
													updateTag(tag.id, { autoApply: checked })
												}
											/>
											<Trans>Apply automatically</Trans>
										</label>
										<label className="flex items-center gap-2 text-sm">
											<Switch
												checked={tag.important}
												disabled={disabled}
												onCheckedChange={(checked) =>
													updateTag(tag.id, { important: checked })
												}
											/>
											<Trans>Important</Trans>
										</label>
									</div>
								</fieldset>
							)
						})}
						<FieldErrorText error={fieldErrors.tags} />
						<Button
							type="button"
							variant="outline"
							size="sm"
							className="self-start"
							disabled={disabled || tags.length >= 30}
							onClick={() =>
								setTags((current) => [
									...current,
									{
										id: localId('tag'),
										name: '',
										description: '',
										autoApply: false,
										important: false,
									},
								])
							}
						>
							<Icon name="tag" />
							<Trans>Add tag</Trans>
						</Button>
					</CardContent>
				</Card>
			</AnnotatedSection>
			<SettingsSaveBar
				canUpdate={canUpdate}
				form={form}
				label={<Trans>Save after-call settings</Trans>}
			/>
		</form>
	)
}

function ListInput({
	id,
	label,
	hint,
	values,
	max,
	type,
	placeholder,
	disabled,
	errors,
	onChange,
}: {
	id: string
	label: React.ReactNode
	hint: React.ReactNode
	values: string[]
	max: number
	type: 'tel' | 'email'
	placeholder: string
	disabled: boolean
	errors: Record<string, string>
	onChange: (values: string[]) => void
}) {
	const { _ } = useLingui()
	const [input, setInput] = useState('')
	function add() {
		const value = input.trim()
		if (!value || values.includes(value) || values.length >= max) return
		onChange([...values, value])
		setInput('')
	}
	const error = values
		.map((ignoredValue, index) => errors[`${id}.${index}`])
		.find(Boolean)
	return (
		<div className="flex flex-col gap-2">
			<Label htmlFor={`notify-${id}`}>{label}</Label>
			<div className="flex gap-2">
				<Input
					id={`notify-${id}`}
					type={type}
					inputMode={type}
					autoComplete="off"
					placeholder={placeholder}
					value={input}
					disabled={disabled || values.length >= max}
					onChange={(event) => setInput(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === 'Enter') {
							event.preventDefault()
							add()
						}
					}}
				/>
				<Button
					type="button"
					variant="outline"
					disabled={disabled || !input.trim() || values.length >= max}
					onClick={add}
				>
					<Trans>Add</Trans>
				</Button>
			</div>
			<p className="text-muted-foreground text-xs">{hint}</p>
			{values.length ? (
				<ul className="flex flex-wrap gap-2">
					{values.map((value) => (
						<li key={value}>
							<Badge variant="secondary" className="gap-1">
								{value}
								<button
									type="button"
									className="text-muted-foreground hover:text-foreground"
									aria-label={_(msg`Remove ${value}`)}
									disabled={disabled}
									onClick={() =>
										onChange(values.filter((item) => item !== value))
									}
								>
									<Icon name="x" size="xs" />
								</button>
							</Badge>
						</li>
					))}
				</ul>
			) : null}
			<FieldErrorText error={error ?? errors[id]} />
		</div>
	)
}

export function ErrorBoundary() {
	return <GeneralErrorBoundary />
}
