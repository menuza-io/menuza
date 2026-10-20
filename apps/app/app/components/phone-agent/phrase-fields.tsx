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
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from '@repo/ui/collapsible'
import { Icon } from '@repo/ui/icon'
import { Label } from '@repo/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@repo/ui/tabs'
import { Textarea } from '@repo/ui/textarea'
import { useCallback, useState } from 'react'
import { phoneAgentVertical } from '#app/utils/phone-agent/vertical.ts'
import { FieldErrorText } from './settings-page.tsx'
import { phoneAgentVerticalUi } from './vertical-ui.tsx'

export const LANGUAGE_LABELS: Record<AgentLanguage, MessageDescriptor> = {
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
		label: msg`Agent turned off`,
		hint: msg`Played before passing the call to your business line while the agent is off.`,
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

const PHRASE_DEFINITIONS = phraseDefinitionsFor(phoneAgentVertical)

const BUSINESS_TOKEN = '{business}'

function phraseCopy(key: PhraseKey) {
	return { ...PHRASE_COPY[key], ...phoneAgentVerticalUi.phraseCopy?.[key] }
}

type PhraseDrafts = Record<string, string>

function draftKey(key: PhraseKey, language: AgentLanguage) {
	return `${language}:${key}`
}

function toDrafts(overrides: PhraseOverride[]): PhraseDrafts {
	return Object.fromEntries(
		overrides.map((override) => [
			draftKey(override.key, override.language),
			override.text,
		]),
	)
}

function collectOverrides(
	drafts: PhraseDrafts,
	keys?: ReadonlySet<PhraseKey>,
): PhraseOverride[] {
	const overrides: PhraseOverride[] = []
	for (const [keyed, text] of Object.entries(drafts)) {
		const [language, key] = keyed.split(':') as [AgentLanguage, PhraseKey]
		const definition = PHRASE_DEFINITIONS.find((item) => item.key === key)
		const value = text.trim()
		if (
			!definition ||
			!isEditablePhraseKey(key) ||
			(keys && !keys.has(key)) ||
			!value ||
			value === definition.defaults[language]
		)
			continue
		overrides.push({ key, language, text: value })
	}
	return overrides
}

function sameOverrides(left: PhraseOverride[], right: PhraseOverride[]) {
	const sorted = (overrides: PhraseOverride[]) =>
		[...overrides].sort(
			(a, b) =>
				a.key.localeCompare(b.key) || a.language.localeCompare(b.language),
		)
	return JSON.stringify(sorted(left)) === JSON.stringify(sorted(right))
}

/**
 * Phrase overrides edited on a settings page. `patch(keys)` sends only one
 * feature's lines plus the values they started from, so the server merges
 * them without touching (or conflicting with) lines saved by other forms.
 */
export function usePhraseDrafts(saved: PhraseOverride[]) {
	const [drafts, setDrafts] = useState<PhraseDrafts>(() => toDrafts(saved))
	// Keep the snapshot this editor began from while sibling forms revalidate.
	const [base, setBase] = useState(saved)
	// Field errors are keyed by position in the saved list (`phrases.3.text`),
	// so remember which draft each position came from.
	const [submittedKeys, setSubmittedKeys] = useState<string[]>([])

	const reset = useCallback((next: PhraseOverride[]) => {
		setDrafts(toDrafts(next))
		setBase(next)
	}, [])

	const setText = useCallback(
		(key: PhraseKey, language: AgentLanguage, text: string | null) => {
			setDrafts((current) => {
				const next = { ...current }
				if (text === null) delete next[draftKey(key, language)]
				else next[draftKey(key, language)] = text
				return next
			})
		},
		[],
	)

	/** The overrides to save. Lines equal to their default are dropped. */
	function collect(): PhraseOverride[] {
		const overrides = collectOverrides(drafts)
		setSubmittedKeys(
			overrides.map((override) => draftKey(override.key, override.language)),
		)
		return overrides
	}

	/** A scoped patch merges this feature's lines without clobbering siblings. */
	function patch(keys: readonly PhraseKey[]) {
		const phraseKeys = keys.filter(isEditablePhraseKey)
		const allowed = new Set(phraseKeys)
		const phraseBase = base.filter((override) => allowed.has(override.key))
		const phrases = collectOverrides(drafts, allowed)
		if (sameOverrides(phraseBase, phrases)) return {}
		setSubmittedKeys(
			phrases.map((override) => draftKey(override.key, override.language)),
		)
		return { phrases, phraseKeys, phraseBase }
	}

	function errorFor(
		fieldErrors: Record<string, string>,
		key: PhraseKey,
		language: AgentLanguage,
	) {
		const index = submittedKeys.indexOf(draftKey(key, language))
		return index === -1 ? undefined : fieldErrors[`phrases.${index}.text`]
	}

	return { drafts, reset, setText, collect, patch, errorFor }
}

export type PhraseDraftsState = ReturnType<typeof usePhraseDrafts>

export function activePhraseLanguage(
	language: AgentLanguage,
	shownLanguages: readonly AgentLanguage[],
) {
	return shownLanguages.includes(language) ? language : shownLanguages[0]!
}

/**
 * The fixed lines for one feature, folded away under "Customize what the
 * agent says" because the defaults work for most businesses.
 */
export function PhraseOverridesSection({
	keys,
	languages,
	phrases,
	fieldErrors,
	disabled,
	businessName,
}: {
	keys: readonly PhraseKey[]
	languages: readonly AgentLanguage[]
	phrases: PhraseDraftsState
	fieldErrors: Record<string, string>
	disabled: boolean
	businessName: string
}) {
	const { _ } = useLingui()
	const [open, setOpen] = useState(false)
	const shownLanguages: AgentLanguage[] = languages.length
		? [...languages]
		: ['en']
	const [language, setLanguage] = useState<AgentLanguage>(shownLanguages[0]!)
	const activeLanguage = activePhraseLanguage(language, shownLanguages)
	const customized = keys.filter(
		(key) =>
			isEditablePhraseKey(key) &&
			shownLanguages.some((lang) =>
				phrases.drafts[draftKey(key, lang)]?.trim(),
			),
	).length
	const hasError = keys.some((key) =>
		shownLanguages.some((lang) => phrases.errorFor(fieldErrors, key, lang)),
	)

	const fields = (lang: AgentLanguage) => (
		<div className="flex flex-col gap-5">
			{keys.map((key) => (
				<PhraseField
					key={key}
					phraseKey={key}
					language={lang}
					value={phrases.drafts[draftKey(key, lang)] ?? ''}
					error={phrases.errorFor(fieldErrors, key, lang)}
					disabled={disabled}
					onChange={(text) => phrases.setText(key, lang, text)}
				/>
			))}
		</div>
	)

	return (
		<Collapsible open={open || hasError} onOpenChange={setOpen}>
			<CollapsibleTrigger
				render={
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className="-ms-2 self-start"
					/>
				}
			>
				<Icon name={open || hasError ? 'chevron-down' : 'chevron-right'} />
				<Trans>Customize what the agent says</Trans>
				{customized ? (
					<Badge variant="secondary">{_(msg`${customized} changed`)}</Badge>
				) : null}
			</CollapsibleTrigger>
			<CollapsibleContent>
				<div className="flex flex-col gap-4 pt-3">
					<p className="text-muted-foreground text-xs">
						<Trans>
							Leave a line empty to use the default. {BUSINESS_TOKEN} is
							replaced with {businessName}.
						</Trans>
					</p>
					{shownLanguages.length > 1 ? (
						<Tabs
							value={activeLanguage}
							onValueChange={(value) => {
								const next = shownLanguages.find((item) => item === value)
								if (next) setLanguage(next)
							}}
						>
							<TabsList>
								{shownLanguages.map((lang) => (
									<TabsTrigger key={lang} value={lang}>
										{_(LANGUAGE_LABELS[lang])}
									</TabsTrigger>
								))}
							</TabsList>
							{shownLanguages.map((lang) => (
								<TabsContent key={lang} value={lang} className="pt-3">
									{fields(lang)}
								</TabsContent>
							))}
						</Tabs>
					) : (
						fields(shownLanguages[0]!)
					)}
				</div>
			</CollapsibleContent>
		</Collapsible>
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
