import {
	pickPopup,
	popupCouponHref,
	SITE_POPUP_DEFAULT_SCROLL_PERCENT,
	type PublicSitePopup,
} from '@repo/common/site-popup'
import { initOutboundClicks, initSiteFunnel } from '~/lib/site-funnel-client'

/**
 * The browser half of promotional popups (#132). The App decides which
 * popups exist and whether their coupon works (it re-checks on every request);
 * this decides, per page view, which one shows: never on checkout, payment or
 * account pages, at most one, and not again inside its frequency window. When
 * a visitor closes a popup the time is kept in this browser only.
 */

const CLOSED_KEY = 'menuza:popup-closed'
const SESSION_KEY = 'menuza:popup-closed-session'

function readJson<T>(storage: Storage | null, key: string, fallback: T): T {
	try {
		const raw = storage?.getItem(key)
		return raw ? (JSON.parse(raw) as T) : fallback
	} catch {
		return fallback
	}
}

function safeStorage(kind: 'local' | 'session'): Storage | null {
	try {
		return kind === 'local'
			? globalThis.localStorage
			: globalThis.sessionStorage
	} catch {
		return null
	}
}

export function readClosed(): {
	closedAt: Record<string, number>
	session: Set<string>
} {
	return {
		closedAt: readJson<Record<string, number>>(
			safeStorage('local'),
			CLOSED_KEY,
			{},
		),
		session: new Set(
			readJson<string[]>(safeStorage('session'), SESSION_KEY, []),
		),
	}
}

export function rememberClosed(id: string, now = Date.now()) {
	const local = safeStorage('local')
	const session = safeStorage('session')
	try {
		const closed = readJson<Record<string, number>>(local, CLOSED_KEY, {})
		closed[id] = now
		local?.setItem(CLOSED_KEY, JSON.stringify(closed))
		const ids = new Set(readJson<string[]>(session, SESSION_KEY, []))
		ids.add(id)
		session?.setItem(SESSION_KEY, JSON.stringify([...ids]))
	} catch {
		/* storage blocked: the popup may show again on the next page */
	}
}

export type SiteExtras = {
	popups: PublicSitePopup[]
	funnel: boolean
	/** Count clicks that leave for another site (#318). */
	outbound: boolean
}

export async function loadPopups(root: HTMLElement): Promise<SiteExtras> {
	const appUrl = root.dataset.appUrl
	if (!appUrl) return { popups: [], funnel: false, outbound: false }
	const params = new URLSearchParams()
	if (root.dataset.orgSlug) params.set('slug', root.dataset.orgSlug)
	if (root.dataset.customHost) params.set('host', root.dataset.customHost)
	if (root.dataset.locale) params.set('lng', root.dataset.locale)
	try {
		const response = await fetch(`${appUrl}/resources/sites/popups?${params}`, {
			headers: { Accept: 'application/json' },
			cache: 'no-store',
		})
		if (!response.ok) return { popups: [], funnel: false, outbound: false }
		const body = (await response.json()) as {
			popups?: PublicSitePopup[]
			funnel?: boolean
			outbound?: boolean
		}
		return {
			popups: Array.isArray(body.popups) ? body.popups : [],
			funnel: body.funnel === true,
			outbound: body.outbound === true || body.funnel === true,
		}
	} catch {
		return { popups: [], funnel: false, outbound: false }
	}
}

/** Resolves when the popup's trigger fires (or never, when the page is left first). */
function waitForTrigger(popup: PublicSitePopup): Promise<void> {
	return new Promise((resolve) => {
		if (popup.trigger === 'delay') {
			setTimeout(resolve, Math.max(0, popup.triggerValue) * 1000)
		} else if (popup.trigger === 'scroll') {
			const target = popup.triggerValue || SITE_POPUP_DEFAULT_SCROLL_PERCENT
			const onScroll = () => {
				const scrollable =
					document.documentElement.scrollHeight - window.innerHeight
				if (scrollable <= 0) return
				if ((window.scrollY / scrollable) * 100 >= target) {
					window.removeEventListener('scroll', onScroll)
					resolve()
				}
			}
			window.addEventListener('scroll', onScroll, { passive: true })
		} else {
			// Exit intent: only where there is a pointer to leave with.
			if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches)
				return
			const onLeave = (event: MouseEvent) => {
				if (event.clientY <= 0) {
					document.removeEventListener('mouseout', onLeave)
					resolve()
				}
			}
			document.addEventListener('mouseout', onLeave)
		}
	})
}

