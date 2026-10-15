import { describe, expect, it } from 'vitest'
import {
	assertProductionConfig,
	liveKitInferenceProblem,
	productionConfigProblems,
} from './production-config.ts'

const productionEnv = {
	NODE_ENV: 'production',
	VOICE_AGENT_TOKEN: 'a'.repeat(64),
	APP_URL: 'https://app.example.com',
	TENANT_API_URL: 'https://tenant-us.example.com',
	DEEPGRAM_API_KEY: 'deepgram',
	GOOGLE_API_KEY: 'google',
	CARTESIA_API_KEY: 'cartesia',
}

describe('productionConfigProblems', () => {
	it('accepts a complete production config', () => {
		expect(productionConfigProblems(productionEnv)).toEqual([])
		expect(() => assertProductionConfig(productionEnv)).not.toThrow()
	})

	it('ignores development defaults outside production', () => {
		expect(
			productionConfigProblems({
				NODE_ENV: 'development',
				VOICE_AGENT_TOKEN: 'dev-voice-agent-token-do-not-use-in-prod-32b',
				APP_URL: 'http://localhost:3001',
			}),
		).toEqual([])
	})

	it('reports the development token and local URLs', () => {
		expect(
			productionConfigProblems({
				NODE_ENV: 'production',
				VOICE_AGENT_TOKEN: 'dev-voice-agent-token-do-not-use-in-prod-32b',
				APP_URL: 'http://localhost:3001',
				TENANT_API_URL: 'https://api.example.test',
				LIVEKIT_URL: 'wss://project.livekit.cloud',
			}),
		).toEqual([
			'VOICE_AGENT_TOKEN is the development default',
			'APP_URL must be a public https:// URL',
			'TENANT_API_URL must be a public https:// URL',
		])
	})

	it('accepts missing provider keys on LiveKit Cloud, where Inference stands in', () => {
		expect(
			productionConfigProblems({
				...productionEnv,
				DEEPGRAM_API_KEY: '',
				GOOGLE_API_KEY: '',
				CARTESIA_API_KEY: '',
				LIVEKIT_URL: 'wss://project.livekit.cloud',
			}),
		).toEqual([])
	})

	it('throws when a key is missing and LiveKit is self-hosted', () => {
		expect(() =>
			assertProductionConfig({
				...productionEnv,
				GOOGLE_API_KEY: '',
				LIVEKIT_URL: 'wss://livekit.example.com',
			}),
		).toThrow(
			"The voice worker is not configured for production: GOOGLE_API_KEY is not set and LIVEKIT_URL is not LiveKit Cloud, so LiveKit Inference can't stand in.",
		)
	})
})

describe('liveKitInferenceProblem', () => {
	it('lists every missing key against a local server', () => {
		expect(
			liveKitInferenceProblem({ LIVEKIT_URL: 'ws://localhost:7880' }),
		).toBe(
			"DEEPGRAM_API_KEY, GOOGLE_API_KEY, CARTESIA_API_KEY are not set and LIVEKIT_URL is not LiveKit Cloud, so LiveKit Inference can't stand in",
		)
	})

	it('accepts a self-hosted server when every key is set', () => {
		expect(
			liveKitInferenceProblem({
				...productionEnv,
				LIVEKIT_URL: 'ws://localhost:7880',
			}),
		).toBeNull()
	})

	it('accepts an explicit inference gateway', () => {
		expect(
			liveKitInferenceProblem({
				LIVEKIT_URL: 'ws://localhost:7880',
				LIVEKIT_INFERENCE_URL: 'https://gateway.example.com/v1',
			}),
		).toBeNull()
	})
})
