import { type MessageDescriptor } from '@lingui/core'
import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	AFTER_HOURS_MODES,
	type AfterHoursMode,
	type AgentLanguage,
	type PhoneAgentSettings,
	type PhraseKey,
	RECORDING_RETENTION_DAYS,
	SUPPORTED_AGENT_LANGUAGES,
} from '@repo/phone-agent'
import { cn } from '@repo/ui'
import { AnnotatedLayout, AnnotatedSection } from '@repo/ui/annotated-layout'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Card, CardContent } from '@repo/ui/card'
import { Checkbox } from '@repo/ui/checkbox'
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
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@repo/ui/select'
import { Separator } from '@repo/ui/separator'
import { Switch } from '@repo/ui/switch'
import { Textarea } from '@repo/ui/textarea'
import { type ReactNode, useState } from 'react'
import { Link, useFetcher, useLoaderData, useParams } from 'react-router'
import { GeneralErrorBoundary } from '#app/components/error-boundary.tsx'
import { AgentDetails } from '#app/components/phone-agent/agent-details.tsx'
import { PhoneNumbersSection } from '#app/components/phone-agent/phone-number-dialogs.tsx'
import {
	LANGUAGE_LABELS,
	PhraseOverridesSection,
	usePhraseDrafts,
} from '#app/components/phone-agent/phrase-fields.tsx'
import {
	PhoneAgentSettingsHeader,
	usePhoneAgentLayoutData,
} from '#app/components/phone-agent/settings-nav.tsx'
import {
	FieldErrorText,
	type SettingsSaveResult,
	SettingsSaveBar,
	useSettingsErrorText,
	useSettingsForm,
} from '#app/components/phone-agent/settings-page.tsx'
import { useTestCallHref } from '#app/components/phone-agent/test-call-sheet.tsx'
import { VoicePicker } from '#app/components/phone-agent/voice-picker.tsx'
import { type Route } from './+types/_index.ts'

export { action, loader } from './_index.server.ts'

const AFTER_HOURS_LABELS: Record<AfterHoursMode, MessageDescriptor> = {
	answer_and_link: msg`Answer questions and text links`,
	answer_only: msg`Answer questions only`,
	take_message: msg`Take a message`,
}

/** Lines spoken around the conversation itself, edited with the greeting. */
const AGENT_PHRASE_KEYS: PhraseKey[] = [
	'disclosure',
	'recording_notice',
	'goodbye',
	'call_time_limit',
	'calling_disabled',
	'trouble',
]

type LoaderData = Route.ComponentProps['loaderData']

/**
 * "Pause the AI assistant" used to be a separate switch. Both it and
 * `enabled` pass calls to the business line, so the page shows one switch.
 */
function isAgentOn(settings: Pick<PhoneAgentSettings, 'enabled' | 'safety'>) {
	return settings.enabled && !settings.safety.callingDisabled
}

/** The patch for the single on/off switch; it also clears an old pause. */
function onOffPatch(
	on: boolean,
	settings: Pick<PhoneAgentSettings, 'safety'>,
): Partial<PhoneAgentSettings> {
	return settings.safety.callingDisabled
		? { enabled: on, safety: { ...settings.safety, callingDisabled: false } }
		: { enabled: on }
}

type AgentFields = Pick<
	PhoneAgentSettings,
	| 'agentName'
	| 'languages'
	| 'voiceId'
	| 'greeting'
	| 'closing'
	| 'recordCalls'
	| 'recordingRetentionDays'
	| 'afterHoursMode'
	| 'maxCallMinutes'
	| 'phrases'
> & { on: boolean }

function agentFields(settings: PhoneAgentSettings): AgentFields {
	return {
		on: isAgentOn(settings),
		agentName: settings.agentName,
		languages: settings.languages,
		voiceId: settings.voiceId ?? null,
		greeting: settings.greeting,
		closing: settings.closing,
		recordCalls: settings.recordCalls,
		recordingRetentionDays: settings.recordingRetentionDays,
		afterHoursMode: settings.afterHoursMode,
		maxCallMinutes: settings.maxCallMinutes,
		phrases: settings.phrases,
	}
}

