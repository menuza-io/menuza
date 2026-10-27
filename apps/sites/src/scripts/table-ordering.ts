import { type QrPublicTab } from '@repo/common/qr-ordering'
import { type CartStore } from '~/lib/ordering/cart-store'
import { el, lockScroll, trapFocus } from '~/lib/ordering/dom'
import {
	checkoutAttemptKey,
	clearCheckoutAttempt,
	orderLines,
	saveOrderCapability,
} from '~/lib/ordering/order-client'
import {
	clearTableSession,
	fetchTab,
	fetchTableContext,
	isDeadTableError,
	loadTableSession,
	readTableFragment,
	rememberPosterVisit,
	saveTableSession,
	stripTableFragment,
	submitTableRound,
	TableRequestError,
	type TableSession,
} from '~/lib/ordering/table-session'
import { createOverlayMotion } from '~/lib/site-motion'

/**
 * Dine-in mode of the menu page. A scanned table code (`#table=…`) or a
 * stored session turns the cart's checkout button into "Send to kitchen":
 * each send is one round on the table's tab, and the tab drawer shows every
 * round with its kitchen status and the running total. The guest pays once,
 * at the counter (or from the phone where the venue allows it).
 */

type Labels = Record<
	| 'tableLabel'
	| 'tabNumber'
	| 'sendToKitchen'
	| 'sending'
	| 'sent'
	| 'round'
	| 'emptyTab'
	| 'payAtCounter'
	| 'tax'
	| 'includesTax'
	| 'closed'
	| 'cancelled'
	| 'statusAccepted'
	| 'statusPreparing'
	| 'statusReady'
	| 'statusCompleted'
	| 'statusCancelled'
	| 'errorGeneric'
	| 'errorTableGone'
	| 'errorLocked'
	| 'errorClosed'
	| 'errorRateLimited'
	| 'errorUnavailable',
	string
>

export type TableOrderingDeps = {
	orgId: string
	locationId: string
	locale: string
	formatMoney: (amount: number) => string
	store: CartStore
	cart: { open(): void; close(): void; refresh(): void }
	/** Present when the page also renders a pay-from-phone button (M5). */
	onPayNow?: (session: TableSession, tab: QrPublicTab) => HTMLElement | null
}

function fill(template: string, values: Record<string, string>) {
	return template.replace(/\{(\w+)\}/g, (match, key: string) =>
		key in values ? values[key]! : match,
	)
}

function readLabels(): Labels {
	try {
		return JSON.parse(
			document.getElementById('table-labels')?.textContent || '{}',
		) as Labels
	} catch {
		return {} as Labels
	}
}

