import {
	type QrPublicTab,
	type QrTabPayRequest,
} from '@repo/common/qr-ordering'
import { getAccessToken } from '~/lib/client-auth'
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
	takeStashedTableScan,
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
	| 'errorTabPaying'
	| 'errorClosed'
	| 'errorRateLimited'
	| 'errorUnavailable'
	| 'payNow'
	| 'payAmount'
	| 'payAmountChanged'
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
	| 'stillConfirming'
	| 'payPending',
	string
>

/**
 * The pay sheet's reward picker (`~/lib/loyalty/tab-rewards`), imported on
 * first use by a signed-in guest so the loyalty code stays out of the menu
 * bundle. Declared here because even an inline type import would load the
 * module (`verbatimModuleSyntax` keeps the import statement).
 */
type TabRewards = {
	open(tab: QrPublicTab, tabToken: string): void
	amountMinor(totalMinor: number, tipMinor: number): number | null
	placement(): Promise<
		| { ok: true; loyalty: QrTabPayRequest['loyalty'] | null }
		| { ok: false; message: string }
	>
	refused(code: string, sentPick: boolean): string | null
}

export type TableOrderingDeps = {
	orgId: string
	locationId: string
	locale: string
	formatMoney: (amount: number) => string
	store: CartStore
	cart: { open(): void; close(): void; refresh(): void }
	/** Leaves for the hosted payment page (`location.assign` by default). */
	navigate?: (url: string) => void
}

/** `aria-invalid` must read "true"; an empty attribute counts as false. */
/**
 * Marks a field invalid and points only that field at the error, so a valid
 * field next to it never reads out the other one's message.
 */
function setInvalid(input: HTMLElement, invalid: boolean, errorId: string) {
	if (invalid) {
		input.setAttribute('aria-invalid', 'true')
		input.setAttribute('aria-describedby', errorId)
	} else {
		input.removeAttribute('aria-invalid')
		input.removeAttribute('aria-describedby')
	}
}

/**
 * Shows an alert so screen readers announce it: the box is visible first and
 * the text lands a frame later (text set together with un-hiding is often
 * missed).
 */