export default function PhoneAgentSetup() {
	const { orgSlug = '' } = useParams()
	const {
		settings,
		versions,
		businessName,
		numbers,
		assignableNumbers,
		scopes,
		activeRuleCount,
		faqAnswerCount,
		canUpdate,
		voiceLibraryAvailable,
	} = useLoaderData<LoaderData>()
	const layout = usePhoneAgentLayoutData()
	const base = `/${orgSlug}/phone-agent`

	return (
		<div className="flex flex-col gap-8">
			<PhoneAgentSettingsHeader active="agent" />

			<GetStarted
				base={base}
				hasNumber={numbers.some((number) => number.isActive)}
				knowsBusiness={faqAnswerCount > 0 || activeRuleCount > 0}
				liveKitConfigured={Boolean(layout?.liveKitConfigured)}
				settings={settings}
				versions={versions}
				canUpdate={canUpdate}
			/>

			<AnnotatedLayout>
				<div id="phone-numbers" className="scroll-mt-6">
					<PhoneNumbersSection
						numbers={numbers}
						assignableNumbers={assignableNumbers}
						scopes={scopes}
						canUpdate={canUpdate}
					/>
				</div>
				<SettingsForm
					settings={settings}
					versions={versions}
					businessName={businessName}
					canUpdate={canUpdate}
					base={base}
					voiceLibraryAvailable={voiceLibraryAvailable}
				/>
			</AnnotatedLayout>

			<Separator />
			<AgentDetails />
		</div>
	)
}

type SetupStepItem = {
	key: string
	done: boolean
	title: ReactNode
	/** Shown only while the step is open. */
	hint: ReactNode
	action: (isNext: boolean) => ReactNode
}

function ChecklistStatusIcon({
	done,
	isNext,
}: {
	done: boolean
	isNext: boolean
}) {
	const { _ } = useLingui()
	if (done) {
		return (
			<span
				role="img"
				aria-label={_(msg`Done`)}
				className="bg-success/15 text-success flex size-5 shrink-0 items-center justify-center rounded-full"
			>
				<Icon name="check" className="size-3" />
			</span>
		)
	}
	return (
		<span
			role="img"
			aria-label={_(msg`Not done`)}
			className={cn(
				'flex size-5 shrink-0 items-center justify-center rounded-full border-2',
				isNext ? 'border-primary' : 'border-border-strong border-dashed',
			)}
		>
			{isNext ? <span className="bg-primary size-2 rounded-full" /> : null}
		</span>
	)
}

/**
 * First-time setup in four steps. Each step links to the one place its
 * setting lives; the card goes away once the agent is answering calls.
 */
