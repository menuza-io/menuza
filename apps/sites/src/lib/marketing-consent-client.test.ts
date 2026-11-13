// @vitest-environment jsdom
import { MARKETING_CONSENT_TEXT_VERSIONS } from '@repo/common/marketing-consent'
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

const BOXES = MARKETING_CONSENT_TEXT_VERSIONS.boxesDisclosure

describe('buildMarketingConsent', () => {
	it('sends only the ticked channels with the text version', () => {
		expect(
			buildMarketingConsent({ email: true, sms: false }, true, BOXES),
		).toEqual({ email: true, textVersion: BOXES })
		expect(
			buildMarketingConsent({ email: true, sms: true }, true, BOXES),
		).toEqual({ email: true, sms: true, textVersion: BOXES })
	})

	it('sends nothing when no box is ticked or the guest is signed out', () => {
		expect(
			buildMarketingConsent({ email: false, sms: false }, true, BOXES),
		).toBeUndefined()
		expect(
			buildMarketingConsent({ email: true, sms: true }, false, BOXES),
		).toBeUndefined()
		expect(
			buildMarketingConsent({ email: true }, true, undefined),
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
		document.body.innerHTML = `<div data-marketing-consent data-text-version="${BOXES}">
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
			textVersion: BOXES,
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
		const result = await setSubscription(
			'marketing',
			'email',
			true,
			'profile',
			MARKETING_CONSENT_TEXT_VERSIONS.profileDisclosure,
		)
		expect(result).toEqual({ status: 'ok', state: 'pending' })
		expect(calls[0]?.url).toBe(
			'https://regional.example/subscriptions/marketing/email',
		)
		expect(calls[0]?.init?.method).toBe('PUT')
		expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
			subscribed: true,
			source: 'profile',
			textVersion: MARKETING_CONSENT_TEXT_VERSIONS.profileDisclosure,
		})
	})

	it('sends no text version when none covers the switch', async () => {
		answers = [Response.json({ subscribed: true })]
		await setSubscription('reservations', 'email', true, 'profile')
		expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
			subscribed: true,
			source: 'profile',
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
		await expect(recordSignupConsent({ sms: true }, BOXES)).resolves.toBeUndefined()
		expect(calls).toHaveLength(1)
		expect(calls[0]?.url).toContain('/subscriptions/marketing/sms')
		const body = JSON.parse(String(calls[0]?.init?.body))
		expect(body.source).toBe('signup')
		expect(body.textVersion).toBe(BOXES)

		await recordSignupConsent({}, BOXES)
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
		flagEmailConfirmationPending({ email: 'subscribed' }, 'ord_1', s)
		expect(takeEmailConfirmationPending('ord_1', s)).toBe(false)
		flagEmailConfirmationPending({ email: 'pending' }, 'ord_1', s)
		expect(takeEmailConfirmationPending('ord_1', s)).toBe(true)
		expect(takeEmailConfirmationPending('ord_1', s)).toBe(false)
	})

	it('shows only on the order it was set for and is cleared on a mismatch', () => {
		const s = store()
		flagEmailConfirmationPending({ email: 'pending' }, 'ord_1', s)
		expect(takeEmailConfirmationPending('ord_2', s)).toBe(false)
		// The stale flag is gone, so the original order no longer shows it either.
		expect(takeEmailConfirmationPending('ord_1', s)).toBe(false)
	})
})
