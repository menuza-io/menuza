import { type AgentLanguage } from '@repo/phone-agent'

/** Languages Deepgram's nova-3 "multi" mode transcribes together in one stream. */
const MULTI_STT_LANGUAGES: readonly AgentLanguage[] = ['en', 'es']

/**
 * The Deepgram language for a line with these languages, while the call is
 * in `current`. "multi" code-switching covers English and Spanish but not
 * Arabic, so a line that includes Arabic listens in one language at a time:
 * the primary one first, then whatever `switch_language` picks.
 */
export function sttLanguageFor(
	languages: readonly AgentLanguage[],
	current: AgentLanguage,
) {
	return languages.length > 1 &&
		languages.every((language) => MULTI_STT_LANGUAGES.includes(language))
		? 'multi'
		: current
}

/** What the speech models need to change when the call changes language. */
export type SpeechLanguageControl = {
	setLanguage(language: AgentLanguage): void
}
