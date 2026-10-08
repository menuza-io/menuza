import { type MessageDescriptor } from '@lingui/core'
import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	type AgentLanguage,
	isEditablePhraseKey,
	PHRASE_TEXT_MAX,
	phraseDefinitionsFor,
	type PhraseKey,
	type PhraseOverride,
} from '@repo/phone-agent'
import { AnnotatedLayout, AnnotatedSection } from '@repo/ui/annotated-layout'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Card, CardContent } from '@repo/ui/card'
import { Label } from '@repo/ui/label'
import { PageHeader } from '@repo/ui/page-header'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@repo/ui/tabs'
import { Textarea } from '@repo/ui/textarea'
import { useState } from 'react'
import { useLoaderData } from 'react-router'
import { GeneralErrorBoundary } from '#app/components/error-boundary.tsx'
import {
	FieldErrorText,
	SettingsSaveBar,
	useSettingsForm,
} from '#app/components/phone-agent/settings-page.tsx'
import { phoneAgentVerticalUi } from '#app/components/phone-agent/vertical-ui.tsx'
import { phoneAgentVertical } from '#app/utils/phone-agent/vertical.ts'
import { type Route } from './+types/phrases.ts'

export { action, loader } from './phrases.server.ts'

type LoaderData = Route.ComponentProps['loaderData']

const LANGUAGE_LABELS: Record<AgentLanguage, MessageDescriptor> = {
	en: msg`English`,
	es: msg`Spanish`,
	ar: msg`Arabic`,
}

const PHRASE_COPY: Record<
	PhraseKey,
	{ label: MessageDescriptor; hint: MessageDescriptor }
> = {
	disclosure: {
		label: msg`Automated assistant notice`,
		hint: msg`Played at the start of every call. It tells callers they're speaking with an automated assistant.`,
	},
	recording_notice: {
		label: msg`Recording notice`,
		hint: msg`Played right after the assistant notice when recording is on. It tells callers the call may be recorded.`,
	},
	menu_retry: {
		label: msg`Didn't catch that`,
		hint: msg`Played before a keypad menu repeats because the choice was unclear.`,
	},
	menu_invalid: {
		label: msg`Wrong key`,
		hint: msg`Played before a keypad menu repeats because the key pressed is not one of its options.`,
	},
	hold: {
		label: msg`Hold message`,
		hint: msg`Played while a transfer is ringing.`,
	},
	transfer_connecting: {
		label: msg`Transfer answered`,
		hint: msg`Played when staff pick up, just before the assistant leaves the call.`,
	},
	transfer_no_answer: {
		label: msg`Nobody answered`,
		hint: msg`Played when a transfer is not picked up.`,
	},
	transfer_unavailable: {
		label: msg`Transfers unavailable`,
		hint: msg`Played when transfers are off or outside transfer hours.`,
	},
	transfer_text_offer: {
		label: msg`Offer a text if nobody answers`,
		hint: msg`Asked before a transfer when texting the caller back is on.`,
	},
	transfer_text_sent: {
		label: msg`Follow-up text sent`,
		hint: msg`Played after texting the caller because nobody answered.`,
	},
	transfer_text_failed: {
		label: msg`Follow-up text not sent`,
		hint: msg`Played when nobody answered and the text to the caller could not be sent.`,
	},
	calling_disabled: {
		label: msg`Assistant paused`,
		hint: msg`Played before passing the call to your business line while the assistant is paused.`,
	},
	trouble: {
		label: msg`Something went wrong`,
		hint: msg`Played when the phone system can't answer the call.`,
	},
	call_time_limit: {
		label: msg`Call time limit`,
		hint: msg`Played before the goodbye when a call reaches its maximum length.`,
	},
	text_link_sent: {
		label: msg`Link sent`,
		hint: msg`Played after the link is texted.`,
	},
	text_link_blocked: {
		label: msg`Can't text that number`,
		hint: msg`Played when the link can't be texted to the caller.`,
	},
	voicemail_prompt: {
		label: msg`Voicemail instructions`,
		hint: msg`Played before a voicemail step starts listening, when the step has no message of its own.`,
	},
	voicemail_saved: {
		label: msg`Voicemail saved`,
		hint: msg`Played after the caller's message is saved.`,
	},
	voicemail_failed: {
		label: msg`Voicemail not saved`,
		hint: msg`Played when the caller's message could not be saved.`,
	},
	voicemail_empty: {
		label: msg`No message heard`,
		hint: msg`Played when a voicemail step hears nothing from the caller.`,
	},
	csat_question: {
		label: msg`Rating question`,
		hint: msg`Asked at the end of the call when call ratings are on.`,
	},
	csat_thanks: {
		label: msg`Rating thanks`,
		hint: msg`Played after a rating of 3 to 5.`,
	},
	csat_low: {
		label: msg`Low rating`,
		hint: msg`Played after a rating of 1 or 2.`,
	},
	goodbye: {
		label: msg`Goodbye`,
		hint: msg`Played when the call ends without a hang-up message of its own.`,
	},
}

