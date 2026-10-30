// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	getAccessToken,
	getRefreshToken,
	setSessionTokens,
} from '~/lib/client-auth'
import { createBrowserReservationsApi, loadCustomerPrefill } from './client.ts'

/** An unsigned token the session code can read. */
function accessToken(n = 1): string {
	const payload = btoa(JSON.stringify({ sub: 'cus-1', orgId: 'org-1', n }))
	return `head.${payload}.sig`
}

type Call = { path: string; authorization: string | null }

/** The region by path; each path takes its next queued answer. */
function region(answers: Record<string, Response[]>) {
	const calls: Call[] = []
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const path = new URL(String(input)).pathname
			calls.push({
				path,
				authorization: new Headers(init?.headers).get('Authorization'),
			})
			const next = answers[path]?.shift()
			if (!next) throw new Error(`Unexpected ${path}`)
			return next
		}),
	)
	return calls
}

const unauthorized = () =>
	Response.json({ error: 'unauthorized' }, { status: 401 })

beforeEach(() => {
	const store = new Map<string, string>()
	vi.stubGlobal('localStorage', {
		getItem: (key: string) => store.get(key) ?? null,
		setItem: (key: string, value: string) => void store.set(key, value),
		removeItem: (key: string) => void store.delete(key),
	})
	document.documentElement.dataset.tenantApiUrl = 'https://regional.example'
	setSessionTokens({ accessToken: accessToken(), refreshToken: 'refresh-1' })
})

afterEach(() => {
	vi.unstubAllGlobals()
	delete document.documentElement.dataset.tenantApiUrl
})

describe('browser reservations api: customer session', () => {
	it('books as the customer while the session stands', async () => {
		const calls = region({
			'/reservations': [Response.json({ reservation: {} }, { status: 201 })],
		})
		await createBrowserReservationsApi().book({ holdToken: 'h' }, 'k')
		expect(calls).toEqual([
			{ path: '/reservations', authorization: `Bearer ${accessToken()}` },
		])
	})

	it('keeps the sign-in and books nothing when the session cannot be checked for now', async () => {
		const calls = region({
			'/reservations': [unauthorized()],
			'/auth/refresh': [Response.json({ error: 'busy' }, { status: 503 })],
		})
		await expect(
			createBrowserReservationsApi().book({ holdToken: 'h' }, 'k'),
		).rejects.toThrow()
		expect(getAccessToken()).toBe(accessToken())
		expect(getRefreshToken()).toBe('refresh-1')
		// No guest booking behind the customer's back: it is still signed in.
		expect(calls.map((call) => call.path)).toEqual([
			'/reservations',
			'/auth/refresh',
		])
	})

	it('books as a guest once the region refuses the session', async () => {
		const calls = region({
			'/reservations': [
				unauthorized(),
				Response.json({ reservation: {} }, { status: 201 }),
			],
			'/auth/refresh': [
				Response.json({ error: 'invalid_grant' }, { status: 401 }),
			],
		})
		await createBrowserReservationsApi().book({ holdToken: 'h' }, 'k')
		expect(getAccessToken()).toBeNull()
		expect(getRefreshToken()).toBeNull()
		expect(calls.at(-1)).toEqual({
			path: '/reservations',
			authorization: null,
		})
	})
})

describe('loadCustomerPrefill', () => {
	it('reads the signed-in customer profile', async () => {
		region({
			'/auth/me': [
				Response.json({
					customer: { name: 'Ada', phone: '+15550100', email: 'a@x.test' },
				}),
			],
		})
		await expect(loadCustomerPrefill()).resolves.toEqual({
			name: 'Ada',
			phone: '+15550100',
			email: 'a@x.test',
		})
	})

	it('leaves the form empty and the sign-in alone when the session cannot be checked', async () => {
		region({
			'/auth/me': [unauthorized()],
			'/auth/refresh': [Response.json({ error: 'busy' }, { status: 503 })],
		})
		await expect(loadCustomerPrefill()).resolves.toBeNull()
		expect(getRefreshToken()).toBe('refresh-1')
	})
})
