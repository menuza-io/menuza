import * as cartesia from '@livekit/agents-plugin-cartesia'
import * as deepgram from '@livekit/agents-plugin-deepgram'
import * as google from '@livekit/agents-plugin-google'
import {
	type AgentLanguage,
	buildKeyterms,
	createVerticalContext,
	type PhoneAgentRuntimeConfig,
	type PhoneAgentVertical,
	verticalKeyterms,
} from '@repo/phone-agent'
import { ENV } from 'varlock/env'
import { type SpeechLanguageControl, sttLanguageFor } from './language.ts'

/**
 * Deepgram, Gemini, and Cartesia are called on their US endpoints, so the
 * worker may only handle calls whose customer data lives in the US.
 */
export function assertUsDataRegion(region: string | undefined) {
	if (region !== 'us') {
		throw new Error(
			`The voice worker only runs with DATA_REGION=us (got "${region ?? ''}"): its speech and language providers are US-hosted.`,
		)
	}
}

export function createTts(language: string, voiceId?: string | null) {
	const voice = voiceId || ENV.CARTESIA_DEFAULT_VOICE_ID
	return new cartesia.TTS({
		apiKey: ENV.CARTESIA_API_KEY,
		model: 'sonic-3',
		language,
		...(voice ? { voice } : {}),
	})
}

/**
 * Deepgram's `STT.updateOptions` only applies to streams opened afterwards,
 * so this also updates the stream already listening to the caller. Each
 * updated stream reconnects to Deepgram, which can drop a fraction of a
 * second of audio.
 */
class LanguageSwitchingSTT extends deepgram.STT {
	readonly #streams = new Set<WeakRef<deepgram.SpeechStream>>()

	override stream(options?: Parameters<deepgram.STT['stream']>[0]) {
		const stream = super.stream(options)
		this.#streams.add(new WeakRef(stream))
		return stream
	}

	setLanguage(language: string) {
		this.updateOptions({ language })
		for (const ref of this.#streams) {
			const stream = ref.deref()
			if (!stream) {
				this.#streams.delete(ref)
				continue
			}
			try {
				stream.updateOptions({ language })
			} catch (error) {
				console.warn('Could not switch the speech recognition language', error)
				this.#streams.delete(ref)
			}
		}
	}
}

/**
 * Words speech recognition should expect: the owner's terms first, then the
 * business name and the vertical's terms (such as product names, the words
 * STT gets wrong most).
 */
export function speechKeyterms(
	config: PhoneAgentRuntimeConfig,
	vertical: PhoneAgentVertical,
) {
	return buildKeyterms({
		settings: config.settings,
		businessName: config.business.name,
		extraTerms: verticalKeyterms(
			vertical,
			createVerticalContext(vertical, config),
		),
	})
}

export function createModels(
	config: PhoneAgentRuntimeConfig,
	vertical: PhoneAgentVertical,
) {
	const { languages, voiceId } = config.settings
	const primary: AgentLanguage = languages[0] ?? 'en'
	const keyterm = speechKeyterms(config, vertical)

	const sttLanguage = sttLanguageFor(languages, primary)
	const stt = new LanguageSwitchingSTT({
		apiKey: ENV.DEEPGRAM_API_KEY,
		model: 'nova-3',
		language: sttLanguage,
		keyterm,
		smartFormat: true,
		numerals: true,
	})

	const llm = new google.LLM({
		apiKey: ENV.GOOGLE_API_KEY,
		model: ENV.PHONE_AGENT_LLM_MODEL || 'gemini-2.5-flash',
		temperature: 0.4,
	})

	// Sonic voices are multilingual, so the owner's voice stays and only the
	// language changes; Cartesia reads it per utterance, so it takes effect
	// from the next thing the agent says.
	const tts = createTts(primary, voiceId)

	const speech: SpeechLanguageControl = {
		setLanguage(language) {
			tts.updateOptions({ language })
			if (sttLanguage !== 'multi') stt.setLanguage(language)
		},
	}

	return { stt, llm, tts, speech }
}
