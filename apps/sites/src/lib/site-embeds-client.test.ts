// @vitest-environment jsdom
/**
 * #259: an embed frame loads only as the guest's cookie choice allows, is
 * created with a sandbox and a title, and its address is checked again.
 */
import {
	CONSENT_STORAGE_KEY,
	makeConsentChoice,
} from '@repo/common/site-consent'
import { beforeEach, describe, expect, it } from 'vitest'
import { initSiteEmbeds, type EmbedEnv } from './site-embeds-client'
import { SITE_CONSENT_EVENT } from './site-pixels'

const OT =
	'https://www.opentable.com/widget/reservation/canvas?rid=12345&type=standard'

function mount(mode: 'required' | 'notice' | 'off', src = OT) {
	document.body.innerHTML = `
		<div hidden data-site-pixels></div>
		<div data-site-embed data-consent-mode="${mode}" data-embed-src="${src}" data-embed-title="Book a table">
			<div data-embed-placeholder><button type="button" data-embed-load>Load content</button></div>
		</div>`
}

function env(overrides: Partial<EmbedEnv> = {}): EmbedEnv {
	return {
		document,
		window,
		storage: window.localStorage,
		now: () => Date.now(),
		gpc: false,
		...overrides,
	}
}

const frame = () => document.querySelector<HTMLIFrameElement>('iframe')

function choose(marketing: boolean) {
	window.localStorage.setItem(
		CONSENT_STORAGE_KEY,
		JSON.stringify(
			makeConsentChoice({ analytics: false, marketing }, {}, Date.now()),
		),
	)
	window.dispatchEvent(new CustomEvent(SITE_CONSENT_EVENT))
}

beforeEach(() => {
	window.localStorage.clear()
	document.body.innerHTML = ''
})

describe('embed frames and cookie consent', () => {
	it('Required mode: nothing loads before the guest accepts', () => {
		mount('required')
		initSiteEmbeds(env())
		expect(frame()).toBeNull()
		expect(
			document
				.querySelector('[data-embed-placeholder]')
				?.hasAttribute('hidden'),
		).toBe(false)
	})

	it('Required mode: accepting marketing cookies loads it, with a sandbox and a title', () => {
		mount('required')
		initSiteEmbeds(env())
		choose(true)
		const loaded = frame()!
		expect(loaded.src).toBe(OT)
		expect(loaded.title).toBe('Book a table')
		expect(loaded.getAttribute('sandbox')).toContain('allow-scripts')
		expect(loaded.getAttribute('sandbox')).not.toContain('allow-top-navigation')
		expect(loaded.loading).toBe('lazy')
		expect(loaded.referrerPolicy).toBe('strict-origin-when-cross-origin')
		expect(
			document
				.querySelector('[data-embed-placeholder]')
				?.hasAttribute('hidden'),
		).toBe(true)
	})

	it('Required mode: rejecting keeps it off, even with an analytics-only choice', () => {
		mount('required')
		initSiteEmbeds(env())
		choose(false)
		expect(frame()).toBeNull()
	})

	it('Required mode: the Load button loads this one frame without saving a choice', () => {
		mount('required')
		initSiteEmbeds(env())
		document.querySelector<HTMLElement>('[data-embed-load]')!.click()
		expect(frame()).not.toBeNull()
		expect(window.localStorage.getItem(CONSENT_STORAGE_KEY)).toBeNull()
	})

	it('Required mode: a stored choice from an earlier visit loads it at once', () => {
		choose(true)
		mount('required')
		initSiteEmbeds(env())
		expect(frame()).not.toBeNull()
	})

	it('Notice mode loads it, unless the browser sends Global Privacy Control', () => {
		mount('notice')
		initSiteEmbeds(env())
		expect(frame()).not.toBeNull()
		mount('notice')
		initSiteEmbeds(env({ gpc: true }))
		expect(frame()).toBeNull()
	})

	it('with the banner off it loads', () => {
		mount('off')
		initSiteEmbeds(env())
		expect(frame()).not.toBeNull()
	})

	it('refuses an address that is not https', () => {
		for (const src of [
			'http://www.opentable.com/x',
			'javascript:alert(1)',
			'data:text/html,<script>alert(1)</script>',
			'//www.opentable.com/x',
		]) {
			mount('off', src)
			initSiteEmbeds(env())
			expect(frame()).toBeNull()
		}
	})
})