export function mountTableOrdering(deps: TableOrderingDeps) {
	const labels = readLabels()
	const { orgId, locationId } = deps
	const banner = document.getElementById('table-banner')
	const notice = document.getElementById('table-notice')
	const checkoutBtn = document.getElementById('drawer-checkout-btn')
	const checkoutText = checkoutBtn?.querySelector('span:first-child')
	const orderBar = document.getElementById('order-bar')
	let session: TableSession | null = null
	let sending = false

	// Posters: remember the visit so a pickup order is tagged for attribution.
	if (new URL(window.location.href).searchParams.get('src') === 'qr') {
		rememberPosterVisit(orgId)
	}

	function say(message: string, tone: 'neutral' | 'danger' = 'neutral') {
		if (!notice) return
		const box = el(
			'p',
			`rounded-lg border px-3 py-2 text-sm ${tone === 'danger' ? 'tone-danger' : 'tone-success'}`,
			message,
		)
		notice.replaceChildren(box)
	}

	function errorText(code: string) {
		if (isDeadTableError(code)) {
			return code === 'dine_in_unavailable'
				? labels.errorUnavailable
				: labels.errorTableGone
		}
		if (code === 'tab_locked') return labels.errorLocked
		if (code === 'ordering_closed') return labels.errorClosed
		if (code === 'table_rate_limited' || code === 'rate_limit_exceeded') {
			return labels.errorRateLimited
		}
		return labels.errorGeneric
	}

	// ---- Mode switch --------------------------------------------------------

	function paintBanner(totalCents: number | null) {
		if (!banner || !session) return
		banner.classList.remove('hidden')
		banner.classList.add('flex')
		const label = banner.querySelector('[data-table-label]')
		if (label)
			label.textContent = fill(labels.tableLabel, { label: session.tableLabel })
		const number = banner.querySelector('[data-tab-number]')
		if (number) {
			number.textContent = session.tabNumber
				? `${fill(labels.tabNumber, { number: session.tabNumber })} · `
				: ''
		}
		const total = banner.querySelector('[data-tab-total]')
		if (total) {
			total.textContent =
				totalCents !== null && session.tabNumber
					? deps.formatMoney(totalCents / 100)
					: ''
		}
	}

	function enterTableMode() {
		document.documentElement.dataset.tableMode = 'true'
		// Pickup or delivery choices do not apply at the table.
		orderBar?.classList.add('hidden')
		if (checkoutText) checkoutText.textContent = labels.sendToKitchen
		paintBanner(null)
	}

	function leaveTableMode() {
		clearTableSession(orgId)
		session = null
		delete document.documentElement.dataset.tableMode
		window.location.reload()
	}

	document
		.getElementById('leave-table-btn')
		?.addEventListener('click', leaveTableMode)

	// ---- Tab drawer ---------------------------------------------------------

	const tabBackdrop = document.getElementById('tab-drawer-backdrop')
	const tabDrawer = document.getElementById('tab-drawer')
	const tabMotion =
		tabBackdrop && tabDrawer
			? createOverlayMotion(tabBackdrop, tabDrawer)
			: null
	let releaseTab: (() => void) | null = null
	let tabOpener: HTMLElement | null = null
	let tabPoll: ReturnType<typeof setInterval> | undefined

	const statusText = (status: string) =>
		({
			accepted: labels.statusAccepted,
			preparing: labels.statusPreparing,
			ready: labels.statusReady,
			completed: labels.statusCompleted,
			cancelled: labels.statusCancelled,
			expired: labels.statusCancelled,
		})[status] ?? labels.statusAccepted

	function renderTab(tab: QrPublicTab) {
		const rounds = document.getElementById('tab-rounds')
		const subtitle = tabDrawer?.querySelector('[data-tab-subtitle]')
		if (subtitle) {
			subtitle.textContent = `${fill(labels.tableLabel, { label: tab.table.label })} · ${fill(labels.tabNumber, { number: tab.tabNumber })}`
		}
		if (rounds) {
			if (tab.rounds.length === 0) {
				rounds.replaceChildren(
					el('p', 'text-sm text-muted-foreground', labels.emptyTab),
				)
			} else {
				const list = el('ol', 'flex flex-col gap-4')
				tab.rounds.forEach((round, index) => {
					const item = el('li', 'surface flex flex-col gap-2 p-3')
					const head = el('div', 'flex items-center justify-between gap-3')
					head.append(
						el(
							'span',
							'font-semibold text-foreground',
							fill(labels.round, { number: String(index + 1) }),
						),
						el(
							'span',
							`badge ${round.status === 'ready' ? 'tone-success' : round.status === 'cancelled' ? 'tone-danger' : 'tone-neutral'}`,
							statusText(round.status),
						),
					)
					const lines = el('ul', 'flex flex-col gap-1 text-sm')
					for (const line of round.lines) {
						const row = el('li', 'flex items-baseline justify-between gap-3')
						row.append(
							el(
								'span',
								'min-w-0 text-foreground',
								`${line.quantity}× ${localized(line.itemName, deps.locale)}`,
							),
							el(
								'span',
								'price text-muted-foreground',
								deps.formatMoney(line.totalCents / 100),
							),
						)
						lines.appendChild(row)
					}
					item.append(head, lines)
					list.appendChild(item)
				})
				rounds.replaceChildren(list)
			}
		}
		const money = (cents: number) => deps.formatMoney(cents / 100)
		const set = (id: string, text: string) => {
			const node = document.getElementById(id)
			if (node) node.textContent = text
		}
		set('tab-subtotal', money(tab.totals.subtotalCents))
		set('tab-tax', money(tab.totals.taxCents))
		set(
			'tab-tax-label',
			tab.totals.taxInclusive ? labels.includesTax : labels.tax,
		)
		set('tab-total', money(tab.totals.totalCents))
		set(
			'tab-pay-note',
			tab.status === 'closed'
				? labels.closed
				: tab.status === 'cancelled'
					? labels.cancelled
					: fill(labels.payAtCounter, { number: tab.tabNumber }),
		)
		const slot = document.getElementById('tab-pay-slot')
		if (slot) {
			const pay =
				tab.status === 'open' && session && deps.onPayNow
					? deps.onPayNow(session, tab)
					: null
			slot.replaceChildren(...(pay ? [pay] : []))
		}
		paintBanner(tab.totals.totalCents)
	}

	async function loadTab() {
		if (!session?.tabToken) {
			renderTab({
				id: '',
				tabNumber: '',
				status: 'open',
				paymentStatus: 'unpaid',
				table: { id: '', label: session?.tableLabel ?? '', locationId },
				openedAt: '',
				closedAt: null,
				rounds: [],
				totals: {
					currency: '',
					subtotalCents: 0,
					taxCents: 0,
					taxInclusive: false,
					tipCents: 0,
					totalCents: 0,
				},
				roundsPending: false,
			})
			return
		}
		try {
			const tab = await fetchTab(session.tabToken)
			renderTab(tab)
			if (tab.status !== 'open' && session) {
				// Settled or voided: the next order starts a new tab.
				session = { ...session, tabId: null, tabToken: null, tabNumber: null }
				saveTableSession(session)
			}
		} catch (error) {
			if (
				error instanceof TableRequestError &&
				error.status === 404 &&
				session
			) {
				session = { ...session, tabId: null, tabToken: null, tabNumber: null }
				saveTableSession(session)
			}
		}
	}

	function onTabKey(event: KeyboardEvent) {
		if (event.key === 'Escape') closeTab()
	}

	function openTab() {
		if (!tabMotion || !tabDrawer || tabMotion.isOpen()) return
		tabOpener =
			document.activeElement instanceof HTMLElement
				? document.activeElement
				: null
		tabMotion.open()
		const releaseScroll = lockScroll()
		const releaseTrap = trapFocus(tabDrawer)
		releaseTab = () => {
			releaseScroll()
			releaseTrap()
		}
		document.addEventListener('keydown', onTabKey)
		document.getElementById('close-tab-btn')?.focus({ preventScroll: true })
		void loadTab()
		tabPoll = setInterval(() => {
			if (document.visibilityState === 'visible') void loadTab()
		}, 20_000)
	}

	function closeTab() {
		if (!tabMotion?.isOpen()) return
		clearInterval(tabPoll)
		releaseTab?.()
		releaseTab = null
		document.removeEventListener('keydown', onTabKey)
		tabMotion.close()
		if (tabOpener?.isConnected) tabOpener.focus({ preventScroll: true })
	}

	document.getElementById('open-tab-btn')?.addEventListener('click', openTab)
	document.getElementById('close-tab-btn')?.addEventListener('click', closeTab)
	tabBackdrop?.addEventListener('click', (event) => {
		if (event.target === tabBackdrop) closeTab()
	})

	// ---- Contact prompt -----------------------------------------------------

	const contactBackdrop = document.getElementById('table-contact-backdrop')
	const contactForm = document.getElementById(
		'table-contact',
	) as HTMLFormElement | null
	const contactMotion =
		contactBackdrop && contactForm
			? createOverlayMotion(contactBackdrop, contactForm)
			: null
	let releaseContact: (() => void) | null = null
	let pendingContact:
		((contact: { name?: string; phone?: string } | null) => void) | null = null

	function askContact(need: { name: boolean; phone: boolean }) {
		return new Promise<{ name?: string; phone?: string } | null>((resolve) => {
			if (!contactMotion || !contactForm) return resolve(null)
			pendingContact = resolve
			contactForm
				.querySelector<HTMLElement>('[data-contact-name]')
				?.classList.toggle('hidden', !need.name)
			contactForm
				.querySelector<HTMLElement>('[data-contact-phone]')
				?.classList.toggle('hidden', !need.phone)
			const name = contactForm.elements.namedItem('name') as HTMLInputElement
			const phone = contactForm.elements.namedItem('phone') as HTMLInputElement
			name.required = need.name
			phone.required = need.phone
			contactMotion.open()
			const releaseScroll = lockScroll()
			const releaseTrap = trapFocus(contactForm)
			releaseContact = () => {
				releaseScroll()
				releaseTrap()
			}
			;(need.name ? name : phone).focus({ preventScroll: true })
		})
	}

	function finishContact(value: { name?: string; phone?: string } | null) {
		releaseContact?.()
		releaseContact = null
		contactMotion?.close()
		pendingContact?.(value)
		pendingContact = null
	}

	document
		.getElementById('table-contact-close')
		?.addEventListener('click', () => finishContact(null))
	contactForm?.addEventListener('submit', (event) => {
		event.preventDefault()
		const name = (
			contactForm.elements.namedItem('name') as HTMLInputElement
		).value.trim()
		const phone = (
			contactForm.elements.namedItem('phone') as HTMLInputElement
		).value.trim()
		const nameInput = contactForm.elements.namedItem('name') as HTMLInputElement
		const phoneInput = contactForm.elements.namedItem(
			'phone',
		) as HTMLInputElement
		const error = document.getElementById('table-contact-error')
		const missing =
			(nameInput.required && !name) ||
			(phoneInput.required && !/^\+?[\d\s\-().]{7,25}$/.test(phone))
		if (missing) {
			if (error) {
				error.textContent = labels.errorGeneric
				error.classList.remove('hidden')
			}
			;(nameInput.required && !name ? nameInput : phoneInput).focus()
			return
		}
		error?.classList.add('hidden')
		finishContact({ ...(name ? { name } : {}), ...(phone ? { phone } : {}) })
	})
	contactForm?.addEventListener('keydown', (event) => {
		if (event.key === 'Escape') finishContact(null)
	})

	// ---- Sending a round ----------------------------------------------------

	async function sendRound(contact: { name?: string; phone?: string } = {}) {
		if (!session || sending) return
		const cart = deps.store.lines()
		if (cart.length === 0) return
		sending = true
		if (checkoutText) checkoutText.textContent = labels.sending
		checkoutBtn?.setAttribute('aria-busy', 'true')
		try {
			const core = {
				locale: deps.locale,
				locationId,
				fulfillment: 'dine_in',
				paymentMethod: 'handoff',
				contact,
				tipPercent: 0,
				lines: orderLines(cart),
			}
			const idempotencyKey = await checkoutAttemptKey(orgId, {
				...core,
				tab: session.tabId ?? session.tableToken.slice(0, 12),
			})
			const created = await submitTableRound(session, {
				...core,
				idempotencyKey,
			})
			saveOrderCapability(orgId, created)
			clearCheckoutAttempt(orgId)
			session = {
				...session,
				tabId: created.tab.id,
				tabToken: created.tab.tabToken,
				tabNumber: created.tab.tabNumber,
			}
			saveTableSession(session)
			deps.store.clear()
			deps.cart.close()
			say(labels.sent)
			openTab()
		} catch (error) {
			const code =
				error instanceof TableRequestError ? error.code : 'order_failed'
			if (
				code === 'contact_name_required' ||
				code === 'contact_phone_required'
			) {
				sending = false
				const need = {
					name:
						code === 'contact_name_required' || session.policy.requireGuestName,
					phone:
						code === 'contact_phone_required' ||
						session.policy.requireGuestPhone,
				}
				const answer = await askContact(need)
				if (answer) return sendRound({ ...contact, ...answer })
			} else if (code === 'tab_closed' && session.tabToken) {
				// The staff closed the tab: start a new one with the table code.
				session = { ...session, tabId: null, tabToken: null, tabNumber: null }
				saveTableSession(session)
				sending = false
				return sendRound(contact)
			} else {
				if (isDeadTableError(code)) {
					clearTableSession(orgId)
				}
				say(errorText(code), 'danger')
				deps.cart.close()
			}
		} finally {
			sending = false
			if (checkoutText) checkoutText.textContent = labels.sendToKitchen
			checkoutBtn?.removeAttribute('aria-busy')
		}
	}

	checkoutBtn?.addEventListener(
		'click',
		(event) => {
			if (!session) return
			// At the table the button sends the round instead of opening checkout.
			event.preventDefault()
			event.stopImmediatePropagation()
			if (checkoutBtn.getAttribute('aria-disabled') === 'true') return
			const first = !session.tabToken
			const need = {
				name: first && session.policy.requireGuestName,
				phone: first && session.policy.requireGuestPhone,
			}
			if (need.name || need.phone) {
				void askContact(need).then((answer) => answer && sendRound(answer))
			} else {
				void sendRound()
			}
		},
		{ capture: true },
	)

	// ---- Start --------------------------------------------------------------

	async function start() {
		const scanned = readTableFragment(window.location.href)
		if (scanned) {
			// The code must never linger in the address bar or history.
			history.replaceState(
				history.state,
				'',
				stripTableFragment(window.location.href),
			)
		}
		const stored = loadTableSession(orgId)
		const tableToken =
			scanned ?? (stored?.locationId === locationId ? stored.tableToken : null)
		if (!tableToken) return
		try {
			const context = await fetchTableContext({ locationId, tableToken })
			if (!context.dineIn.enabled) {
				clearTableSession(orgId)
				say(labels.errorUnavailable, 'danger')
				return
			}
			const sameTable = stored && stored.tableToken === tableToken
			session = {
				orgId,
				locationId,
				tableToken,
				tableLabel: context.table.label,
				// A re-scan resumes the table's open tab (any phone at the table).
				tabId: context.openTab?.id ?? (sameTable ? stored.tabId : null),
				tabToken: context.openTab?.tabToken ?? null,
				tabNumber: context.openTab?.tabNumber ?? null,
				policy: {
					requireGuestName: context.dineIn.requireGuestName,
					requireGuestPhone: context.dineIn.requireGuestPhone,
					onlineTabPayAvailable: context.dineIn.onlineTabPayAvailable,
				},
				savedAt: Date.now(),
			}
			saveTableSession(session)
			enterTableMode()
			paintBanner(context.openTab?.totalCents ?? null)
			deps.cart.refresh()
		} catch (error) {
			const code =
				error instanceof TableRequestError ? error.code : 'request_failed'
			if (isDeadTableError(code) || code === 'tab_locked')
				clearTableSession(orgId)
			say(errorText(code), 'danger')
		}
	}

	void start()
	return {
		isActive: () => session !== null,
		openTab,
	}
}

/** Receipt lines keep every catalog locale as a JSON map string. */
function localized(value: string, locale: string): string {
	if (!value.startsWith('{')) return value
	try {
		const parsed = JSON.parse(value) as Record<string, unknown>
		const picked =
			parsed[locale] ?? parsed[locale.split('-')[0] ?? ''] ?? parsed.en
		if (typeof picked === 'string') return picked
		const first = Object.values(parsed).find(
			(entry) => typeof entry === 'string',
		)
		return typeof first === 'string' ? first : value
	} catch {
		return value
	}
}
