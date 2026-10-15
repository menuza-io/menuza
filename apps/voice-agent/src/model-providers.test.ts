import { describe, expect, it } from 'vitest'
import {
	describeModelProviders,
	isLiveKitCloud,
	modelProviders,
	usesLiveKitInference,
} from './model-providers.ts'

describe('modelProviders', () => {
	it('calls each provider directly when its key is set', () => {
		const providers = modelProviders({
			DEEPGRAM_API_KEY: 'deepgram',
			GOOGLE_API_KEY: 'google',
			CARTESIA_API_KEY: 'cartesia',
		})
		expect(providers).toEqual({
			stt: 'deepgram',
			llm: 'google',
			tts: 'cartesia',
		})
		expect(usesLiveKitInference(providers)).toBe(false)
	})

	it('routes each service without a key through LiveKit Inference', () => {
		const providers = modelProviders({ GOOGLE_API_KEY: 'google' })
		expect(providers).toEqual({ stt: 'livekit', llm: 'google', tts: 'livekit' })
		expect(usesLiveKitInference(providers)).toBe(true)
		expect(describeModelProviders(providers)).toBe(
			'speech-to-text: LiveKit Inference, language model: Gemini, text-to-speech: LiveKit Inference',
		)
	})

	it('treats an empty key as unset', () => {
		expect(modelProviders({ DEEPGRAM_API_KEY: '' }).stt).toBe('livekit')
	})
})

describe('isLiveKitCloud', () => {
	it('recognizes LiveKit Cloud projects', () => {
		expect(
			isLiveKitCloud({ LIVEKIT_URL: 'wss://acme-1a2b.livekit.cloud' }),
		).toBe(true)
	})

	it('rejects self-hosted and malformed URLs', () => {
		expect(isLiveKitCloud({ LIVEKIT_URL: 'ws://localhost:7880' })).toBe(false)
		expect(
			isLiveKitCloud({ LIVEKIT_URL: 'wss://livekit.cloud.evil.com' }),
		).toBe(false)
		expect(isLiveKitCloud({ LIVEKIT_URL: 'not a url' })).toBe(false)
		expect(isLiveKitCloud({})).toBe(false)
	})

	it('accepts an explicit inference gateway', () => {
		expect(
			isLiveKitCloud({
				LIVEKIT_URL: 'ws://localhost:7880',
				LIVEKIT_INFERENCE_URL: 'https://gateway.example.com/v1',
			}),
		).toBe(true)
	})
})
