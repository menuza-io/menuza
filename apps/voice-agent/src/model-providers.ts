/**
 * Each speech and language service goes to its provider directly when that
 * provider's key is set, and through LiveKit Inference otherwise. Inference
 * bills the LiveKit Cloud project and authenticates with the LiveKit API key,
 * so local development needs no provider accounts.
 */
export type ModelProviders = {
	stt: 'deepgram' | 'livekit'
	llm: 'google' | 'livekit'
	tts: 'cartesia' | 'livekit'
}

type ProviderEnv = {
	DEEPGRAM_API_KEY?: string
	GOOGLE_API_KEY?: string
	CARTESIA_API_KEY?: string
}

export function modelProviders(env: ProviderEnv): ModelProviders {
	return {
		stt: env.DEEPGRAM_API_KEY ? 'deepgram' : 'livekit',
		llm: env.GOOGLE_API_KEY ? 'google' : 'livekit',
		tts: env.CARTESIA_API_KEY ? 'cartesia' : 'livekit',
	}
}

export function usesLiveKitInference(providers: ModelProviders) {
	return Object.values(providers).includes('livekit')
}

/**
 * LiveKit Inference is a LiveKit Cloud service: a self-hosted server
 * (including `livekit-server --dev`) has no inference gateway.
 */
export function isLiveKitCloud(env: {
	LIVEKIT_URL?: string
	LIVEKIT_INFERENCE_URL?: string
}) {
	if (env.LIVEKIT_INFERENCE_URL) return true
	try {
		return new URL(env.LIVEKIT_URL ?? '').hostname.endsWith('.livekit.cloud')
	} catch {
		return false
	}
}

export function describeModelProviders(providers: ModelProviders) {
	const names: Record<string, string> = {
		livekit: 'LiveKit Inference',
		deepgram: 'Deepgram',
		google: 'Gemini',
		cartesia: 'Cartesia',
	}
	const label = (provider: string) => names[provider] ?? provider
	return `speech-to-text: ${label(providers.stt)}, language model: ${label(providers.llm)}, text-to-speech: ${label(providers.tts)}`
}
