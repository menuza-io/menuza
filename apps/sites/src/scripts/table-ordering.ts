import { type QrPublicTab } from '@repo/common/qr-ordering'
import { type CartStore } from '~/lib/ordering/cart-store'
import { el, lockScroll, trapFocus } from '~/lib/ordering/dom'
import {
	acceptCheckoutUrl,
	checkoutAttemptKey,
	clearCheckoutAttempt,
	orderLines,
	saveOrderCapability,
} from '~/lib/ordering/order-client'
import {
	checkTabPayment,
	clearTabPayment,
	clearTableSession,
	fetchTab,
	fetchTableContext,
	isDeadTableError,
	loadTableSession,
	readTableFragment,
	rememberPosterVisit,
	saveTableSession,
	startTabPayment,
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
	| 'errorUnavailable'
	| 'payNow'
	| 'payAmount'
	| 'paying'
	| 'checkingPayment'
	| 'paidThanks'
	| 'payLater'
	| 'payUnavailable'
	| 'payCancelled'
	| 'contactMissing'
	| 'nameMissing'
	| 'phoneInvalid'
	| 'leaveConfirm'
	| 'leaveWarning'
	| 'tabLoadFailed'
	| 'tryAgain'
	| 'stillConfirming',
	string
>

export type TableOrderingDeps = {
	orgId: string
	locationId: string
	locale: string
	formatMoney: (amount: number) => string
	store: CartStore
	cart: { open(): void; close(): void; refresh(): void }
}

/** `aria-invalid` must read "true"; an empty attribute counts as false. */
function setInvalid(input: HTMLElement, invalid: boolean) {
	if (invalid) input.setAttribute('aria-invalid', 'true')
	else input.removeAttribute('aria-invalid')
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

	function say(
		message: string,
		tone: 'neutral' | 'success' | 'danger' = 'neutral',
	) {
		if (!notice) return
		const toneClass =
			tone === 'danger'
				? 'tone-danger'
				: tone === 'success'
					? 'tone-success'
					: 'tone-neutral'
		const box = el(
			'p',
			`rounded-lg border px-3 py-2 text-sm ${toneClass}`,
			message,
		)
		// Both regions stay in the page so insertions are announced; errors go
		// to the assertive one.
		const alertRegion = document.getElementById('table-alert')
		if (tone === 'danger' && alertRegion) {
			notice.replaceChildren()
			alertRegion.replaceChildren(box)
		} else {
			alertRegion?.replaceChildren()
			notice.replaceChildren(box)
		}
	}

	/** An error inside the open cart drawer, where the guest is looking. */
	function cartError(message: string | null) {
		const slot = document.getElementById('cart-drawer-header-extra')
		if (!slot) return
		slot.querySelector('[data-table-error]')?.remove()
		if (!message) return
		const box = el(
			'p',
			'rounded-lg border tone-danger px-3 py-2 text-sm',
			message,
		)
		box.dataset.tableError = 'true'
		box.setAttribute('role', 'alert')
		slot.appendChild(box)
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

	// Leaving drops this phone's link to the tab, so it takes a second tap.
	// The confirmation waits as long as the guest needs (no timer); moving
	// away from the button or pressing Escape backs out.
	const leaveBtn = document.getElementById('leave-table-btn')
	let leaveOriginal: string | null = null
	const disarmLeave = () => {
		if (leaveBtn && leaveOriginal !== null) {
			leaveBtn.textContent = leaveOriginal
		}
		leaveOriginal = null
	}
	leaveBtn?.addEventListener('click', () => {
		if (leaveOriginal !== null) {
			leaveTableMode()
			return
		}
		leaveOriginal = leaveBtn.textContent
		leaveBtn.textContent = labels.leaveConfirm
		say(labels.leaveWarning)
	})
	leaveBtn?.addEventListener('blur', disarmLeave)
	leaveBtn?.addEventListener('keydown', (event) => {
		if (event.key === 'Escape' && leaveOriginal !== null) {
			event.stopPropagation()
			disarmLeave()
		}
	})

	const contactError = (nameBad: boolean, phoneBad: boolean) =>
		nameBad && phoneBad
			? labels.contactMissing
			: nameBad
				? labels.nameMissing
				: labels.phoneInvalid

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

	let renderedSignature = ''
	let announcedStatuses = ''
	let announcedTabStatus = ''

	function renderTab(tab: QrPublicTab) {
		// Polls repeat the same tab: rebuild nothing (and announce nothing)
		// unless something changed, so focus and screen readers stay put.
		const signature = JSON.stringify([
			tab,
			session?.policy.onlineTabPayAvailable,
		])
		if (signature === renderedSignature) return
		renderedSignature = signature
		const statuses = tab.rounds.map((round) => round.status).join(',')
		const announcer = document.getElementById('tab-announcer')
		if (announcer && announcedStatuses && statuses !== announcedStatuses) {
			announcer.textContent = tab.rounds
				.map(
					(round, index) =>
						`${fill(labels.round, { number: String(index + 1) })}: ${statusText(round.status)}`,
				)
				.join('. ')
		}
		announcedStatuses = statuses
		// A tab settled while the guest waits (paid online or at the counter, or
		// voided) is announced: the pay button simply disappearing says nothing.
		if (
			announcer &&
			announcedTabStatus &&
			tab.status !== announcedTabStatus &&
			(tab.status === 'closed' || tab.status === 'cancelled')
		) {
			announcer.textContent =
				tab.status === 'closed' ? labels.closed : labels.cancelled
		}
		announcedTabStatus = tab.status
		const rounds = document.getElementById('tab-rounds')
		const subtitle = tabDrawer?.querySelector('[data-tab-subtitle]')
		if (subtitle) {
			const table = fill(labels.tableLabel, { label: tab.table.label })
			subtitle.textContent = tab.tabNumber
				? `${table} · ${fill(labels.tabNumber, { number: tab.tabNumber })}`
				: table
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
		const payNote = document.getElementById('tab-pay-note')
		if (payNote) {
			payNote.textContent =
				tab.status === 'closed'
					? labels.closed
					: tab.status === 'cancelled'
						? labels.cancelled
						: tab.tabNumber
							? fill(labels.payAtCounter, { number: tab.tabNumber })
							: ''
			payNote.classList.toggle('hidden', !payNote.textContent)
		}
		const slot = document.getElementById('tab-pay-slot')
		if (slot) {
			const canPayOnline =
				tab.status === 'open' &&
				tab.paymentStatus !== 'paid' &&
				session?.policy.onlineTabPayAvailable === true &&
				tab.totals.totalCents > 0
			if (!canPayOnline) {
				slot.replaceChildren()
			} else if (tab.roundsPending) {
				slot.replaceChildren(
					el('p', 'text-sm text-muted-foreground', labels.payLater),
				)
			} else {
				const button = el('button', 'btn-cta w-full', labels.payNow)
				button.type = 'button'
				button.addEventListener('click', () => openPay(tab))
				slot.replaceChildren(button)
			}
		}
		paintBanner(tab.totals.totalCents)
	}

	// A settled tab stays on screen as the receipt until a new tab begins.
	let settledTab: QrPublicTab | null = null

	function showTabError() {
		const rounds = document.getElementById('tab-rounds')
		if (!rounds) return
		renderedSignature = ''
		const box = el(
			'div',
			'flex flex-col items-start gap-3 rounded-lg border tone-danger px-3 py-3 text-sm',
		)
		box.setAttribute('role', 'alert')
		box.appendChild(el('p', '', labels.tabLoadFailed))
		const retry = el('button', 'btn-secondary', labels.tryAgain)
		retry.type = 'button'
		retry.addEventListener('click', () => void loadTab())
		box.appendChild(retry)
		rounds.replaceChildren(box)
	}

	async function loadTab() {
		if (!session?.tabToken && settledTab) {
			renderTab(settledTab)
			return
		}
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
				// Settled or voided: keep it as the receipt, and stop polling; the
				// next order starts a new tab.
				settledTab = tab
				clearInterval(tabPoll)
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
				return
			}
			showTabError()
		}
	}

	function onTabKey(event: KeyboardEvent) {
		if (event.key === 'Escape') closeTab()
	}

	function openTab() {
		if (!tabMotion || !tabDrawer || tabMotion.isOpen()) return
		// Opened from a sheet or the cart (which are closing): return focus to
		// the banner's View tab button instead of a hidden element.
		const active =
			document.activeElement instanceof HTMLElement
				? document.activeElement
				: null
		tabOpener =
			active && active !== document.body && !active.closest('.site-overlay')
				? active
				: document.getElementById('open-tab-btn')
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
	let contactOpener: HTMLElement | null = null
	let pendingContact:
		((contact: { name?: string; phone?: string } | null) => void) | null = null

	function askContact(need: { name: boolean; phone: boolean }) {
		return new Promise<{ name?: string; phone?: string } | null>((resolve) => {
			if (!contactMotion || !contactForm) return resolve(null)
			pendingContact = resolve
			contactOpener =
				document.activeElement instanceof HTMLElement
					? document.activeElement
					: null
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
		if (contactOpener?.isConnected) contactOpener.focus({ preventScroll: true })
		contactOpener = null
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
		const nameMissing = nameInput.required && !name
		const phoneMissing =
			phoneInput.required && !/^\+?[\d\s\-().]{7,25}$/.test(phone)
		setInvalid(nameInput, nameMissing)
		setInvalid(phoneInput, phoneMissing)
		if (nameMissing || phoneMissing) {
			if (error) {
				error.textContent = contactError(nameMissing, phoneMissing)
				error.classList.remove('hidden')
			}
			;(nameMissing ? nameInput : phoneInput).focus()
			return
		}
		error?.classList.add('hidden')
		finishContact({ ...(name ? { name } : {}), ...(phone ? { phone } : {}) })
	})
	contactForm?.addEventListener('keydown', (event) => {
		if (event.key !== 'Escape') return
		// Only this sheet closes; the cart drawer underneath stays open.
		event.stopPropagation()
		finishContact(null)
	})

	// ---- Paying from the phone ----------------------------------------------

	const payBackdrop = document.getElementById('tab-pay-backdrop')
	const payForm = document.getElementById('tab-pay') as HTMLFormElement | null
	const payMotion =
		payBackdrop && payForm ? createOverlayMotion(payBackdrop, payForm) : null
	const paySubmit = document.getElementById(
		'tab-pay-submit',
	) as HTMLButtonElement | null
	const payError = document.getElementById('tab-pay-error')
	let releasePay: (() => void) | null = null
	let payTab: QrPublicTab | null = null

	function tipPercent(): number {
		const checked = payForm?.querySelector<HTMLInputElement>(
			'input[name="tipPercent"]:checked',
		)
		return Number(checked?.value ?? 0) || 0
	}

	function paintPayAmount() {
		if (!payTab || !paySubmit) return
		const tip = Math.round((payTab.totals.subtotalCents * tipPercent()) / 100)
		paySubmit.textContent = fill(labels.payAmount, {
			amount: deps.formatMoney((payTab.totals.totalCents + tip) / 100),
		})
	}

	function openPay(tab: QrPublicTab) {
		if (!payMotion || !payForm) return
		payTab = tab
		payError?.classList.add('hidden')
		paintPayAmount()
		closeTab()
		payMotion.open()
		const releaseScroll = lockScroll()
		const releaseTrap = trapFocus(payForm)
		releasePay = () => {
			releaseScroll()
			releaseTrap()
		}
		;(payForm.elements.namedItem('name') as HTMLInputElement).focus({
			preventScroll: true,
		})
	}

	function closePay() {
		releasePay?.()
		releasePay = null
		payMotion?.close()
		// The pay button lives in the tab drawer, which closed: reopen it.
		openTab()
	}

	payForm?.addEventListener('change', paintPayAmount)
	payForm?.addEventListener('keydown', (event) => {
		if (event.key !== 'Escape') return
		event.stopPropagation()
		closePay()
	})
	payBackdrop?.addEventListener('click', (event) => {
		if (event.target === payBackdrop) closePay()
	})
	document.getElementById('tab-pay-close')?.addEventListener('click', closePay)
	payForm?.addEventListener('submit', (event) => {
		event.preventDefault()
		if (!session || !payForm) return
		const name = (
			payForm.elements.namedItem('name') as HTMLInputElement
		).value.trim()
		const phone = (
			payForm.elements.namedItem('phone') as HTMLInputElement
		).value.trim()
		const showError = (message: string) => {
			if (!payError) return
			payError.textContent = message
			payError.classList.remove('hidden')
		}
		const nameField = payForm.elements.namedItem('name') as HTMLInputElement
		const phoneField = payForm.elements.namedItem('phone') as HTMLInputElement
		const phoneBad = !/^\+?[\d\s\-().]{7,25}$/.test(phone)
		setInvalid(nameField, !name)
		setInvalid(phoneField, phoneBad)
		if (!name || phoneBad) {
			showError(contactError(!name, phoneBad))
			;(!name ? nameField : phoneField).focus()
			return
		}
		if (paySubmit) {
			paySubmit.textContent = labels.paying
			paySubmit.setAttribute('aria-busy', 'true')
			paySubmit.disabled = true
		}
		void startTabPayment(orgId, session, {
			tipPercent: tipPercent(),
			contact: { name, phone },
			locale: deps.locale,
		})
			.then((url) => {
				window.location.assign(acceptCheckoutUrl(url))
			})
			.catch((error: unknown) => {
				const code =
					error instanceof TableRequestError
						? error.code
						: 'payment_unavailable'
				showError(
					code === 'rounds_pending'
						? labels.payLater
						: code === 'online_pay_unavailable'
							? labels.payUnavailable
							: errorText(code),
				)
				if (paySubmit) {
					paySubmit.removeAttribute('aria-busy')
					paySubmit.disabled = false
				}
				paintPayAmount()
			})
	})

	// Back from the hosted page through the browser's back button: the page
	// comes back from the back-forward cache with the button still busy.
	window.addEventListener('pageshow', (event) => {
		if (!event.persisted || !paySubmit) return
		paySubmit.removeAttribute('aria-busy')
		paySubmit.disabled = false
		paintPayAmount()
	})

	/** Back from the hosted page: reconcile, then show the tab receipt. */
	async function afterPayment(outcome: string) {
		const url = new URL(window.location.href)
		url.searchParams.delete('tab')
		history.replaceState(history.state, '', url.toString())
		if (outcome === 'cancelled') {
			say(labels.payCancelled)
			return
		}
		say(labels.checkingPayment)
		// The redirect alone never marks a tab paid: ask the App to check with
		// the provider, a few times while the webhook may still be on its way.
		let paid = false
		for (let attempt = 0; attempt < 8 && !paid; attempt += 1) {
			paid = (await checkTabPayment(orgId).catch(() => null)) === 'paid'
			if (!paid) await new Promise((resolve) => setTimeout(resolve, 1500))
		}
		if (paid) {
			clearTabPayment(orgId)
			say(labels.paidThanks, 'success')
		}
		if (!paid) say(labels.stillConfirming)
		// The drawer shows the tab's real state either way.
		openTab()
	}

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
			cartError(null)
			deps.store.clear()
			deps.cart.close()
			say(labels.sent, 'success')
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
			} else if (isDeadTableError(code)) {
				// This table code is over: close the cart and say why on the page.
				clearTableSession(orgId)
				say(errorText(code), 'danger')
				deps.cart.close()
			} else {
				// Worth retrying: keep the cart (and its button) and say it there.
				cartError(errorText(code))
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
		const returning = new URL(window.location.href).searchParams.get('tab')
		if (returning && stored && stored.locationId !== locationId) {
			// The hosted page returns to the menu: reopen the table's location.
			const url = new URL(window.location.href)
			url.searchParams.set('location', stored.locationId)
			window.location.replace(url.toString())
			return
		}
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
			// A tab paid a moment ago is no longer open: keep its token for the
			// receipt drawer until the guest starts a new one.
			if (
				!session.tabToken &&
				stored?.tableToken === tableToken &&
				returning === 'paid'
			) {
				session = {
					...session,
					tabId: stored.tabId,
					tabToken: stored.tabToken,
					tabNumber: stored.tabNumber,
				}
			}
			saveTableSession(session)
			enterTableMode()
			paintBanner(context.openTab?.totalCents ?? null)
			deps.cart.refresh()
			if (returning === 'paid' || returning === 'cancelled') {
				void afterPayment(returning)
			}
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
