import { afterEach, expect, test, vi } from 'vitest'
import { randomUuid } from './uuid.ts'

const UUID_V4 =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

afterEach(() => {
	vi.unstubAllGlobals()
})

test('uses randomUUID when the context is secure', () => {
	vi.stubGlobal('crypto', { randomUUID: () => 'fixed-uuid' })
	expect(randomUuid()).toBe('fixed-uuid')
})

test('falls back to getRandomValues on a non-secure origin', () => {
	vi.stubGlobal('crypto', {
		getRandomValues: (bytes: Uint8Array) => {
			bytes.fill(255)
			return bytes
		},
	})
	expect(randomUuid()).toMatch(UUID_V4)
})

test('falls back to Math.random when crypto is absent', () => {
	vi.stubGlobal('crypto', undefined)
	expect(randomUuid()).toMatch(UUID_V4)
})