/** Phrases grouped by the moment in the call they're spoken. */
const PHRASE_GROUPS: {
	title: MessageDescriptor
	description: MessageDescriptor
	keys: PhraseKey[]
}[] = [
	{
		title: msg`Start of the call`,
		description: msg`What callers hear before anything else, and when the assistant can't answer.`,
		keys: ['disclosure', 'recording_notice', 'calling_disabled', 'trouble'],
	},
	{
		title: msg`Keypad menu`,
		description: msg`Said while callers choose an option.`,
		keys: ['menu_retry', 'menu_invalid'],
	},
	{
		title: msg`Transfers`,
		description: msg`Said while connecting callers to your team.`,
		keys: [
			'hold',
			'transfer_connecting',
			'transfer_no_answer',
			'transfer_unavailable',
			'transfer_text_offer',
			'transfer_text_sent',
			'transfer_text_failed',
		],
	},
	{
		title: msg`Texted links`,
		description: msg`Said after the assistant tries to text a link.`,
		keys: ['text_link_sent', 'text_link_blocked'],
	},
	{
		title: msg`Voicemail`,
		description: msg`Said when a caller leaves a message.`,
		keys: [
			'voicemail_prompt',
			'voicemail_saved',
			'voicemail_failed',
			'voicemail_empty',
		],
	},
	{
		title: msg`End of the call`,
		description: msg`The time-limit notice, the rating question, and the goodbye.`,
		keys: [
			'call_time_limit',
			'csat_question',
			'csat_thanks',
			'csat_low',
			'goodbye',
		],
	},
]

const BUSINESS_TOKEN = '{business}'

const PHRASE_DEFINITIONS = phraseDefinitionsFor(phoneAgentVertical)

function phraseCopy(key: PhraseKey) {
	return { ...PHRASE_COPY[key], ...phoneAgentVerticalUi.phraseCopy?.[key] }
}

type Drafts = Record<string, string>

function draftKey(key: PhraseKey, language: AgentLanguage) {
	return `${language}:${key}`
}

function toDrafts(overrides: PhraseOverride[]): Drafts {
	return Object.fromEntries(
		overrides.map((override) => [
			draftKey(override.key, override.language),
			override.text,
		]),
	)
}

