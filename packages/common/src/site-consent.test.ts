import { describe, expect, it } from 'vitest'
import {
	allowedTags,
	CONSENT_MAX_AGE_MS,
	CONSENT_STORAGE_KEY,
	isGlobalPrivacyControl,
	makeConsentChoice,
	readConsentChoice,
	resolveConsent,
	tagSignature,
	type SiteTagIds,
} from './site-consent.ts'

const NOW = Date.UTC(2026, 5, 1)
const tags: SiteTagIds = { facebook: '1234567890', googleAnalytics: 'G-ABC123' }

function store(value: unknown) {
	return {
		getItem: (key: string) =>
			key === CONSENT_STORAGE_KEY
				? typeof value === 'string'
					? value
					: JSON.stringify(value)
				: null,
	}
}

describe('tagSignature', () => {
	it('is stable, order independent, and changes when a pixel is added', () => {
		expect(tagSignature({})).toBe('')
		expect(tagSignature(tags)).toBe(
			tagSignature({ googleAnalytics: 'G-ABC123', facebook: '1234567890' }),
		)
		expect(tagSignature({ ...tags, tiktok: 'ABCDEFGHIJ' })).not.toBe(
			tagSignature(tags),
		)
		expect(tagSignature({ facebook: ' ' })).toBe('')
	})
})

describe('stored choice', () => {
	it('is read back, and kept for six months', () => {
		const choice = makeConsentChoice(
			{ analytics: true, marketing: false },
			tags,
			NOW,
		)
		expect(readConsentChoice(store(choice), NOW + 1000)).toEqual(choice)
		expect(
			readConsentChoice(store(choice), NOW + CONSENT_MAX_AGE_MS - 1),
		).toEqual(choice)
		// After six months it is asked again.
		expect(
			readConsentChoice(store(choice), NOW + CONSENT_MAX_AGE_MS),
		).toBeNull()
	})

	it('ignores nothing, malformed, future-dated or broken storage', () => {
		expect(readConsentChoice(null, NOW)).toBeNull()
		expect(readConsentChoice(store('not json'), NOW)).toBeNull()
		expect(readConsentChoice(store({ v: 2 }), NOW)).toBeNull()
		expect(
			readConsentChoice(
				store({
					v: 1,
					at: NOW + 10 * CONSENT_MAX_AGE_MS,
					tags: '',
					analytics: true,
					marketing: true,
				}),
				NOW,
			),
		).toBeNull()
		expect(
			readConsentChoice(
				{
					getItem: () => {
						throw new Error('blocked')
					},
				},
				NOW,
			),
		).toBeNull()
	})
})

describe('resolveConsent', () => {
	it('Required: nothing loads before Accept, and the banner is shown', () => {
		const state = resolveConsent({
			mode: 'required',
			choice: null,
			gpc: false,
			tags,
		})
		expect(state).toMatchObject({
			analytics: false,
			marketing: false,
			askAgain: true,
		})
		expect(allowedTags(state, tags)).toEqual([])
	})

	it('Accept loads everything, Reject keeps everything off, Choose picks categories', () => {
		const choose = (analytics: boolean, marketing: boolean) =>
			resolveConsent({
				mode: 'required',
				choice: makeConsentChoice({ analytics, marketing }, tags, NOW),
				gpc: false,
				tags,
			})
		expect(allowedTags(choose(true, true), tags).sort()).toEqual([
			'facebook',
			'googleAnalytics',
		])
		expect(allowedTags(choose(false, false), tags)).toEqual([])
		expect(allowedTags(choose(true, false), tags)).toEqual(['googleAnalytics'])
		expect(allowedTags(choose(false, true), tags)).toEqual(['facebook'])
		expect(choose(false, false).askAgain).toBe(false)
	})

	it('Cookie settings reopening the choice replaces it', () => {
		const rejected = makeConsentChoice(
			{ analytics: false, marketing: false },
			tags,
			NOW,
		)
		expect(
			resolveConsent({ mode: 'required', choice: rejected, gpc: false, tags })
				.analytics,
		).toBe(false)
		const accepted = makeConsentChoice(
			{ analytics: true, marketing: true },
			tags,
			NOW + 1,
		)
		expect(
			resolveConsent({ mode: 'required', choice: accepted, gpc: false, tags })
				.analytics,
		).toBe(true)
	})

	it('asks again when a new pixel is added (the tag set changed)', () => {
		const choice = makeConsentChoice(
			{ analytics: true, marketing: true },
			tags,
			NOW,
		)
		const withNew = { ...tags, tiktok: 'ABCDEFGHIJ' }
		const state = resolveConsent({
			mode: 'required',
			choice,
			gpc: false,
			tags: withNew,
		})
		expect(state).toMatchObject({
			analytics: false,
			marketing: false,
			askAgain: true,
		})
		// Nothing loads, including the tag the guest had already accepted.
		expect(allowedTags(state, withNew)).toEqual([])
	})

	it('a browser sending GPC is treated as Reject, with no banner', () => {
		const state = resolveConsent({
			mode: 'required',
			choice: null,
			gpc: true,
			tags,
		})
		expect(state).toEqual({
			analytics: false,
			marketing: false,
			askAgain: false,
			reason: 'gpc',
		})
		// Also in Notice mode, where tags would otherwise load.
		expect(
			resolveConsent({ mode: 'notice', choice: null, gpc: true, tags }),
		).toMatchObject({ analytics: false, marketing: false })
		// An explicit choice by the guest wins over the browser default.
		const accepted = makeConsentChoice(
			{ analytics: true, marketing: true },
			tags,
			NOW,
		)
		expect(
			resolveConsent({ mode: 'required', choice: accepted, gpc: true, tags })
				.analytics,
		).toBe(true)
		expect(isGlobalPrivacyControl({ globalPrivacyControl: true })).toBe(true)
		expect(isGlobalPrivacyControl({ globalPrivacyControl: false })).toBe(false)
		expect(isGlobalPrivacyControl({})).toBe(false)
		expect(isGlobalPrivacyControl(undefined)).toBe(false)
	})

	it('Notice only: tags load, with an opt-out, and the notice is shown until chosen', () => {
		const state = resolveConsent({
			mode: 'notice',
			choice: null,
			gpc: false,
			tags,
		})
		expect(state).toMatchObject({
			analytics: true,
			marketing: true,
			askAgain: true,
		})
		const optedOut = makeConsentChoice(
			{ analytics: false, marketing: false },
			tags,
			NOW,
		)
		expect(
			resolveConsent({ mode: 'notice', choice: optedOut, gpc: false, tags }),
		).toMatchObject({ analytics: false, marketing: false, askAgain: false })
	})

	it('Off: no banner, everything loads', () => {
		expect(
			resolveConsent({ mode: 'off', choice: null, gpc: true, tags }),
		).toEqual({
			analytics: true,
			marketing: true,
			askAgain: false,
			reason: 'off',
		})
	})

	it('a site with no tags needs no consent to show nothing', () => {
		expect(allowedTags({ analytics: true, marketing: true }, {})).toEqual([])
	})
})
