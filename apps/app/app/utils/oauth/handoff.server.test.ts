import { createCookie } from 'react-router'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { convertSetCookieToCookie } from '#tests/utils.ts'
import {
	createOAuthHandoff,
	newOAuthState,
	sameState,
} from './handoff.server.ts'

const handoff = createOAuthHandoff({
	name: 'test_oauth',
	path: '/resources/test',
	schema: z.object({
		state: z.string(),
		userId: z.string(),
		orgSlug: z.string(),
	}),
})

function callback(cookie?: string) {
	return new Request('http://localhost:3001/resources/test/callback', {
		headers: cookie ? { Cookie: cookie } : {},
	})
}

describe('createOAuthHandoff', () => {
	it('reads back what this browser was given', async () => {
		const value = { state: newOAuthState(), userId: 'user-1', orgSlug: 'acme' }
		const setCookie = await handoff.set(value)
		await expect(
			handoff.read(callback(convertSetCookieToCookie(setCookie))),
		).resolves.toEqual(value)
	})

	it('is HttpOnly, SameSite=Lax, ten minutes, for the callback path only', async () => {
		const setCookie = await handoff.set({
			state: 's',
			userId: 'u',
			orgSlug: 'o',
		})
		expect(setCookie).toMatch(/^test_oauth=/)
		expect(setCookie).toContain('Path=/resources/test')
		expect(setCookie).toContain('Max-Age=600')
		expect(setCookie).toContain('HttpOnly')
		expect(setCookie).toContain('SameSite=Lax')
	})

	it('finds nothing in a browser that did not start it', async () => {
		await expect(handoff.read(callback())).resolves.toBeNull()
		await expect(handoff.read(callback('other=1'))).resolves.toBeNull()
	})

	it('refuses a cookie signed with another secret', async () => {
		const forged = await createCookie('test_oauth', {
			secrets: ['not-the-session-secret'],
		}).serialize({ state: 's', userId: 'u', orgSlug: 'o' })
		await expect(
			handoff.read(callback(convertSetCookieToCookie(forged))),
		).resolves.toBeNull()
	})

	it('refuses a cookie of another shape', async () => {
		const setCookie = await handoff.set({ state: 's', userId: 42 } as never)
		await expect(
			handoff.read(callback(convertSetCookieToCookie(setCookie))),
		).resolves.toBeNull()
	})

	it('clears itself', async () => {
		const setCookie = await handoff.clear()
		expect(setCookie).toMatch(/^test_oauth=/)
		expect(setCookie).toContain('Max-Age=0')
		expect(setCookie).toContain('Path=/resources/test')
	})
})

describe('sameState', () => {
	it('matches only the same state', () => {
		const state = newOAuthState()
		expect(state).toMatch(/^[\w-]{32}$/)
		expect(sameState(state, state)).toBe(true)
		expect(sameState(state, newOAuthState())).toBe(false)
		expect(sameState(state, `${state}x`)).toBe(false)
		expect(sameState('', state)).toBe(false)
	})
})
