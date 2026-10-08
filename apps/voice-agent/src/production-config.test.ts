import { describe, expect, it } from 'vitest'
import {
	assertProductionConfig,
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

	it('reports the development token, local URLs, and missing provider keys', () => {
		expect(
			productionConfigProblems({
				NODE_ENV: 'production',
				VOICE_AGENT_TOKEN: 'dev-voice-agent-token-do-not-use-in-prod-32b',
				APP_URL: 'http://localhost:3001',
				TENANT_API_URL: 'https://api.example.test',
			}),
		).toEqual([
			'VOICE_AGENT_TOKEN is the development default',
			'APP_URL must be a public https:// URL',
			'TENANT_API_URL must be a public https:// URL',
			'DEEPGRAM_API_KEY is not set',
			'GOOGLE_API_KEY is not set',
			'CARTESIA_API_KEY is not set',
		])
	})

	it('throws with every problem listed', () => {
		expect(() =>
			assertProductionConfig({ ...productionEnv, GOOGLE_API_KEY: '' }),
		).toThrow(
			'The voice worker is not configured for production: GOOGLE_API_KEY is not set.',
		)
	})
})