function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	className: string,
	text?: string,
) {
	const node = document.createElement(tag)
	node.className = className
	if (text !== undefined) node.textContent = text
	return node
}

/** A path on this site or an https URL; anything else is never linked. */
function safeHref(url: string | null): string | null {
	if (!url) return null
	if (url.startsWith('/') && !url.startsWith('//')) return url
	try {
		return new URL(url).protocol === 'https:' ? url : null
	} catch {
		return null
	}
}

function showPopup(popup: PublicSitePopup, root: HTMLElement) {
	const previouslyFocused = document.activeElement as HTMLElement | null
	const overlay = el(
		'div',
		'fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4',
	)
	const dialog = el(
		'div',
		'bg-background text-foreground relative w-full max-w-sm space-y-3 rounded-xl border p-6 shadow-xl',
	)
	dialog.setAttribute('role', 'dialog')
	dialog.setAttribute('aria-modal', 'true')
	const heading = el('h2', 'font-heading text-xl tracking-tight', popup.title)
	heading.id = `popup-${popup.id}-title`
	dialog.setAttribute('aria-labelledby', heading.id)

	const close = el(
		'button',
		'text-muted-foreground absolute end-3 top-3 p-1 text-lg leading-none',
		'×',
	)
	close.setAttribute('type', 'button')
	close.setAttribute('aria-label', root.dataset.closeLabel || 'Close')
	const dismiss = () => {
		rememberClosed(popup.id)
		overlay.remove()
		document.removeEventListener('keydown', onKey)
		previouslyFocused?.focus?.()
	}
	const onKey = (event: KeyboardEvent) => {
		if (event.key === 'Escape') dismiss()
	}
	close.addEventListener('click', dismiss)
	overlay.addEventListener('click', (event) => {
		if (event.target === overlay) dismiss()
	})
	document.addEventListener('keydown', onKey)
	dialog.append(close)

	const image = safeHref(popup.imageUrl)
	if (image) {
		const img = el('img', 'h-36 w-full rounded-md object-cover')
		img.setAttribute('src', image)
		img.setAttribute('alt', '')
		dialog.append(img)
	}
	dialog.append(heading)
	if (popup.body)
		dialog.append(el('p', 'text-muted-foreground text-sm', popup.body))
	if (popup.couponCode) {
		dialog.append(
			el(
				'p',
				'bg-muted rounded-md px-3 py-2 text-center font-mono text-sm tracking-wide',
				popup.couponCode,
			),
		)
	}

	if (popup.captureContact !== 'none') {
		const form = el('form', 'space-y-2')
		const input = el(
			'input',
			'border-input bg-background w-full rounded-md border px-3 py-2 text-base',
		)
		input.setAttribute('name', 'contact')
		input.setAttribute('required', '')
		input.setAttribute('maxlength', '200')
		input.setAttribute(
			'type',
			popup.captureContact === 'email' ? 'email' : 'tel',
		)
		input.setAttribute(
			'autocomplete',
			popup.captureContact === 'email' ? 'email' : 'tel',
		)
		input.setAttribute(
			'aria-label',
			popup.captureContact === 'email'
				? root.dataset.emailLabel || 'Email address'
				: root.dataset.phoneLabel || 'Phone number',
		)
		// Honeypot: a person never fills it.
		const trap = el('input', 'hidden')
		trap.setAttribute('name', 'website')
		trap.setAttribute('tabindex', '-1')
		trap.setAttribute('autocomplete', 'off')
		const consentLabel = el('label', 'flex items-start gap-2 text-xs')
		const consent = el('input', 'mt-0.5')
		consent.setAttribute('type', 'checkbox')
		consent.setAttribute('required', '')
		// Never pre-ticked: consent is the visitor's own act.
		consentLabel.append(consent, document.createTextNode(popup.consentText))
		const status = el('p', 'text-xs')
		status.setAttribute('role', 'status')
		const submit = el(
			'button',
			'bg-primary text-primary-foreground w-full rounded-md px-4 py-2 text-sm font-medium',
			popup.buttonLabel || root.dataset.submitLabel || 'Sign up',
		)
		submit.setAttribute('type', 'submit')
		form.append(input, trap, consentLabel)
		const siteKey = root.dataset.turnstileSiteKey
		if (siteKey) {
			const widget = el('div', 'cf-turnstile')
			widget.setAttribute('data-sitekey', siteKey)
			form.append(widget)
		}
		form.append(submit, status)
		form.addEventListener('submit', async (event) => {
			event.preventDefault()
			const data = new FormData(form)
			const token = String(data.get('cf-turnstile-response') || '')
			if (siteKey && !token) {
				status.textContent =
					root.dataset.verificationLabel || 'Complete the verification check.'
				return
			}
			submit.disabled = true
			try {
				const response = await fetch(
					`${root.dataset.tenantApiUrl}/forms/popup-signup`,
					{
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({
							slug: root.dataset.orgSlug || undefined,
							host: root.dataset.customHost || undefined,
							popupId: popup.id,
							channel: popup.captureContact,
							contact: String(data.get('contact') || ''),
							consent: (consent as HTMLInputElement).checked,
							website: String(data.get('website') || ''),
							turnstileToken: token || undefined,
						}),
					},
				)
				if (!response.ok) throw new Error('failed')
				status.textContent = root.dataset.thanksLabel || 'Thank you.'
				rememberClosed(popup.id)
				submit.hidden = true
			} catch {
				status.textContent =
					root.dataset.errorLabel || 'Something went wrong. Try again.'
				submit.disabled = false
			}
		})
		dialog.append(form)
	} else {
		const href = popup.couponCode
			? popupCouponHref(popup.couponCode)
			: safeHref(popup.buttonUrl)
		if (href && popup.buttonLabel) {
			const link = el(
				'a',
				'bg-primary text-primary-foreground block rounded-md px-4 py-2 text-center text-sm font-medium',
				popup.buttonLabel,
			)
			link.setAttribute('href', href)
			link.addEventListener('click', () => rememberClosed(popup.id))
			dialog.append(link)
		}
	}
	overlay.append(dialog)
	document.body.append(overlay)
	;(close as HTMLElement).focus()
	if (popup.captureContact !== 'none' && root.dataset.turnstileSiteKey) {
		const script = document.createElement('script')
		script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js'
		script.async = true
		document.head.append(script)
	}
}

