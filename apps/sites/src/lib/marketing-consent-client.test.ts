// @vitest-environment jsdom
import { MARKETING_CONSENT_TEXT_VERSION } from '@repo/common/marketing-consent'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setSessionTokens } from './client-auth'
import {
	buildMarketingConsent,
	checkoutMarketingConsent,
	fetchSubscriptions,
	flagEmailConfirmationPending,
	readConsentChoice,
	recordSignupConsent,
	setSubscription,
	subscriptionState,
	takeEmailConfirmationPending,
} from './marketing-consent-client'

describe('buildMarketingConsent', () => {
	it('sends only the ticked channels with the text version', () => {
		expect(buildMarketingConsent({ email: true, sms: false }, true)).toEqual({
			email: true,
			textVersion: MARKETING_CONSENT_TEXT_VERSION,
		})
		expect(buildMarketingConsent({ email: true, sms: true }, true)).toEqual({
			email: true,
			sms: true,
			textVersion: MARKETING_CONSENT_TEXT_VERSION,
		})
	})

	it('sends nothing when no box is ticked or the guest is signed out', () => {
		expect(
			buildMarketingConsent({ email: false, sms: false }, true),
		).toBeUndefined()
		expect(
			buildMarketingConsent({ email: true, sms: true }, false),
		).toBeUndefined()
	})
})

describe('subscriptionState', () => {
	const rows = [
		{
			topic: 'marketing',
			channel: 'email',
			subscribed: true,
			confirmed: false,
		},
		{ topic: 'marketing', channel: 'sms', subscribed: true },
		{
			topic: 'reservations',
			channel: 'email',
			subscribed: true,
			confirmed: true,
		},
		{ topic: 'drops', channel: 'sms', subscribed: false },
	] as const

	it('maps rows to off, on and pending', () => {
		expect(subscriptionState(rows, 'marketing', 'email')).toBe('pending')
		expect(subscriptionState(rows, 'marketing', 'sms')).toBe('on')
		expect(subscriptionState(rows, 'reservations', 'email')).toBe('on')
		expect(subscriptionState(rows, 'drops', 'sms')).toBe('off')
		expect(subscriptionState(rows, 'drops', 'email')).toBe('off')
		expect(subscriptionState(null, 'marketing', 'email')).toBe('off')
	})
})

describe('the boxes and the region', () => {
	const calls: { url: string; init?: RequestInit }[] = []
	let answers: Response[] = []

	beforeEach(() => {
		calls.length = 0
		answers = []
		const store = new Map<string, string>()
		vi.stubGlobal('localStorage', {
			getItem: (key: string) => store.get(key) ?? null,
			setItem: (key: string, value: string) => void store.set(key, value),
			removeItem: (key: string) => void store.delete(key),
		})
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string, init?: RequestInit) => {
				calls.push({ url, init })
				const next = answers.shift()
				if (!next) throw new Error('Unexpected call')
				return next
			}),
		)
		document.documentElement.dataset.tenantApiUrl = 'https://regional.example'
		document.body.innerHTML = ''
		setSessionTokens({ accessToken: 'head.e30.sig', refreshToken: 'r' })
	})

	afterEach(() => {
		vi.unstubAllGlobals()
		delete document.documentElement.dataset.tenantApiUrl
	})

	const boxes = (ticked: { email?: boolean; sms?: boolean }) => {
		document.body.innerHTML = `<div data-marketing-consent>
			<input type="checkbox" data-consent-channel="email" ${ticked.email ? 'checked' : ''}>
			<input type="checkbox" data-consent-channel="sms" ${ticked.sms ? 'checked' : ''}>
		</div>`
		return document.querySelector('[data-marketing-consent]')
	}

	it('reads the ticked boxes into the order payload when signed in', () => {
		const root = boxes({ sms: true })
		expect(readConsentChoice(root)).toEqual({ email: false, sms: true })
		expect(checkoutMarketingConsent(root)).toEqual({
			sms: true,
			textVersion: MARKETING_CONSENT_TEXT_VERSION,
		})
	})

	it('omits the field when nothing is ticked', () => {
		expect(checkoutMarketingConsent(boxes({}))).toBeUndefined()
	})

	it('omits the field for a guest who is not signed in', () => {
		localStorage.removeItem('tenant_access_token')
		expect(checkoutMarketingConsent(boxes({ email: true }))).toBeUndefined()
	})

	it('PUTs an opt-in with the source and text version, and reports pending', async () => {
		answers = [Response.json({ pending: true })]
		const result = await setSubscription('marketing', 'email', true, 'profile')
		expect(result).toEqual({ status: 'ok', state: 'pending' })
		expect(calls[0]?.url).toBe(
			'https://regional.example/subscriptions/marketing/email',
		)
		expect(calls[0]?.init?.method).toBe('PUT')
		expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
			subscribed: true,
			source: 'profile',
			textVersion: MARKETING_CONSENT_TEXT_VERSION,
		})
	})

	it('sends no text version on an opt-out', async () => {
		answers = [Response.json({ subscribed: false })]
		const result = await setSubscription(
			'reservations',
			'sms',
			false,
			'profile',
		)
		expect(result).toEqual({ status: 'ok', state: 'off' })
		expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
			subscribed: false,
			source: 'profile',
		})
	})

	it('names what a 409 is missing by channel', async () => {
		answers = [
			Response.json({ error: 'x' }, { status: 409 }),
			Response.json({ error: 'x' }, { status: 409 }),
			Response.json({ error: 'x' }, { status: 500 }),
		]
		expect(
			await setSubscription('marketing', 'email', true, 'profile'),
		).toEqual({ status: 'needs_email' })
		expect(await setSubscription('marketing', 'sms', true, 'profile')).toEqual({
			status: 'needs_phone',
		})
		expect(await setSubscription('marketing', 'sms', true, 'profile')).toEqual({
			status: 'error',
		})
	})

	it('reads the subscriptions, or null when it cannot', async () => {
		answers = [
			Response.json({
				subscriptions: [
					{ topic: 'marketing', channel: 'sms', subscribed: true },
				],
			}),
			Response.json({}, { status: 500 }),
		]
		expect(await fetchSubscriptions()).toHaveLength(1)
		expect(await fetchSubscriptions()).toBeNull()
	})

	it('records sign-up consent per ticked box and never throws', async () => {
		answers = [Response.json({ error: 'x' }, { status: 409 })]
		await expect(recordSignupConsent({ sms: true })).resolves.toBeUndefined()
		expect(calls).toHaveLength(1)
		expect(calls[0]?.url).toContain('/subscriptions/marketing/sms')
		expect(JSON.parse(String(calls[0]?.init?.body)).source).toBe('signup')

		await recordSignupConsent({})
		expect(calls).toHaveLength(1)
	})
})

describe('the pending email flag', () => {
	const store = () => {
		const data = new Map<string, string>()
		return {
			getItem: (k: string) => data.get(k) ?? null,
			setItem: (k: string, v: string) => void data.set(k, v),
			removeItem: (k: string) => void data.delete(k),
		}
	}

	it('is set only for a pending email and read once', () => {
		const s = store()
		flagEmailConfirmationPending({ email: 'subscribed' }, s)
		expect(takeEmailConfirmationPending(s)).toBe(false)
		flagEmailConfirmationPending({ email: 'pending' }, s)
		expect(takeEmailConfirmationPending(s)).toBe(true)
		expect(takeEmailConfirmationPending(s)).toBe(false)
	})
})
