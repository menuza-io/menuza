import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const env = vi.hoisted(() => ({
	VOICE_AGENT_TOKEN: '' as string | undefined,
}))
vi.mock('varlock/env', () => ({ ENV: env }))

const { getUsableVoiceAgentToken, requireVoiceAgentAuth } =
	await import('./voice-agent-auth.server.ts')

const DEV_DEFAULT = 'dev-voice-agent-token-do-not-use-in-prod-32b'
const CONFIGURED_TOKEN = 'x'.repeat(40)

function requestWith(token: string) {
	return new Request('http://localhost/resources/phone-agent-config', {
		headers: { Authorization: `Bearer ${token}` },
	})
}

describe('VOICE_AGENT_TOKEN validation', () => {
	beforeEach(() => {
		vi.stubEnv('NODE_ENV', 'development')
		env.VOICE_AGENT_TOKEN = CONFIGURED_TOKEN
	})

	afterEach(() => {
		vi.unstubAllEnvs()
	})

	it('accepts the development default outside production', () => {
		env.VOICE_AGENT_TOKEN = DEV_DEFAULT
		expect(getUsableVoiceAgentToken()).toBe(DEV_DEFAULT)
		expect(() => requireVoiceAgentAuth(requestWith(DEV_DEFAULT))).not.toThrow()
	})

	it('refuses the development default in production', () => {
		vi.spyOn(console, 'error').mockImplementation(() => {})
		vi.stubEnv('NODE_ENV', 'production')
		env.VOICE_AGENT_TOKEN = DEV_DEFAULT
		expect(getUsableVoiceAgentToken()).toBeNull()
		expect(() => requireVoiceAgentAuth(requestWith(DEV_DEFAULT))).toThrow(
			Response,
		)
	})

	it.each(['', 'short-token', 'a'.repeat(31)])(
		'refuses a token shorter than 32 characters (%s)',
		(token) => {
			env.VOICE_AGENT_TOKEN = token
			expect(getUsableVoiceAgentToken()).toBeNull()
			expect(() => requireVoiceAgentAuth(requestWith(token))).toThrow(Response)
		},
	)

	it('accepts a real secret in production', () => {
		vi.stubEnv('NODE_ENV', 'production')
		expect(() =>
			requireVoiceAgentAuth(requestWith(CONFIGURED_TOKEN)),
		).not.toThrow()
	})

	it('rejects a wrong bearer token', () => {
		vi.stubEnv('NODE_ENV', 'production')
		try {
			requireVoiceAgentAuth(requestWith(`${CONFIGURED_TOKEN}y`))
			expect.unreachable()
		} catch (error) {
			expect((error as Response).status).toBe(401)
		}
	})
})
