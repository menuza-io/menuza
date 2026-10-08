import { type MessageDescriptor } from '@lingui/core'
import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	AFTER_HOURS_MODES,
	type AfterHoursMode,
	type AgentLanguage,
	type PhoneAgentSettings,
	RECORDING_RETENTION_DAYS,
	SUPPORTED_AGENT_LANGUAGES,
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
import { Textarea } from '@repo/ui/textarea'
import { type ReactNode, useState } from 'react'
import {
	Link,
	useLoaderData,
	useParams,
	useRouteLoaderData,
} from 'react-router'
import { GeneralErrorBoundary } from '#app/components/error-boundary.tsx'
import { PhoneNumbersSection } from '#app/components/phone-agent/phone-number-dialogs.tsx'
import {
	FieldErrorText,
	SettingsSaveBar,
	useSettingsForm,
} from '#app/components/phone-agent/settings-page.tsx'
import { VoicePicker } from '#app/components/phone-agent/voice-picker.tsx'
import { type Route } from './+types/_index.ts'
import { type loader as layoutLoader } from './_layout.tsx'

export { action, loader } from './_index.server.ts'

const LAYOUT_ROUTE_ID = 'routes/_app+/$orgSlug_+/phone-agent+/_layout'

const LANGUAGE_LABELS: Record<AgentLanguage, MessageDescriptor> = {
	en: msg`English`,
	es: msg`Spanish`,
	ar: msg`Arabic`,
}

const AFTER_HOURS_LABELS: Record<AfterHoursMode, MessageDescriptor> = {
	answer_and_link: msg`Answer questions and text links`,
	answer_only: msg`Answer questions only`,
	take_message: msg`Take a message`,
}

type LoaderData = Route.ComponentProps['loaderData']

type SetupFields = Pick<
	PhoneAgentSettings,
	| 'enabled'
	| 'agentName'
	| 'languages'
	| 'voiceId'
	| 'greeting'
	| 'closing'
	| 'recordCalls'
	| 'recordingRetentionDays'
	| 'autoEscalate'
	| 'escalationPhone'
	| 'afterHoursMode'
	| 'maxCallMinutes'
>

function setupFields(settings: PhoneAgentSettings): SetupFields {
	return {
		enabled: settings.enabled,
		agentName: settings.agentName,
		languages: settings.languages,
		voiceId: settings.voiceId ?? null,
		greeting: settings.greeting,
		closing: settings.closing,
		recordCalls: settings.recordCalls,
		recordingRetentionDays: settings.recordingRetentionDays,
		autoEscalate: settings.autoEscalate,
		escalationPhone: settings.escalationPhone ?? null,
		afterHoursMode: settings.afterHoursMode,
		maxCallMinutes: settings.maxCallMinutes,
	}
}

export default function PhoneAgentSetup() {
	const { orgSlug = '' } = useParams()
	const {
		settings,
		versions,
		publishedFlowVersionId,
		numbers,
		assignableNumbers,
		scopes,
		activeRuleCount,
		canUpdate,
		voiceLibraryAvailable,
	} = useLoaderData<LoaderData>()
	const layout = useRouteLoaderData<typeof layoutLoader>(LAYOUT_ROUTE_ID)
	const base = `/${orgSlug}/phone-agent`

	return (
		<div className="flex flex-col gap-8">
			<PageHeader
				title={<Trans>Phone agent</Trans>}
				description={
					<Trans>
						An AI agent that answers your business's calls, answers common
						questions, and texts callers helpful links.
					</Trans>
				}
				actions={
					<Badge variant={settings.enabled ? 'default' : 'secondary'}>
						{settings.enabled ? <Trans>On</Trans> : <Trans>Off</Trans>}
					</Badge>
				}
			/>

			<GoLiveChecklist
				base={base}
				hasNumber={numbers.some((number) => number.isActive)}
				flowPublished={Boolean(publishedFlowVersionId)}
				liveKitConfigured={Boolean(layout?.liveKitConfigured)}
				enabled={settings.enabled}
				activeRuleCount={activeRuleCount}
			/>

			<AnnotatedLayout>
				<PhoneNumbersSection
					numbers={numbers}
					assignableNumbers={assignableNumbers}
					scopes={scopes}
					canUpdate={canUpdate}
				/>
				<SettingsForm
					settings={settings}
					versions={versions}
					canUpdate={canUpdate}
					base={base}
					voiceLibraryAvailable={voiceLibraryAvailable}
				/>
			</AnnotatedLayout>
		</div>
	)
}

