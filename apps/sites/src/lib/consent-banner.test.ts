// @vitest-environment jsdom
/**
 * #89: the banner shows when a choice is needed, saves Accept all, Reject
 * non-essential and a custom choice in this browser, is keyboard operable, and
 * Cookie settings reopens it.
 */
import { CONSENT_STORAGE_KEY } from '@repo/common/site-consent'
import { beforeEach, describe, expect, it } from 'vitest'
import { initConsentBanner } from './consent-banner'
import { bannerApplies, legalLinks } from './legal-links'
import { SITE_CONSENT_EVENT } from './site-pixels'

function mount(mode: 'required' | 'notice' = 'required') {
	document.body.innerHTML = `
		<div hidden data-site-pixels data-facebook-pixel="1234567890" data-google-analytics="G-ABC123"></div>
		<section hidden data-consent-banner data-consent-mode="${mode}" role="region" aria-labelledby="consent-banner-heading">
			<h2 id="consent-banner-heading" tabindex="-1">Your privacy choices</h2>
			<fieldset hidden data-consent-choose>
				<input type="checkbox" data-consent-analytics />
				<input type="checkbox" data-consent-marketing />
			</fieldset>
			<button type="button" data-consent-accept>Accept all</button>
			<button type="button" data-consent-reject>Reject non-essential</button>
			<button type="button" data-consent-choose-toggle aria-expanded="false">Choose</button>
			<button type="button" data-consent-save hidden>Save</button>
		</section>
		<footer><button type="button" data-open-consent-settings>Cookie settings</button></footer>`
	const banner = document.querySelector<HTMLElement>('[data-consent-banner]')!
	initConsentBanner(banner)
	return banner
}

const stored = () => {
	const raw = window.localStorage.getItem(CONSENT_STORAGE_KEY)
	return raw ? (JSON.parse(raw) as Record<string, unknown>) : null
}
const click = (selector: string) =>
	document.querySelector<HTMLElement>(selector)!.click()

beforeEach(() => {
	window.localStorage.clear()
	document.body.innerHTML = ''
})

describe('consent banner', () => {
	it('shows on the first visit and hides after Accept all, saving the choice here only', () => {
		const banner = mount()
		expect(banner.hidden).toBe(false)
		let fired = 0
		window.addEventListener(SITE_CONSENT_EVENT, () => fired++)
		click('[data-consent-accept]')
		expect(banner.hidden).toBe(true)
		expect(fired).toBe(1)
		expect(stored()).toMatchObject({ v: 1, analytics: true, marketing: true })
	})

	it('Reject non-essential saves a rejection', () => {
		const banner = mount()
		click('[data-consent-reject]')
		expect(banner.hidden).toBe(true)
		expect(stored()).toMatchObject({ analytics: false, marketing: false })
	})

	it('Choose reveals the categories and saves exactly what is ticked', () => {
		const banner = mount()
		click('[data-consent-choose-toggle]')
		expect(
			document
				.querySelector('[data-consent-choose-toggle]')!
				.getAttribute('aria-expanded'),
		).toBe('true')
		expect(
			document.querySelector<HTMLElement>('[data-consent-choose]')!.hidden,
		).toBe(false)
		document
			.querySelector<HTMLInputElement>('[data-consent-analytics]')!
			.click()
		click('[data-consent-save]')
		expect(banner.hidden).toBe(true)
		expect(stored()).toMatchObject({ analytics: true, marketing: false })
	})

	it('does not show again once a valid choice exists, and Cookie settings reopens it', () => {
		mount()
		click('[data-consent-accept]')
		const again = mount()
		expect(again.hidden).toBe(true)
		click('[data-open-consent-settings]')
		expect(again.hidden).toBe(false)
		// Focus moves to the heading so a keyboard user lands in the banner.
		expect(document.activeElement?.id).toBe('consent-banner-heading')
		// Reopening shows the current choice in "Choose".
		click('[data-consent-choose-toggle]')
		expect(
			document.querySelector<HTMLInputElement>('[data-consent-analytics]')!
				.checked,
		).toBe(true)
		click('[data-consent-reject]')
		expect(stored()).toMatchObject({ analytics: false, marketing: false })
	})

	it('Notice mode shows the banner until the guest chooses', () => {
		const banner = mount('notice')
		expect(banner.hidden).toBe(false)
	})

	it('a browser sending GPC needs no banner (it already answered)', () => {
		Object.defineProperty(window.navigator, 'globalPrivacyControl', {
			value: true,
			configurable: true,
		})
		const banner = mount()
		expect(banner.hidden).toBe(true)
		Object.defineProperty(window.navigator, 'globalPrivacyControl', {
			value: undefined,
			configurable: true,
		})
	})

	it('every control is a real button, so the keyboard works', () => {
		const banner = mount()
		for (const control of banner.querySelectorAll('button')) {
			expect(control.tagName).toBe('BUTTON')
			expect(control.getAttribute('type')).toBe('button')
		}
		expect(banner.getAttribute('role')).toBe('region')
		expect(banner.getAttribute('aria-labelledby')).toBe(
			'consent-banner-heading',
		)
		// Not a modal, never fixed: it cannot cover the cart or checkout button.
		expect(banner.getAttribute('aria-modal')).toBeNull()
	})
})

describe('legal links and the banner', () => {
	it('links only published legal pages, in the visitor’s language', () => {
		const organization = {
			defaultLocale: 'en',
			legalPages: { privacy: '/privacy', terms: '/terms' },
		}
		expect(legalLinks(organization, 'en')).toEqual([
			{ kind: 'privacy', href: '/privacy' },
			{ kind: 'terms', href: '/terms' },
		])
		expect(legalLinks(organization, 'ar')).toEqual([
			{ kind: 'privacy', href: '/ar/privacy' },
			{ kind: 'terms', href: '/ar/terms' },
		])
		expect(legalLinks(organization, 'en', ['cookies'])).toEqual([])
		expect(legalLinks({ legalPages: {} }, 'en')).toEqual([])
		expect(legalLinks(undefined, 'en')).toEqual([])
		// A path that is not a site path is never linked.
		expect(
			legalLinks({ legalPages: { privacy: '//evil.example' } }, 'en'),
		).toEqual([])
	})

	it('a footer accessibility link appears only when that page is published', () => {
		expect(
			legalLinks({ legalPages: { privacy: '/privacy' } }, 'en', [
				'accessibility',
			]),
		).toEqual([])
		expect(
			legalLinks({ legalPages: { accessibility: '/accessibility' } }, 'en', [
				'accessibility',
			]),
		).toEqual([{ kind: 'accessibility', href: '/accessibility' }])
	})

	it('the banner applies only with a mode and at least one tracking tag', () => {
		expect(
			bannerApplies({ consent: { mode: 'required' }, facebookPixelId: '123' }),
		).toBe(true)
		expect(
			bannerApplies({ consent: { mode: 'notice' }, googleAnalyticsId: 'G-1' }),
		).toBe(true)
		expect(
			bannerApplies({ consent: { mode: 'off' }, facebookPixelId: '123' }),
		).toBe(false)
		expect(bannerApplies({ consent: { mode: 'required' } })).toBe(false)
		// An embedded widget can set marketing cookies, so it is worth asking (#259).
		expect(
			bannerApplies({ consent: { mode: 'required' } }, { hasEmbeds: true }),
		).toBe(true)
		expect(
			bannerApplies({ consent: { mode: 'off' } }, { hasEmbeds: true }),
		).toBe(false)
		expect(bannerApplies({ facebookPixelId: '123' })).toBe(false)
	})
})
