import { afterEach, describe, expect, it, vi } from 'vitest'
import { isCanvaConfigured, isCanvaMock } from './env.server.ts'

afterEach(() => vi.unstubAllEnvs())

describe('Canva emulator switch', () => {
	it('is never on with a public BASE_URL', () => {
		vi.stubEnv('CANVA_MOCK', 'true')
		vi.stubEnv('CANVA_CLIENT_ID', '')
		vi.stubEnv('CANVA_CLIENT_SECRET', '')
		for (const origin of [
			'https://app.example.com',
			'https://localhost.example.com',
			'https://example.test.com',
			'not a url',
			'',
		]) {
			vi.stubEnv('BASE_URL', origin)
			expect(isCanvaMock()).toBe(false)
			expect(isCanvaConfigured()).toBe(false)
		}
	})

	it('is on only when asked for, on a local origin', () => {
		for (const origin of [
			'http://localhost:3001',
			'http://127.0.0.1:3001',
			'https://app.epic-startup.test:2999',
		]) {
			vi.stubEnv('BASE_URL', origin)
			vi.stubEnv('CANVA_MOCK', 'true')
			expect(isCanvaMock()).toBe(true)
			vi.stubEnv('CANVA_MOCK', 'false')
			expect(isCanvaMock()).toBe(false)
		}
	})

	it('needs both integration keys otherwise', () => {
		vi.stubEnv('CANVA_MOCK', '')
		vi.stubEnv('BASE_URL', 'https://app.example.com')
		vi.stubEnv('CANVA_CLIENT_ID', 'id')
		vi.stubEnv('CANVA_CLIENT_SECRET', '')
		expect(isCanvaConfigured()).toBe(false)
		vi.stubEnv('CANVA_CLIENT_SECRET', 'secret')
		expect(isCanvaConfigured()).toBe(true)
	})
})
