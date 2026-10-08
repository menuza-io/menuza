import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	DEV_VOICE_AGENT_TOKEN,
	logVoiceAgentTokenProblem,
	voiceAgentTokenProblem,
} from './secrets.ts'

const ENV_KEYS = [
	'VOICE_AGENT_TOKEN',
	'INTERNAL_COMMAND_TOKEN',
	'TENANT_OPERATOR_TOKEN',
	'JWT_SECRET',
	'AUTH_HMAC_SECRET',
	'NODE_ENV',
] as const

const voiceToken = 'test-voice-agent-token-0123456789abcdef'

describe('voiceAgentTokenProblem', () => {
	const saved: Record<string, string | undefined> = {}

	beforeEach(() => {
		for (const key of ENV_KEYS) saved[key] = process.env[key]
		process.env.VOICE_AGENT_TOKEN = voiceToken
		process.env.INTERNAL_COMMAND_TOKEN = 'test-internal-token-123456789'
		process.env.TENANT_OPERATOR_TOKEN = 'test-operator-secret-123456789'
		process.env.JWT_SECRET = 'test-jwt-secret-123456789'
		process.env.AUTH_HMAC_SECRET = 'test-hmac-secret-123456789'
		process.env.NODE_ENV = 'test'
	})

	afterEach(() => {
		// Empty instead of deleted: the varlock sync only copies defined values.
		for (const key of ENV_KEYS) process.env[key] = saved[key] ?? ''
	})

	it('accepts a long token used nowhere else', () => {
		expect(voiceAgentTokenProblem()).toBeNull()
	})

	it('refuses a missing or short token', () => {
		process.env.VOICE_AGENT_TOKEN = 'short-voice-token'
		expect(voiceAgentTokenProblem()).toBe(
			'VOICE_AGENT_TOKEN must be at least 32 characters',
		)
		process.env.VOICE_AGENT_TOKEN = ''
		expect(voiceAgentTokenProblem()).toMatch(/at least 32/)
	})

	it.each([
		'INTERNAL_COMMAND_TOKEN',
		'TENANT_OPERATOR_TOKEN',
		'JWT_SECRET',
		'AUTH_HMAC_SECRET',
	] as const)('refuses a token shared with %s', (name) => {
		process.env[name] = voiceToken
		expect(voiceAgentTokenProblem()).toBe(
			`VOICE_AGENT_TOKEN must differ from ${name}`,
		)
	})

	it('refuses the committed development default only in production', () => {
		process.env.VOICE_AGENT_TOKEN = DEV_VOICE_AGENT_TOKEN
		expect(voiceAgentTokenProblem()).toBeNull()
		process.env.NODE_ENV = 'production'
		expect(voiceAgentTokenProblem()).toBe(
			'VOICE_AGENT_TOKEN is using a development default',
		)
	})

	it('logs each problem once', () => {
		const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
		logVoiceAgentTokenProblem('unique test problem')
		logVoiceAgentTokenProblem('unique test problem')
		expect(errors).toHaveBeenCalledTimes(1)
		expect(errors).toHaveBeenCalledWith(
			'Voice agent routes are disabled: unique test problem',
		)
		errors.mockRestore()
	})
})