function showAlert(element: HTMLElement, message: string) {
	element.classList.remove('hidden')
	element.textContent = ''
	requestAnimationFrame(() => {
		element.textContent = message
	})
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
	const navigate =
		deps.navigate ?? ((url: string) => window.location.assign(url))
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
		if (code === 'tab_paying') return labels.errorTabPaying
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
		// A paid tab's receipt: the reward and the tip it was paid with.
		const { loyaltyDiscountCents: discount, tipCents: tip } = tab.totals
		document
			.getElementById('tab-discount-row')
			?.classList.toggle('hidden', !(discount > 0))
		set('tab-discount', discount > 0 ? money(-discount) : '')
		document
			.getElementById('tab-tip-row')
			?.classList.toggle('hidden', !(tip > 0))
		set('tab-tip', tip > 0 ? money(tip) : '')
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
					loyaltyDiscountCents: 0,
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
				(error.status === 404 || error.code === 'tab_not_found') &&
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
			// A fresh sheet: no error left over from an earlier attempt.
			setInvalid(name, false, 'table-contact-error')
			setInvalid(phone, false, 'table-contact-error')
			const error = document.getElementById('table-contact-error')
			if (error) {
				error.textContent = ''
				error.classList.add('hidden')
			}
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
		setInvalid(nameInput, nameMissing, 'table-contact-error')
		setInvalid(phoneInput, phoneMissing, 'table-contact-error')
		if (nameMissing || phoneMissing) {
			if (error) showAlert(error, contactError(nameMissing, phoneMissing))
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
	const payChanged = document.getElementById('tab-pay-changed')
	let releasePay: (() => void) | null = null
	let payTab: QrPublicTab | null = null
	let paying = false
	// Bumped when the guest backs out while the reward is being confirmed,
	// so that attempt stops before anything is sent.
	let payAttempt = 0
	// The payment start is on its way: the region fixes the amount and the
	// hosted page follows, so the sheet stays until the region answers.
	let paymentSent = false
	// The region priced the payment differently from what the button showed:
	// its hosted page opens only once the guest has seen the new amount and
	// pays again.
	let confirmUrl: string | null = null
	// The region may hold a payment session with the tip and reward that went
	// out (it answered, or the answer was lost). It re-serves that session only
	// for the same tip and reward and refuses any other as "someone else is
	// paying", so they stay locked until the region refuses for good.
	let choiceHeld = false
	let rewards: TabRewards | null = null
	let rewardsLoading: Promise<TabRewards | null> | null = null

	function tipPercent(): number {
		const checked = payForm?.querySelector<HTMLInputElement>(
			'input[name="tipPercent"]:checked',
		)
		return Number(checked?.value ?? 0) || 0
	}

	function tipMinor(): number {
		if (!payTab) return 0
		return Math.round((payTab.totals.subtotalCents * tipPercent()) / 100)
	}

	/** The tab plus the tip, less a priced reward; null while it is priced. */
	function estimatedMinor(): number | null {
		if (!payTab) return null
		const tip = tipMinor()
		return rewards
			? rewards.amountMinor(payTab.totals.totalCents, tip)
			: payTab.totals.totalCents + tip
	}

	function paintPayAmount() {
		// While the payment starts, or waits on a new amount, the button keeps
		// saying so.
		if (!payTab || !paySubmit || paying || confirmUrl) return
		const amount = estimatedMinor()
		// A picked reward is still being priced: no amount until it is.
		paySubmit.textContent =
			amount === null
				? labels.payNow
				: fill(labels.payAmount, { amount: deps.formatMoney(amount / 100) })
	}

	/** The reward picker, for a signed-in guest; null for anyone else. */
	function loadRewards(): Promise<TabRewards | null> {
		if (rewards || !getAccessToken()) return Promise.resolve(rewards)
		rewardsLoading ??= import('~/lib/loyalty/tab-rewards')
			.then(({ mountTabRewards }) => {
				const section = document.getElementById('tab-rewards')
				const options = document.getElementById('tab-rewards-options')
				if (!section || !options) return null
				rewards = mountTabRewards({
					section,
					options,
					balance: document.getElementById('tab-rewards-balance'),
					notice: document.getElementById('tab-rewards-notice'),
					locale: deps.locale,
					formatMoney: (minor) => deps.formatMoney(minor / 100),
					tipPercent,
					tipMinor,
					onChange: paintPayAmount,
				})
				return rewards
			})
			// Offline or a newer deploy: pay without rewards this time.
			.catch(() => null)
			.finally(() => {
				rewardsLoading = null
			})
		return rewardsLoading
	}

	function openPay(tab: QrPublicTab) {
		if (!payMotion || !payForm) return
		payTab = tab
		if (payError) {
			payError.textContent = ''
			payError.classList.add('hidden')
		}
		for (const field of ['name', 'phone']) {
			setInvalid(
				payForm.elements.namedItem(field) as HTMLInputElement,
				false,
				'tab-pay-error',
			)
		}
		if (choiceHeld && payChanged) showAlert(payChanged, labels.payPending)
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
		const tabToken = session?.tabToken
		if (tabToken) {
			void loadRewards().then((picker) => {
				// The guest may have closed the sheet while the picker loaded.
				if (picker && payTab === tab && payMotion.isOpen()) {
					picker.open(tab, tabToken)
				}
			})
		}
	}

	function closePay() {
		if (paymentSent) return
		if (paying || confirmUrl) {
			payAttempt += 1
			idlePay()
			paintPayAmount()
		}
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
		if (!session || !payForm || paying) return
		if (confirmUrl) {
			openCheckout(confirmUrl)
			return
		}
		const name = (
			payForm.elements.namedItem('name') as HTMLInputElement
		).value.trim()
		const phone = (
			payForm.elements.namedItem('phone') as HTMLInputElement
		).value.trim()
		const showError = (message: string) => {
			if (payError) showAlert(payError, message)
		}
		const nameField = payForm.elements.namedItem('name') as HTMLInputElement
		const phoneField = payForm.elements.namedItem('phone') as HTMLInputElement
		const phoneBad = !/^\+?[\d\s\-().]{7,25}$/.test(phone)
		setInvalid(nameField, !name, 'tab-pay-error')
		setInvalid(phoneField, phoneBad, 'tab-pay-error')
		if (!name || phoneBad) {
			showError(contactError(!name, phoneBad))
			;(!name ? nameField : phoneField).focus()
			return
		}
		void pay(session, { name, phone })
	})

	/** While the payment starts, tip, reward and contact cannot change. */
	function lockPay(locked: boolean) {
		if (!payForm) return
		for (const field of ['name', 'phone']) {
			const input = payForm.elements.namedItem(field)
			if (input instanceof HTMLInputElement) input.disabled = locked
		}
		lockChoice(locked || choiceHeld)
	}

	function lockChoice(locked: boolean) {
		if (!payForm) return
		const tip = payForm.querySelector('fieldset')
		if (tip instanceof HTMLFieldSetElement) tip.disabled = locked
		// inert covers reward radios the picker rebuilds mid-payment.
		const rewardOptions = document.getElementById('tab-rewards-options')
		if (rewardOptions) rewardOptions.inert = locked
	}

	async function pay(
		current: TableSession,
		contact: { name: string; phone: string },
	) {
		payAttempt += 1
		const attempt = payAttempt
		const shownMinor = estimatedMinor()
		paying = true
		lockPay(true)
		payError?.classList.add('hidden')
		if (paySubmit) {
			paySubmit.textContent = labels.paying
			paySubmit.setAttribute('aria-busy', 'true')
			paySubmit.disabled = true
		}
		// A reward goes out only as the latest quote priced it.
		const reward = (await rewards?.placement()) ?? {
			ok: true as const,
			loyalty: null,
		}
		// The guest closed the sheet while the reward was being confirmed.
		if (attempt !== payAttempt) return
		if (!reward.ok) {
			stopPaying(reward.message)
			return
		}
		paymentSent = true
		let regionAnswered = false
		try {
			const started = await startTabPayment(orgId, current, {
				tipPercent: tipPercent(),
				contact,
				locale: deps.locale,
				loyalty: reward.loyalty,
			})
			regionAnswered = true
			choiceHeld = true
			const url = acceptCheckoutUrl(started.url)
			// The region fixed the amount. The guest sees it before paying
			// whenever it is not what the button showed.
			if (started.amountCents !== shownMinor) {
				askToConfirm(url, started.amountCents)
				return
			}
			openCheckout(url)
		} catch (error) {
			const code =
				error instanceof TableRequestError ? error.code : 'payment_unavailable'
			if (regionAnswered || code === 'network') choiceHeld = true
			else if (code !== 'tab_paying') choiceHeld = false
			// A refused sign-in answers 401 with plain text instead of a code.
			const rewardMessage = rewards?.refused(
				error instanceof TableRequestError && error.status === 401
					? 'unauthorized'
					: code,
				Boolean(reward.loyalty),
			)
			stopPaying(
				rewardMessage ??
					(code === 'rounds_pending'
						? labels.payLater
						: code === 'online_pay_unavailable'
							? labels.payUnavailable
							: code === 'tab_paying' && choiceHeld
								? labels.payPending
								: errorText(code)),
			)
		}
	}

	function openCheckout(url: string) {
		confirmUrl = null
		paying = true
		paymentSent = true
		payChanged?.classList.add('hidden')
		if (paySubmit) {
			paySubmit.textContent = labels.paying
			paySubmit.setAttribute('aria-busy', 'true')
			paySubmit.disabled = true
		}
		navigate(url)
	}

	/**
	 * Shows the amount the region fixed and waits for the guest to pay again.
	 * The tip, reward and contact stay locked: the hosted page charges them.
	 */
	function askToConfirm(url: string, amountMinor: number) {
		confirmUrl = url
		paying = false
		paymentSent = false
		const amount = deps.formatMoney(amountMinor / 100)
		if (paySubmit) {
			paySubmit.textContent = fill(labels.payAmount, { amount })
			paySubmit.removeAttribute('aria-busy')
			paySubmit.disabled = false
			paySubmit.focus({ preventScroll: true })
		}
		if (payChanged) {
			showAlert(payChanged, fill(labels.payAmountChanged, { amount }))
		}
	}

	/** Ready for a new payment: fields unlocked, the button idle. */
	function idlePay() {
		paying = false
		paymentSent = false
		confirmUrl = null
		payChanged?.classList.add('hidden')
		lockPay(false)
		if (paySubmit) {
			paySubmit.removeAttribute('aria-busy')
			paySubmit.disabled = false
		}
	}

	function stopPaying(message: string) {
		idlePay()
		if (payError) showAlert(payError, message)
		paintPayAmount()
	}

	// Back from the hosted page through the browser's back button: the page
	// comes back from the back-forward cache with the button still busy.
	window.addEventListener('pageshow', (event) => {
		if (!event.persisted || !paySubmit) return
		idlePay()
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
		const stash = (() => {
			try {
				return window.sessionStorage
			} catch {
				return null
			}
		})()
		const fromAddress = readTableFragment(window.location.href)
		// Usually the layout already moved the code out of the address bar.
		const scanned = fromAddress ?? takeStashedTableScan(stash)
		if (fromAddress) {
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