/** Picks and schedules the one popup for this page view. */
export async function initSitePopups() {
	const root = document.getElementById('site-popup-root')
	if (!root || root.dataset.bound) return
	root.dataset.bound = '1'
	const { popups, funnel, outbound } = await loadPopups(root)
	const funnelContext = {
		tenantApiUrl: root.dataset.tenantApiUrl ?? '',
		orgSlug: root.dataset.orgSlug,
		customHost: root.dataset.customHost,
	}
	// The same answer says whether this site counts its funnel (#179), and
	// whether it counts clicks that leave for another site (#318).
	if (funnel && root.dataset.tenantApiUrl) initSiteFunnel(funnelContext)
	if (outbound && root.dataset.tenantApiUrl) initOutboundClicks(funnelContext)
	if (popups.length === 0) return
	const closed = readClosed()
	const popup = pickPopup(popups, {
		pathname: location.pathname,
		now: Date.now(),
		closedAt: closed.closedAt,
		closedThisSession: closed.session,
	})
	if (!popup) return
	await waitForTrigger(popup)
	// The page may have changed while we waited (a client-side navigation).
	if (
		pickPopup([popup], {
			pathname: location.pathname,
			now: Date.now(),
			closedAt: readClosed().closedAt,
			closedThisSession: readClosed().session,
		})
	) {
		showPopup(popup, root)
	}
}
