import { type MessageDescriptor } from '@lingui/core'
import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	type PhoneAgentContact,
	TRANSFER_HOURS_MODES,
	type TransferCase,
	type TransferHoursMode,
} from '@repo/phone-agent'
import { AnnotatedLayout, AnnotatedSection } from '@repo/ui/annotated-layout'
import { Button } from '@repo/ui/button'
import { Card, CardContent } from '@repo/ui/card'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import {
	Item,
	ItemContent,
	ItemDescription,
	ItemMedia,
	ItemTitle,
} from '@repo/ui/item'
import { Label } from '@repo/ui/label'
import { PageHeader } from '@repo/ui/page-header'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@repo/ui/select'
import { Switch } from '@repo/ui/switch'
import { Textarea } from '@repo/ui/textarea'
import { useState } from 'react'
import { Link, useLoaderData, useParams } from 'react-router'
import { GeneralErrorBoundary } from '#app/components/error-boundary.tsx'
import {
	FieldErrorText,
	localId,
	SettingsSaveBar,
	useSettingsForm,
} from '#app/components/phone-agent/settings-page.tsx'
import { type Route } from './+types/transfers.ts'

export { action, loader } from './transfers.server.ts'

type LoaderData = Route.ComponentProps['loaderData']

const HOURS_LABELS: Record<TransferHoursMode, MessageDescriptor> = {
	always: msg`Any time`,
	business_hours: msg`Only while you're open`,
}

const RETRY_OPTIONS = [0, 1, 2] as const

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

export default function PhoneAgentTransfers() {
	const { _ } = useLingui()
	const { orgSlug = '' } = useParams()
	const data = useLoaderData<LoaderData>()
	const { canUpdate } = data
	const staffPhone = data.escalationPhone
	const [transfers, setTransfers] = useState(data.transfers)
	const [contacts, setContacts] = useState(data.contacts)
	const [cases, setCases] = useState(data.transferCases)
	const [ringTimeout, setRingTimeout] = useState(
		String(data.transfers.ringTimeoutSeconds),
	)
	const form = useSettingsForm({
		saved: {
			transfers: data.transfers,
			contacts: data.contacts,
			transferCases: data.transferCases,
		},
		versions: data.versions,
		draft: { transfers, contacts, cases, ringTimeout },
		reset: (saved) => {
			setTransfers(saved.transfers)
			setRingTimeout(String(saved.transfers.ringTimeoutSeconds))
			setContacts(saved.contacts)
			setCases(saved.transferCases)
		},
		canUpdate,
	})
	const { pending, fieldErrors, save } = form
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
		<div className="flex flex-col gap-8">
			<PageHeader
				title={<Trans>Transfers</Trans>}
				description={
					<Trans>Who the agent connects callers to, and when.</Trans>
				}
			/>

			{data.transfersDisabled ? (
				<Item variant="muted" role="status">
					<ItemMedia variant="icon">
						<Icon name="alert-triangle" />
					</ItemMedia>
					<ItemContent>
						<ItemTitle>
							<Trans>Transfers are paused</Trans>
						</ItemTitle>
						<ItemDescription>
							<Trans>
								The agent won't transfer any calls until you turn transfers back
								on in{' '}
								<Link
									to={`/${orgSlug}/phone-agent/advanced`}
									className="underline underline-offset-4"
								>
									Advanced
								</Link>
								.
							</Trans>
						</ItemDescription>
					</ItemContent>
				</Item>
			) : null}

			<form
				className="flex flex-col gap-8"
				onSubmit={(event) => {
					event.preventDefault()
					save({
						transfers: {
							...transfers,
							ringTimeoutSeconds: Number(ringTimeout),
						},
						contacts: contacts.map((contact) => ({
							...contact,
							role: contact.role?.trim() || null,
						})),
						transferCases: cases,
					})
				}}
			>
				<AnnotatedLayout>
					<AnnotatedSection
						title={<Trans>Staff transfers</Trans>}
						description={
							<Trans>
								When the agent can't help, it transfers to your staff phone
								number from Setup.
							</Trans>
						}
					>
						<Card>
							<CardContent className="flex flex-col gap-5">
								<p className="text-muted-foreground text-sm">
									{data.autoEscalate && data.escalationPhone ? (
										<Trans>Staff phone: {staffPhone}</Trans>
									) : (
										<Trans>
											No staff phone is set, so only the transfer cases below
											can transfer calls.
										</Trans>
									)}{' '}
									<Link
										to={`/${orgSlug}/phone-agent`}
										className="underline underline-offset-4"
									>
										<Trans>Change in Setup</Trans>
									</Link>
								</p>
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
											fieldErrors['transfers.ringTimeoutSeconds']
												? true
												: undefined
										}
										onChange={(event) => setRingTimeout(event.target.value)}
									/>
									<FieldErrorText
										error={fieldErrors['transfers.ringTimeoutSeconds']}
									/>
								</div>
							</CardContent>
						</Card>
					</AnnotatedSection>

					<AnnotatedSection
						title={<Trans>Contacts</Trans>}
						description={
							<Trans>
								People or departments the agent can transfer to, like a manager.
								Use numbers that don't forward to the agent.
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
												title={
													inUse ? _(msg`Used by a transfer case`) : undefined
												}
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
								Describe when the agent should transfer to a specific contact.
								For example: "Questions about large group bookings".
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
														error={
															fieldErrors[`transferCases.${index}.contactId`]
														}
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
																<SelectItem
																	key={retries}
																	value={String(retries)}
																>
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
				</AnnotatedLayout>
				<SettingsSaveBar
					canUpdate={canUpdate}
					form={form}
					label={<Trans>Save transfers</Trans>}
				/>
			</form>
		</div>
	)
}

export function ErrorBoundary() {
	return <GeneralErrorBoundary />
}
