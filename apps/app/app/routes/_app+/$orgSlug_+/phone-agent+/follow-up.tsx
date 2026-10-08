import { type MessageDescriptor } from '@lingui/core'
import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	AUTO_RESOLVE_DAYS,
	type CallTag,
	NOTIFICATION_EVENTS,
	type NotificationEvent,
} from '@repo/phone-agent'
import { AnnotatedLayout, AnnotatedSection } from '@repo/ui/annotated-layout'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Card, CardContent } from '@repo/ui/card'
import { Checkbox } from '@repo/ui/checkbox'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
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
import { useState } from 'react'
import { useLoaderData } from 'react-router'
import { GeneralErrorBoundary } from '#app/components/error-boundary.tsx'
import {
	FieldErrorText,
	localId,
	SettingsSaveBar,
	useSettingsForm,
} from '#app/components/phone-agent/settings-page.tsx'
import { type Route } from './+types/follow-up.ts'

export { action, loader } from './follow-up.server.ts'

type LoaderData = Route.ComponentProps['loaderData']

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

export default function PhoneAgentFollowUp() {
	const { _ } = useLingui()
	const data = useLoaderData<LoaderData>()
	const { canUpdate, canUpdateAlerts } = data
	const [notifications, setNotifications] = useState(data.notifications)
	const [followUp, setFollowUp] = useState(data.followUp)
	const [tags, setTags] = useState(data.tags)
	const form = useSettingsForm({
		saved: {
			notifications: data.notifications,
			followUp: data.followUp,
			tags: data.tags,
		},
		versions: data.versions,
		draft: { notifications, followUp, tags },
		reset: (saved) => {
			setNotifications(saved.notifications)
			setFollowUp(saved.followUp)
			setTags(saved.tags)
		},
		canUpdate,
	})
	const { pending, fieldErrors, save } = form
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
		<div className="flex flex-col gap-8">
			<PageHeader
				title={<Trans>Follow-up</Trans>}
				description={
					<Trans>
						Alerts for your team, call tags, and when calls that need follow-up
						close on their own.
					</Trans>
				}
			/>
			<form
				className="flex flex-col gap-8"
				onSubmit={(event) => {
					event.preventDefault()
					save({
						...(canUpdateAlerts ? { notifications } : {}),
						followUp,
						tags,
					})
				}}
			>
				<AnnotatedLayout>
					<AnnotatedSection
						title={<Trans>Staff alerts</Trans>}
						description={
							<Trans>
								Send a short call summary by text or email when something needs
								attention. Alerts include the caller's number.
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
											because alerts include callers' numbers and call
											summaries.
										</Trans>
									</p>
								) : null}
								<FieldErrorText error={fieldErrors.notifications} />
								<ListInput
									id="smsNumbers"
									label={<Trans>Text these numbers</Trans>}
									hint={
										<Trans>Up to 4 mobile numbers, like +15551234567.</Trans>
									}
									values={notifications.smsNumbers}
									max={4}
									type="tel"
									placeholder="+15551234567"
									disabled={alertsDisabled}
									errors={Object.fromEntries(
										Object.entries(fieldErrors)
											.filter(([key]) =>
												key.startsWith('notifications.smsNumbers'),
											)
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
										<label
											key={event}
											className="flex items-start gap-3 text-sm"
										>
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
										<Trans>
											Add a number or email to start sending alerts.
										</Trans>
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
								Voicemails, callback requests, missed transfers, complaints, and
								low ratings stay open on the Calls page until someone marks them
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
													{days === 0
														? _(msg`Never`)
														: _(msg`After ${days} days`)}
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
												Useful if staff should log what happened after a
												transfer.
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
								Label calls to find them later. With automatic tagging on, the
								agent applies the tag when the description fits the call.
							</Trans>
						}
					>
						<Card>
							<CardContent className="flex flex-col gap-4">
								{tags.map((tag, index) => {
									const nameError =
										fieldErrors[`tags.${index}.name`] ??
										fieldErrors[`tags.${index}.id`]
									const descriptionError =
										fieldErrors[`tags.${index}.description`]
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
													updateTag(tag.id, { description: event.target.value })
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
				</AnnotatedLayout>
				<SettingsSaveBar
					canUpdate={canUpdate}
					form={form}
					label={<Trans>Save follow-up settings</Trans>}
				/>
			</form>
		</div>
	)
}

export function ErrorBoundary() {
	return <GeneralErrorBoundary />
}