function GetStarted({
	base,
	hasNumber,
	knowsBusiness,
	liveKitConfigured,
	settings,
	versions,
	canUpdate,
}: {
	base: string
	hasNumber: boolean
	knowsBusiness: boolean
	liveKitConfigured: boolean
	settings: PhoneAgentSettings
	versions: LoaderData['versions']
	canUpdate: boolean
}) {
	const { _ } = useLingui()
	const describe = useSettingsErrorText()
	const fetcher = useFetcher<SettingsSaveResult>()
	const testHref = useTestCallHref()
	const on = isAgentOn(settings)
	if (hasNumber && on) return null

	const turningOn = fetcher.state !== 'idle'
	const turnOnError =
		fetcher.state === 'idle' && fetcher.data && !fetcher.data.ok
			? describe(fetcher.data.error)
			: undefined

	function turnOn() {
		const patch = onOffPatch(true, settings)
		void fetcher.submit(
			{
				intent: 'save-settings',
				patch,
				versions: Object.fromEntries(
					Object.keys(patch).map((key) => [key, versions[key] ?? '']),
				),
			} as Parameters<typeof fetcher.submit>[0],
			{ method: 'POST', encType: 'application/json' },
		)
	}

	const steps: SetupStepItem[] = [
		{
			key: 'number',
			done: hasNumber,
			title: <Trans>Connect a phone number</Trans>,
			hint: (
				<Trans>Use a number we assign, or forward your business line.</Trans>
			),
			action: (isNext) => (
				<Button
					size="sm"
					variant={isNext ? 'default' : 'outline'}
					render={<a href="#phone-numbers" />}
				>
					<Trans>Add a number</Trans>
				</Button>
			),
		},
		{
			key: 'knowledge',
			done: knowsBusiness,
			title: <Trans>Tell it about your business</Trans>,
			hint: (
				<Trans>
					Answer common questions, or let AI draft the answers from your
					business details.
				</Trans>
			),
			action: (isNext) => (
				<Button
					size="sm"
					variant={isNext ? 'default' : 'outline'}
					render={<Link to={`${base}/knowledge`} />}
				>
					<Trans>Add answers</Trans>
				</Button>
			),
		},
		{
			key: 'test',
			// A test call leaves nothing behind to check, so this step closes
			// together with the last one.
			done: on,
			title: <Trans>Make a test call</Trans>,
			hint: (
				<Trans>Talk to your agent from this browser before callers do.</Trans>
			),
			action: (isNext) => (
				<Button
					size="sm"
					variant={isNext ? 'default' : 'outline'}
					render={<Link to={testHref} preventScrollReset />}
				>
					<Icon name="mic" />
					<Trans>Start a test call</Trans>
				</Button>
			),
		},
		{
			key: 'on',
			done: on,
			title: <Trans>Turn on the agent</Trans>,
			hint: <Trans>It starts answering on the next call.</Trans>,
			action: (isNext) =>
				canUpdate ? (
					<Button
						type="button"
						size="sm"
						variant={isNext || nextKey === 'test' ? 'default' : 'outline'}
						disabled={turningOn}
						onClick={turnOn}
					>
						{turningOn ? <Trans>Turning on…</Trans> : <Trans>Turn on</Trans>}
					</Button>
				) : null,
		},
	]
	const doneCount = steps.filter((step) => step.done).length
	const total = steps.length
	const nextKey = steps.find((step) => !step.done)?.key

	return (
		<Card className="gap-0 py-0">
			<div className="flex flex-col gap-1 px-4 pt-4 pb-3">
				<div className="flex items-center gap-2">
					<h2 className="text-sm font-semibold tracking-tight">
						<Trans>Get your agent answering calls</Trans>
					</h2>
					<Badge variant="secondary" className="tabular-nums">
						<Trans>
							{doneCount} of {total} done
						</Trans>
					</Badge>
				</div>
				<p className="text-muted-foreground text-sm">
					<Trans>
						Four steps. Everything else has defaults you can change later.
					</Trans>
				</p>
			</div>

			<div
				className="bg-muted mx-4 mb-1 h-1 overflow-hidden rounded-full"
				role="progressbar"
				aria-valuemin={0}
				aria-valuemax={total}
				aria-valuenow={doneCount}
				aria-label={_(msg`${doneCount} of ${total} steps done`)}
			>
				<div
					className="bg-primary ease-out-quint h-full rounded-full transition-[width] duration-500 motion-reduce:transition-none"
					style={{ width: `${(doneCount / total) * 100}%` }}
				/>
			</div>

			{liveKitConfigured ? null : (
				<div className="px-4 pt-3">
					<Item variant="muted" role="status">
						<ItemMedia variant="icon">
							<Icon name="alert-triangle" />
						</ItemMedia>
						<ItemContent>
							<ItemTitle>
								<Trans>The voice service isn't set up yet</Trans>
							</ItemTitle>
							<ItemDescription>
								<Trans>
									Your platform administrator sets the LiveKit credentials.
									Until then, calls and test calls won't connect.
								</Trans>
							</ItemDescription>
						</ItemContent>
					</Item>
				</div>
			)}

			<ol className="divide-y">
				{steps.map((step) => {
					const isNext = step.key === nextKey
					const action = step.done ? null : step.action(isNext)
					return (
						<li
							key={step.key}
							className="flex min-h-12 items-center gap-3 px-4 py-2.5"
						>
							<ChecklistStatusIcon done={step.done} isNext={isNext} />
							<div className="min-w-0 flex-1">
								<p
									className={cn(
										'text-sm',
										step.done
											? 'text-muted-foreground'
											: 'text-foreground font-medium',
									)}
								>
									{step.title}
								</p>
								{step.done ? null : (
									<p className="text-muted-foreground text-xs">{step.hint}</p>
								)}
							</div>
							{action ? <div className="shrink-0">{action}</div> : null}
						</li>
					)
				})}
			</ol>

			{turnOnError ? (
				<p role="alert" className="text-destructive px-4 pb-3 text-sm">
					{turnOnError}
				</p>
			) : null}
		</Card>
	)
}