function ChecklistItem({
	done,
	children,
}: {
	done: boolean
	children: ReactNode
}) {
	const { _ } = useLingui()
	return (
		<li className="flex items-start gap-3 text-sm">
			<Icon
				name={done ? 'circle-check' : 'circle'}
				className={
					done ? 'text-primary mt-0.5' : 'text-muted-foreground mt-0.5'
				}
				aria-label={done ? _(msg`Done`) : _(msg`Not done`)}
			/>
			<div className="min-w-0 flex-1">{children}</div>
		</li>
	)
}

function GoLiveChecklist({
	base,
	hasNumber,
	flowPublished,
	liveKitConfigured,
	enabled,
	activeRuleCount,
}: {
	base: string
	hasNumber: boolean
	flowPublished: boolean
	liveKitConfigured: boolean
	enabled: boolean
	activeRuleCount: number
}) {
	return (
		<Card>
			<CardContent className="flex flex-col gap-4">
				<div className="flex flex-col gap-1">
					<h2 className="text-base font-semibold">
						<Trans>Go-live checklist</Trans>
					</h2>
					<p className="text-muted-foreground text-sm">
						<Trans>The agent answers calls once every step is done.</Trans>
					</p>
				</div>
				<ul className="flex flex-col gap-3">
					<ChecklistItem done={hasNumber}>
						<Trans>Connect a phone number</Trans>
						<span className="text-muted-foreground block text-xs">
							<Trans>Add it in Phone numbers below.</Trans>
						</span>
					</ChecklistItem>
					<ChecklistItem done={flowPublished}>
						<Link
							to={`${base}/flow`}
							className="underline-offset-4 hover:underline"
						>
							<Trans>Publish a call flow</Trans>
						</Link>
					</ChecklistItem>
					<ChecklistItem done={liveKitConfigured}>
						<Trans>Voice service configured</Trans>
						<span className="text-muted-foreground block text-xs">
							<Trans>
								LiveKit credentials are set by your platform administrator.
							</Trans>
						</span>
					</ChecklistItem>
					<ChecklistItem done={enabled}>
						<Trans>Turn on the agent</Trans>
						<span className="text-muted-foreground block text-xs">
							<Trans>Use the switch in Agent settings below.</Trans>
						</span>
					</ChecklistItem>
				</ul>
				<div className="flex flex-wrap gap-2">
					<Button
						variant="outline"
						size="sm"
						render={
							<Link to={`${base}/training`}>
								<Trans>Training rules ({activeRuleCount} active)</Trans>
							</Link>
						}
					/>
					<Button
						variant="outline"
						size="sm"
						render={
							<Link to={`${base}/test`}>
								<Icon name="mic" />
								<Trans>Test the agent</Trans>
							</Link>
						}
					/>
				</div>
			</CardContent>
		</Card>
	)
}

