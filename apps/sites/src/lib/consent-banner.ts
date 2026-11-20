import {
	CONSENT_STORAGE_KEY,
	isGlobalPrivacyControl,
	makeConsentChoice,
	readConsentChoice,
	resolveConsent,
	type ConsentMode,
	type SiteTagIds,
} from '@repo/common/site-consent'
import { readTagIds, SITE_CONSENT_EVENT } from './site-pixels'

/**
 * The cookie banner's behaviour (#89): shows itself when a choice is needed,
 * saves Accept all, Reject non-essential or a custom choice in this browser
 * (never on a server), tells the tag loader, and reopens from the footer's
 * "Cookie settings". All buttons are real `<button>`s, so the keyboard works
 * without extra handling; opening the banner moves focus to its heading.
 */
export function initConsentBanner(banner: HTMLElement, win: Window = window) {
	const pixels = win.document.querySelector('[data-site-pixels]')
	const ids: SiteTagIds =
		pixels instanceof HTMLElement ? readTagIds(pixels) : {}
	const mode = (banner.dataset.consentMode as ConsentMode) || 'off'
	const q = <T extends Element>(selector: string) =>
		banner.querySelector<T>(selector)
	const chooseBox = q<HTMLElement>('[data-consent-choose]')
	const toggle = q<HTMLButtonElement>('[data-consent-choose-toggle]')
	const save = q<HTMLButtonElement>('[data-consent-save]')
	const analytics = q<HTMLInputElement>('[data-consent-analytics]')
	const marketing = q<HTMLInputElement>('[data-consent-marketing]')

	const storage = () => {
		try {
			return win.localStorage
		} catch {
			return null
		}
	}
	const gpc = () =>
		isGlobalPrivacyControl(win.navigator as { globalPrivacyControl?: unknown })

	function show(options: { focus: boolean }) {
		banner.hidden = false
		if (options.focus) {
			banner.scrollIntoView?.({ block: 'start' })
			banner.querySelector<HTMLElement>('#consent-banner-heading')?.focus()
		}
	}

	function choose(categories: { analytics: boolean; marketing: boolean }) {
		try {
			win.localStorage.setItem(
				CONSENT_STORAGE_KEY,
				JSON.stringify(makeConsentChoice(categories, ids, Date.now())),
			)
		} catch {
			// Storage is blocked: the choice holds for this page only.
		}
		banner.hidden = true
		win.dispatchEvent(new CustomEvent(SITE_CONSENT_EVENT))
	}

	function showChoices(open: boolean) {
		if (chooseBox) chooseBox.hidden = !open
		if (save) save.hidden = !open
		toggle?.setAttribute('aria-expanded', open ? 'true' : 'false')
		if (open) {
			const existing = readConsentChoice(storage(), Date.now())
			if (analytics) analytics.checked = existing?.analytics ?? false
			if (marketing) marketing.checked = existing?.marketing ?? false
		}
	}

	q('[data-consent-accept]')?.addEventListener('click', () =>
		choose({ analytics: true, marketing: true }),
	)
	q('[data-consent-reject]')?.addEventListener('click', () =>
		choose({ analytics: false, marketing: false }),
	)
	toggle?.addEventListener('click', () =>
		showChoices(toggle.getAttribute('aria-expanded') !== 'true'),
	)
	save?.addEventListener('click', () =>
		choose({
			analytics: analytics?.checked ?? false,
			marketing: marketing?.checked ?? false,
		}),
	)

	// The footer's "Cookie settings" reopens the choice at any time.
	win.document.addEventListener('click', (event) => {
		const target = event.target
		if (
			target instanceof Element &&
			target.closest('[data-open-consent-settings]')
		) {
			event.preventDefault()
			showChoices(false)
			show({ focus: true })
		}
	})

	const state = resolveConsent({
		mode,
		choice: readConsentChoice(storage(), Date.now()),
		gpc: gpc(),
		tags: ids,
	})
	if (state.askAgain) show({ focus: false })
}