export default function PhoneAgentPhrases() {
	const { _ } = useLingui()
	const { phrases, languages, businessName, canUpdate, versions } =
		useLoaderData<LoaderData>()
	const [drafts, setDrafts] = useState<Drafts>(() => toDrafts(phrases))
	const [language, setLanguage] = useState<AgentLanguage>(languages[0] ?? 'en')
	const form = useSettingsForm({
		saved: phrases,
		versions,
		draft: drafts,
		reset: (saved) => setDrafts(toDrafts(saved)),
		canUpdate,
	})
	const { pending, fieldErrors, save } = form
	const disabled = !canUpdate || pending
	// Field errors are keyed by position in the saved list (`phrases.3.text`),
	// so remember which draft each position came from.
	const [submittedKeys, setSubmittedKeys] = useState<string[]>([])
	const errorFor = (key: PhraseKey, lang: AgentLanguage) => {
		const index = submittedKeys.indexOf(draftKey(key, lang))
		return index === -1 ? undefined : fieldErrors[`phrases.${index}.text`]
	}

	const customized = (lang: AgentLanguage) =>
		PHRASE_DEFINITIONS.filter(
			(definition) =>
				isEditablePhraseKey(definition.key) &&
				drafts[draftKey(definition.key, lang)]?.trim(),
		).length

	const groups = (lang: AgentLanguage) => (
		<AnnotatedLayout>
			{PHRASE_GROUPS.map((group) => (
				<AnnotatedSection
					key={group.keys[0]}
					title={_(group.title)}
					description={_(group.description)}
				>
					<Card>
						<CardContent className="flex flex-col gap-6">
							{group.keys.map((key) => (
								<PhraseField
									key={key}
									phraseKey={key}
									language={lang}
									value={drafts[draftKey(key, lang)] ?? ''}
									error={errorFor(key, lang)}
									disabled={disabled}
									onChange={(text) =>
										setDrafts((current) => {
											const next = { ...current }
											if (text === null) delete next[draftKey(key, lang)]
											else next[draftKey(key, lang)] = text
											return next
										})
									}
								/>
							))}
						</CardContent>
					</Card>
				</AnnotatedSection>
			))}
		</AnnotatedLayout>
	)

	return (
		<div className="flex flex-col gap-8">
			<PageHeader
				title={<Trans>Phrases</Trans>}
				description={
					<Trans>
						The fixed lines the phone system says outside of conversation with
						the AI assistant. Leave a line empty to use the default.{' '}
						{BUSINESS_TOKEN} is replaced with {businessName}.
					</Trans>
				}
			/>
			<form
				className="flex flex-col gap-8"
				onSubmit={(event) => {
					event.preventDefault()
					const overrides: PhraseOverride[] = []
					for (const [keyed, text] of Object.entries(drafts)) {
						const [lang, key] = keyed.split(':') as [AgentLanguage, PhraseKey]
						const definition = PHRASE_DEFINITIONS.find(
							(item) => item.key === key,
						)
						const value = text.trim()
						if (
							!definition ||
							!isEditablePhraseKey(key) ||
							!value ||
							value === definition.defaults[lang]
						)
							continue
						overrides.push({ key, language: lang, text: value })
					}
					setSubmittedKeys(
						overrides.map((override) =>
							draftKey(override.key, override.language),
						),
					)
					save({ phrases: overrides })
				}}
			>
				{languages.length > 1 ? (
					<Tabs
						value={language}
						onValueChange={(value) => {
							const next = languages.find((item) => item === value)
							if (next) setLanguage(next)
						}}
					>
						<TabsList>
							{languages.map((lang) => (
								<TabsTrigger key={lang} value={lang}>
									{_(LANGUAGE_LABELS[lang])}
									{customized(lang) ? (
										<Badge variant="secondary">{customized(lang)}</Badge>
									) : null}
								</TabsTrigger>
							))}
						</TabsList>
						{languages.map((lang) => (
							<TabsContent key={lang} value={lang} className="pt-6">
								{groups(lang)}
							</TabsContent>
						))}
					</Tabs>
				) : (
					groups(language)
				)}
				<FieldErrorText error={fieldErrors.phrases} />
				<SettingsSaveBar
					canUpdate={canUpdate}
					form={form}
					label={<Trans>Save phrases</Trans>}
				/>
			</form>
		</div>
	)
}

function PhraseField({
	phraseKey,
	language,
	value,
	error,
	disabled,
	onChange,
}: {
	phraseKey: PhraseKey
	language: AgentLanguage
	value: string
	error?: string
	disabled: boolean
	onChange: (text: string | null) => void
}) {
	const { _ } = useLingui()
	const definition = PHRASE_DEFINITIONS.find((item) => item.key === phraseKey)
	if (!definition) return null
	const id = `phrase-${language}-${phraseKey}`
	const copy = phraseCopy(phraseKey)
	const textDirection = language === 'ar' ? 'rtl' : undefined

	if (!isEditablePhraseKey(phraseKey)) {
		return (
			<div className="flex flex-col gap-1.5">
				<div className="flex items-center gap-2">
					<span className="text-sm font-medium">{_(copy.label)}</span>
					<Badge variant="secondary">
						<Trans>Required</Trans>
					</Badge>
				</div>
				<p
					dir={textDirection}
					lang={language}
					className="bg-muted text-muted-foreground rounded-md px-3 py-2 text-sm"
				>
					{definition.defaults[language]}
				</p>
				<p className="text-muted-foreground text-xs">
					{_(copy.hint)}{' '}
					<Trans>The law requires this line, so it can't be changed.</Trans>
				</p>
			</div>
		)
	}

	return (
		<div className="flex flex-col gap-1.5">
			<div className="flex min-h-7 items-center justify-between gap-2">
				<Label htmlFor={id}>{_(copy.label)}</Label>
				{value.trim() ? (
					<Button
						type="button"
						variant="ghost"
						size="sm"
						disabled={disabled}
						onClick={() => onChange(null)}
					>
						<Trans>Use default</Trans>
					</Button>
				) : null}
			</div>
			<Textarea
				id={id}
				dir={textDirection}
				lang={language}
				rows={2}
				maxLength={PHRASE_TEXT_MAX}
				placeholder={definition.defaults[language]}
				value={value}
				disabled={disabled}
				aria-invalid={error ? true : undefined}
				aria-describedby={error ? `${id}-hint ${id}-error` : `${id}-hint`}
				onChange={(event) => onChange(event.target.value)}
			/>
			<p id={`${id}-hint`} className="text-muted-foreground text-xs">
				{_(copy.hint)}
			</p>
			<FieldErrorText id={`${id}-error`} error={error} />
		</div>
	)
}

export function ErrorBoundary() {
	return <GeneralErrorBoundary />
}