function SettingsForm({
	settings,
	versions,
	canUpdate,
	base,
	voiceLibraryAvailable,
}: {
	settings: PhoneAgentSettings
	versions: LoaderData['versions']
	canUpdate: boolean
	base: string
	voiceLibraryAvailable: boolean
}) {
	const { _ } = useLingui()
	const [enabled, setEnabled] = useState(settings.enabled)
	const [agentName, setAgentName] = useState(settings.agentName)
	const [languages, setLanguages] = useState<AgentLanguage[]>(
		settings.languages,
	)
	const [voiceId, setVoiceId] = useState(settings.voiceId ?? '')
	const [greeting, setGreeting] = useState(settings.greeting)
	const [closing, setClosing] = useState(settings.closing)
	const [recordCalls, setRecordCalls] = useState(settings.recordCalls)
	const [retentionDays, setRetentionDays] = useState(
		String(settings.recordingRetentionDays),
	)
	const [autoEscalate, setAutoEscalate] = useState(settings.autoEscalate)
	const [escalationPhone, setEscalationPhone] = useState(
		settings.escalationPhone ?? '',
	)
	const [afterHoursMode, setAfterHoursMode] = useState<AfterHoursMode>(
		settings.afterHoursMode,
	)
	const [maxCallMinutes, setMaxCallMinutes] = useState(
		String(settings.maxCallMinutes),
	)

	const form = useSettingsForm({
		saved: setupFields(settings),
		versions,
		draft: [
			enabled,
			agentName,
			languages,
			voiceId,
			greeting,
			closing,
			recordCalls,
			retentionDays,
			autoEscalate,
			escalationPhone,
			afterHoursMode,
			maxCallMinutes,
		],
		reset: (saved) => {
			setEnabled(saved.enabled)
			setAgentName(saved.agentName)
			setLanguages(saved.languages)
			setVoiceId(saved.voiceId ?? '')
			setGreeting(saved.greeting)
			setClosing(saved.closing)
			setRecordCalls(saved.recordCalls)
			setRetentionDays(String(saved.recordingRetentionDays))
			setAutoEscalate(saved.autoEscalate)
			setEscalationPhone(saved.escalationPhone ?? '')
			setAfterHoursMode(saved.afterHoursMode)
			setMaxCallMinutes(String(saved.maxCallMinutes))
		},
		canUpdate,
		intent: 'save-settings',
	})
	const { pending, fieldErrors } = form
	const disabled = !canUpdate || pending
	const escalationMissing = autoEscalate && !escalationPhone.trim()
	const defaultLanguage = languages[0] ? _(LANGUAGE_LABELS[languages[0]]) : null

	function toggleLanguage(language: AgentLanguage, on: boolean) {
		setLanguages((current) =>
			on
				? current.includes(language)
					? current
					: [...current, language]
				: current.filter((value) => value !== language),
		)
	}

	return (
		<form
			className="flex flex-col gap-8 md:gap-10"
			onSubmit={(event) => {
				event.preventDefault()
				const next: Partial<PhoneAgentSettings> = {
					enabled,
					agentName,
					languages,
					voiceId: voiceId.trim() || null,
					greeting,
					closing,
					recordCalls,
					recordingRetentionDays: Number(retentionDays),
					autoEscalate,
					escalationPhone: escalationPhone.trim() || null,
					afterHoursMode,
					maxCallMinutes: Number(maxCallMinutes),
				}
				form.save(next)
			}}
		>
			<AnnotatedSection
				title={<Trans>Agent settings</Trans>}
				description={
					<Trans>Who answers, in which languages, and with which voice.</Trans>
				}
			>
				<Card>
					<CardContent className="flex flex-col gap-5">
						<div className="flex items-center justify-between gap-4">
							<Label htmlFor="phone-agent-enabled">
								<Trans>Answer calls with the AI agent</Trans>
							</Label>
							<Switch
								id="phone-agent-enabled"
								checked={enabled}
								disabled={disabled}
								onCheckedChange={(checked) => setEnabled(checked)}
							/>
						</div>

						<div className="flex flex-col gap-1.5">
							<Label htmlFor="phone-agent-name">
								<Trans>Agent name</Trans>
							</Label>
							<Input
								id="phone-agent-name"
								value={agentName}
								maxLength={60}
								required
								disabled={disabled}
								aria-invalid={fieldErrors.agentName ? true : undefined}
								aria-describedby="phone-agent-name-hint"
								onChange={(event) => setAgentName(event.target.value)}
							/>
							<p
								id="phone-agent-name-hint"
								className="text-muted-foreground text-xs"
							>
								<Trans>
									The name the agent uses when it introduces itself.
								</Trans>
							</p>
							<FieldErrorText error={fieldErrors.agentName} />
						</div>

						<fieldset className="flex flex-col gap-2">
							<legend className="mb-1 text-sm font-medium">
								<Trans>Languages</Trans>
							</legend>
							<div className="flex flex-wrap gap-4">
								{SUPPORTED_AGENT_LANGUAGES.map((language) => (
									<label
										key={language}
										className="flex items-center gap-2 text-sm"
									>
										<Checkbox
											checked={languages.includes(language)}
											disabled={disabled}
											onCheckedChange={(checked) =>
												toggleLanguage(language, checked === true)
											}
										/>
										{_(LANGUAGE_LABELS[language])}
									</label>
								))}
							</div>
							<p className="text-muted-foreground text-xs">
								{defaultLanguage ? (
									<Trans>
										Default: {defaultLanguage}. The first language you select is
										the default; callers can switch to the others.
									</Trans>
								) : null}
							</p>
							{languages.length === 0 ? (
								<FieldErrorText error={_(msg`Select at least one language.`)} />
							) : (
								<FieldErrorText error={fieldErrors.languages} />
							)}
						</fieldset>

						{voiceLibraryAvailable ? (
							<VoicePicker
								base={base}
								voiceId={voiceId}
								onChange={setVoiceId}
								disabled={disabled}
								canPreview={canUpdate}
								language={languages[0] ?? settings.languages[0] ?? 'en'}
								agentName={agentName}
								greeting={greeting}
								error={fieldErrors.voiceId}
							/>
						) : (
							<div className="flex flex-col gap-1.5">
								<Label htmlFor="phone-agent-voice">
									<Trans>Voice ID (optional)</Trans>
								</Label>
								<Input
									id="phone-agent-voice"
									value={voiceId}
									maxLength={120}
									disabled={disabled}
									aria-describedby="phone-agent-voice-hint"
									onChange={(event) => setVoiceId(event.target.value)}
								/>
								<p
									id="phone-agent-voice-hint"
									className="text-muted-foreground text-xs"
								>
									<Trans>
										Cartesia voice ID. Leave empty for the default voice.
									</Trans>
								</p>
								<FieldErrorText error={fieldErrors.voiceId} />
							</div>
						)}
					</CardContent>
				</Card>
			</AnnotatedSection>

			<AnnotatedSection
				title={<Trans>What the agent says</Trans>}
				description={
					<Trans>
						The greeting is used when the AI assistant answers first. The
						closing line ends calls when a step has no goodbye of its own.
					</Trans>
				}
			>
				<Card>
					<CardContent className="flex flex-col gap-5">
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="phone-agent-greeting">
								<Trans>Greeting</Trans>
							</Label>
							<Textarea
								id="phone-agent-greeting"
								value={greeting}
								rows={2}
								maxLength={400}
								required
								disabled={disabled}
								aria-invalid={fieldErrors.greeting ? true : undefined}
								onChange={(event) => setGreeting(event.target.value)}
							/>
							<FieldErrorText error={fieldErrors.greeting} />
						</div>
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="phone-agent-closing">
								<Trans>Closing</Trans>
							</Label>
							<Textarea
								id="phone-agent-closing"
								value={closing}
								rows={2}
								maxLength={300}
								required
								disabled={disabled}
								aria-invalid={fieldErrors.closing ? true : undefined}
								onChange={(event) => setClosing(event.target.value)}
							/>
							<FieldErrorText error={fieldErrors.closing} />
						</div>
					</CardContent>
				</Card>
			</AnnotatedSection>

			<AnnotatedSection
				title={<Trans>Call handling</Trans>}
				description={
					<Trans>Recording, transfers to staff, and after-hours calls.</Trans>
				}
			>
				<Card>
					<CardContent className="flex flex-col gap-5">
						<div className="flex flex-col gap-3">
							<div className="flex items-center justify-between gap-4">
								<Label htmlFor="phone-agent-record">
									<Trans>Record calls</Trans>
								</Label>
								<Switch
									id="phone-agent-record"
									checked={recordCalls}
									disabled={disabled}
									aria-describedby="phone-agent-record-hint"
									onCheckedChange={(checked) => setRecordCalls(checked)}
								/>
							</div>
							<p
								id="phone-agent-record-hint"
								className="text-muted-foreground text-xs"
							>
								<Trans>
									The agent tells callers the call is recorded. Some US states
									require consent from everyone on the call.
								</Trans>
							</p>
							{recordCalls ? (
								<div className="flex flex-col gap-1.5">
									<Label htmlFor="phone-agent-retention">
										<Trans>Keep recordings for</Trans>
									</Label>
									<Select
										value={retentionDays}
										disabled={disabled}
										items={RECORDING_RETENTION_DAYS.map((days) => ({
											value: String(days),
											label: _(msg`${days} days`),
										}))}
										onValueChange={(value) => {
											if (value) setRetentionDays(String(value))
										}}
									>
										<SelectTrigger id="phone-agent-retention" className="w-48">
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											{RECORDING_RETENTION_DAYS.map((days) => (
												<SelectItem key={days} value={String(days)}>
													{_(msg`${days} days`)}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
									<FieldErrorText error={fieldErrors.recordingRetentionDays} />
								</div>
							) : null}
						</div>

						<div className="flex flex-col gap-3">
							<div className="flex items-center justify-between gap-4">
								<Label htmlFor="phone-agent-escalate">
									<Trans>Transfer to staff when the agent can't help</Trans>
								</Label>
								<Switch
									id="phone-agent-escalate"
									checked={autoEscalate}
									disabled={disabled}
									onCheckedChange={(checked) => setAutoEscalate(checked)}
								/>
							</div>
							{autoEscalate ? (
								<div className="flex flex-col gap-1.5">
									<Label htmlFor="phone-agent-escalation-phone">
										<Trans>Staff phone number</Trans>
									</Label>
									<Input
										id="phone-agent-escalation-phone"
										type="tel"
										inputMode="tel"
										autoComplete="off"
										placeholder="+15551234567"
										value={escalationPhone}
										disabled={disabled}
										aria-invalid={
											fieldErrors.escalationPhone ? true : undefined
										}
										aria-describedby="phone-agent-escalation-hint"
										onChange={(event) => setEscalationPhone(event.target.value)}
									/>
									<p
										id="phone-agent-escalation-hint"
										className="text-muted-foreground text-xs"
									>
										<Trans>
											International format, for example +15551234567. Use a line
											that doesn't forward to the agent.
										</Trans>
									</p>
									<FieldErrorText error={fieldErrors.escalationPhone} />
								</div>
							) : null}
						</div>

						<div className="flex flex-col gap-1.5">
							<Label htmlFor="phone-agent-after-hours">
								<Trans>When you're closed</Trans>
							</Label>
							<Select
								value={afterHoursMode}
								disabled={disabled}
								items={AFTER_HOURS_MODES.map((mode) => ({
									value: mode,
									label: _(AFTER_HOURS_LABELS[mode]),
								}))}
								onValueChange={(value) => {
									const mode = AFTER_HOURS_MODES.find((item) => item === value)
									if (mode) setAfterHoursMode(mode)
								}}
							>
								<SelectTrigger id="phone-agent-after-hours" className="w-full">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{AFTER_HOURS_MODES.map((mode) => (
										<SelectItem key={mode} value={mode}>
											{_(AFTER_HOURS_LABELS[mode])}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>

						<div className="flex flex-col gap-1.5">
							<Label htmlFor="phone-agent-max-minutes">
								<Trans>Maximum call length (minutes)</Trans>
							</Label>
							<Input
								id="phone-agent-max-minutes"
								type="number"
								min={2}
								max={30}
								step={1}
								required
								className="w-32"
								value={maxCallMinutes}
								disabled={disabled}
								aria-invalid={fieldErrors.maxCallMinutes ? true : undefined}
								onChange={(event) => setMaxCallMinutes(event.target.value)}
							/>
							<FieldErrorText error={fieldErrors.maxCallMinutes} />
						</div>
					</CardContent>
				</Card>
			</AnnotatedSection>

			<SettingsSaveBar
				canUpdate={canUpdate}
				form={form}
				disabled={languages.length === 0 || escalationMissing}
				label={<Trans>Save settings</Trans>}
			/>
		</form>
	)
}

export function ErrorBoundary() {
	return <GeneralErrorBoundary />
}
