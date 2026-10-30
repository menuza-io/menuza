// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getRefreshToken, setSessionTokens } from './client-auth'
import {
	fetchDropAlertsSubscribed,
	isVisibleInState,
	setDropAlertsSubscribed,
} from './drop-alerts-client'

describe('isVisibleInState', () => {
	it('matches any state in the space-separated list', () => {
		expect(isVisibleInState('phone code signed-in', 'code')).toBe(true)
		expect(isVisibleInState('phone code signed-in', 'done')).toBe(false)
		expect(isVisibleInState('done', 'done')).toBe(true)
	})

	it('treats a missing list as never visible', () => {
		expect(isVisibleInState(undefined, 'phone')).toBe(false)
	})
})

describe('drop alerts over the customer session', () => {
	const unauthorized = () =>
		Response.json({ error: 'unauthorized' }, { status: 401 })
	const refreshBusy = () => Response.json({ error: 'busy' }, { status: 503 })

	function region(answers: Response[]) {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				const next = answers.shift()
				if (!next) throw new Error('Unexpected call')
				return next
			}),
		)
	}

	beforeEach(() => {
		const store = new Map<string, string>()
		vi.stubGlobal('localStorage', {
			getItem: (key: string) => store.get(key) ?? null,
			setItem: (key: string, value: string) => void store.set(key, value),
			removeItem: (key: string) => void store.delete(key),
		})
		document.documentElement.dataset.tenantApiUrl = 'https://regional.example'
		const payload = btoa(JSON.stringify({ sub: 'cus-1', orgId: 'org-1' }))
		setSessionTokens({
			accessToken: `head.${payload}.sig`,
			refreshToken: 'refresh-1',
		})
	})

	afterEach(() => {
		vi.unstubAllGlobals()
		delete document.documentElement.dataset.tenantApiUrl
	})

	it('reads whether the customer gets drop texts', async () => {
		region([
			Response.json({
				subscriptions: [{ topic: 'drops', channel: 'sms', subscribed: true }],
			}),
		])
		await expect(fetchDropAlertsSubscribed()).resolves.toBe(true)
	})

	it('saves the switch', async () => {
		region([Response.json({ subscribed: true })])
		await expect(setDropAlertsSubscribed(true, 'menu')).resolves.toEqual({
			ok: true,
			data: { subscribed: true },
		})
	})

	it('fails like the network, keeping the sign-in, when the session cannot be checked', async () => {
		region([unauthorized(), refreshBusy()])
		await expect(setDropAlertsSubscribed(true, 'menu')).rejects.toThrow()
		expect(getRefreshToken()).toBe('refresh-1')

		region([unauthorized(), refreshBusy()])
		await expect(fetchDropAlertsSubscribed()).resolves.toBeNull()
		expect(getRefreshToken()).toBe('refresh-1')
	})
})
