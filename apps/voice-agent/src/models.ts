import { inference } from '@livekit/agents'
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
import { modelProviders } from './model-providers.ts'

const STT_MODEL = 'nova-3'
const TTS_MODEL = 'sonic-3'
const DEFAULT_LLM_MODEL = 'gemini-2.5-flash'

// Inference types language codes with a brand the SDK doesn't export a
// constructor for; it normalizes plain codes like `es` itself.
type InferenceLanguage = NonNullable<
	Parameters<inference.STT<'deepgram/nova-3'>['updateOptions']>[0]['language']
>
const asInferenceLanguage = (language: string) => language as InferenceLanguage

/**
 * Deepgram, Gemini, and Cartesia are called on their US endpoints (directly
 * or through LiveKit Inference), so the worker may only handle calls whose
 * customer data lives in the US.
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
	if (modelProviders(ENV).tts === 'livekit') {
		// Voice ids are Cartesia's either way, so a chosen voice still applies.
		return new inference.TTS({
			model: `cartesia/${TTS_MODEL}`,
			language,
			...(voice ? { voice } : {}),
		})
	}
	return new cartesia.TTS({
		apiKey: ENV.CARTESIA_API_KEY,
		model: TTS_MODEL,
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

	const providers = modelProviders(ENV)
	const sttLanguage = sttLanguageFor(languages, primary)
	const stt =
		providers.stt === 'livekit'
			? // Inference forwards language changes to open streams itself.
				new inference.STT({
					model: `deepgram/${STT_MODEL}`,
					language: sttLanguage,
					modelOptions: { keyterm, smart_format: true, numerals: true },
				})
			: new LanguageSwitchingSTT({
					apiKey: ENV.DEEPGRAM_API_KEY,
					model: STT_MODEL,
					language: sttLanguage,
					keyterm,
					smartFormat: true,
					numerals: true,
				})
	const setSttLanguage = (language: string) =>
		stt instanceof LanguageSwitchingSTT
			? stt.setLanguage(language)
			: stt.updateOptions({ language: asInferenceLanguage(language) })

	const llmModel = ENV.PHONE_AGENT_LLM_MODEL || DEFAULT_LLM_MODEL
	const llm =
		providers.llm === 'livekit'
			? new inference.LLM({
					model: `google/${llmModel}`,
					modelOptions: { temperature: 0.4 },
				})
			: new google.LLM({
					apiKey: ENV.GOOGLE_API_KEY,
					model: llmModel,
					temperature: 0.4,
				})

	// Sonic voices are multilingual, so the owner's voice stays and only the
	// language changes; Cartesia reads it per utterance, so it takes effect
	// from the next thing the agent says.
	const tts = createTts(primary, voiceId)

	const speech: SpeechLanguageControl = {
		setLanguage(language) {
			tts.updateOptions({ language: asInferenceLanguage(language) })
			if (sttLanguage !== 'multi') setSttLanguage(language)
		},
	}

	return { stt, llm, tts, speech }
}