function SettingsForm({
	settings,
	versions,
	businessName,
	canUpdate,
	base,
	voiceLibraryAvailable,
}: {
	settings: PhoneAgentSettings
	versions: LoaderData['versions']
	businessName: string
	canUpdate: boolean
	base: string
	voiceLibraryAvailable: boolean
}) {
	const { _ } = useLingui()
	const [on, setOn] = useState(isAgentOn(settings))
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
	const [afterHoursMode, setAfterHoursMode] = useState<AfterHoursMode>(
		settings.afterHoursMode,
	)
	const [maxCallMinutes, setMaxCallMinutes] = useState(
		String(settings.maxCallMinutes),
	)
	const phrases = usePhraseDrafts(settings.phrases)

	const form = useSettingsForm({
		saved: agentFields(settings),
		versions,
		draft: [
			on,
			agentName,
			languages,
			voiceId,
			greeting,
			closing,
			recordCalls,
			retentionDays,
			afterHoursMode,
			maxCallMinutes,
			phrases.drafts,
		],
		reset: (saved) => {
			setOn(saved.on)
			setAgentName(saved.agentName)
			setLanguages(saved.languages)
			setVoiceId(saved.voiceId ?? '')
			setGreeting(saved.greeting)
			setClosing(saved.closing)
			setRecordCalls(saved.recordCalls)
			setRetentionDays(String(saved.recordingRetentionDays))
			setAfterHoursMode(saved.afterHoursMode)
			setMaxCallMinutes(String(saved.maxCallMinutes))
			phrases.reset(saved.phrases)
		},
		canUpdate,
		intent: 'save-settings',
	})
	const { pending, fieldErrors } = form
	const disabled = !canUpdate || pending
	const defaultLanguage = languages[0] ? _(LANGUAGE_LABELS[languages[0]]) : null

	function toggleLanguage(language: AgentLanguage, checked: boolean) {
		setLanguages((current) =>
			checked
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
				form.save({
					...onOffPatch(on, settings),
					agentName,
					languages,
					voiceId: voiceId.trim() || null,
					greeting,
					closing,
					recordCalls,
					recordingRetentionDays: Number(retentionDays),
					afterHoursMode,
					maxCallMinutes: Number(maxCallMinutes),
					phrases: phrases.collect(),
				})
			}}
		>
			<AnnotatedSection
				id="agent-settings"
				title={<Trans>Agent</Trans>}
				description={
					<Trans>Who answers, in which languages, and with which voice.</Trans>
				}
			>
				<Card>
					<CardContent className="flex flex-col gap-5">
						<div className="flex items-center justify-between gap-4">
							<div className="flex flex-col gap-1">
								<Label htmlFor="phone-agent-enabled">
									<Trans>Answer calls with the AI agent</Trans>
								</Label>
								<p
									id="phone-agent-enabled-hint"
									className="text-muted-foreground text-xs"
								>
									<Trans>
										When it's off, calls go straight to your business line. If
										no line is known, callers hear an apology.
									</Trans>
								</p>
							</div>
							<Switch
								id="phone-agent-enabled"
								checked={on}
								disabled={disabled}
								aria-describedby="phone-agent-enabled-hint"
								onCheckedChange={(checked) => setOn(checked)}
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
						<PhraseOverridesSection
							keys={AGENT_PHRASE_KEYS}
							languages={languages}
							phrases={phrases}
							fieldErrors={fieldErrors}
							disabled={disabled}
							businessName={businessName}
						/>
						<FieldErrorText error={fieldErrors.phrases} />
					</CardContent>
				</Card>
			</AnnotatedSection>

			<AnnotatedSection
				title={<Trans>Calls</Trans>}
				description={
					<Trans>
						Recording, what happens when you're closed, and how long calls can
						last. Transfers are in Call handling.
					</Trans>
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
				disabled={languages.length === 0}
				label={<Trans>Save settings</Trans>}
			/>
		</form>
	)
}

export function ErrorBoundary() {
	return <GeneralErrorBoundary />
}
