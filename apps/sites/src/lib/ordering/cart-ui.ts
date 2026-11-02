import { createOverlayMotion } from '../site-motion.ts'
import {
	applyCartQuote,
	listedDiscountNames,
	NO_CART_DISCOUNTS,
	type CartDiscountView,
} from './cart-discounts.ts'
import { type CartStore } from './cart-store.ts'
import { linesExcluding, remainingFor } from './constraints.ts'
import { el, icon, lockScroll, trapFocus } from './dom.ts'
import { fillTemplate } from './money.ts'
import { estimateTax } from './tax.ts'
import {
	type CartItem,
	type Constraints,
	type FulfillmentMode,
	type OrderingLabels,
} from './types.ts'

export type CheckoutGate = { allowed: boolean; reason?: string }

export type CartUiOptions = {
	store: CartStore
	labels: OrderingLabels
	formatMoney: (amount: number) => string
	totals: {
		/** Percentage, e.g. `8.25`. */
		taxRate: number
		/**
		 * Menu prices already include tax (VAT): the tax row shows the portion
		 * contained in the subtotal and the total does not add it.
		 */
		taxInclusive?: boolean
		/** A number, or a getter when the fee comes from a live delivery quote. */
		deliveryFee: number | (() => number)
		mode: () => FulfillmentMode
	}
	/** Decides whether the checkout button is usable right now. */
	gate: () => CheckoutGate
	/**
	 * Discounts priced by the region. `sync` re-prices when the cart changed
	 * (called before every render); `view` says what to show. Left out, the
	 * cart shows its own estimate only.
	 */
	discounts?: {
		sync(): void
		view(): CartDiscountView
		/** A code the region refused for good, to tell the guest once. */
		refusal?(): { code: string } | null
		/** The guest dismissed that refusal (it is removed with the code). */
		dismissRefusal?(): void
	}
	/** The page language, for lists, discount names and the minus sign of amounts. */
	locale?: string
	/** The site's default language: discount names fall back to it. */
	defaultLocale?: string
	constraints?: Constraints | null
	/** Fills the `#cart-drawer-header-extra` slot on every render (pickup summary, etc.). */
	renderHeaderExtra?: (slot: HTMLElement) => void
	root?: ParentNode
}

export type CartUi = {
	open(): void
	close(): void
	refresh(): void
	isOpen(): boolean
}

const STEP_BTN = 'icon-btn size-8 border-0'

/** Joins names the way the page language does ("A, B and C"). */
export function listText(names: readonly string[], locale?: string): string {
	try {
		return new Intl.ListFormat(locale || undefined, {
			style: 'long',
			type: 'conjunction',
		}).format(names)
	} catch {
		return names.join(', ')
	}
}

export function computeTotals(
	lines: CartItem[],
	config: {
		taxRate: number
		taxInclusive?: boolean
		deliveryFee: number
		mode: FulfillmentMode
	},
) {
	const subtotal = lines.reduce(
		(acc, line) => acc + line.unitPrice * line.quantity,
		0,
	)
	const { tax, added } = estimateTax(
		subtotal,
		config.taxRate,
		config.taxInclusive === true,
	)
	const deliveryFee =
		config.mode === 'delivery' && subtotal > 0 ? config.deliveryFee || 0 : 0
	const count = lines.reduce((acc, line) => acc + line.quantity, 0)
	return {
		subtotal,
		tax,
		deliveryFee,
		total: subtotal + added + deliveryFee,
		count,
	}
}

export function mountCartUi(options: CartUiOptions): CartUi {
	const { store, labels, formatMoney } = options
	const root = options.root ?? document
	const q = <T extends HTMLElement>(id: string) =>
		root.querySelector<T>(`#${id}`)

	const tray = q<HTMLElement>('cart-tray')
	const openBtn = q<HTMLButtonElement>('open-cart-btn')
	const badge = q<HTMLElement>('cart-badge-count')
	const trayTotal = q<HTMLElement>('cart-tray-total')
	const trayCount = q<HTMLElement>('cart-tray-count')
	const trayNote = q<HTMLElement>('cart-tray-note')
	const backdrop = q<HTMLElement>('cart-drawer-backdrop')
	const drawer = q<HTMLElement>('cart-drawer')
	const closeBtn = q<HTMLButtonElement>('close-cart-btn')
	const itemsEl = q<HTMLElement>('cart-items-container')
	const subtotalEl = q<HTMLElement>('drawer-subtotal')
	const taxEl = q<HTMLElement>('drawer-tax')
	const taxLabelEl = q<HTMLElement>('drawer-tax-label')
	const taxRow = q<HTMLElement>('drawer-tax-row')
	const deliveryRow = q<HTMLElement>('drawer-delivery-row')
	const deliveryFeeEl = q<HTMLElement>('drawer-delivery-fee')
	const discountRow = q<HTMLElement>('drawer-discount-row')
	const discountNamesEl = q<HTMLElement>('drawer-discount-names')
	const discountEl = q<HTMLElement>('drawer-discount')
	const noteEl = q<HTMLElement>('drawer-discount-note')
	const noteRow = q<HTMLElement>('drawer-discount-note-row')
	const noteLive = q<HTMLElement>('drawer-discount-live')
	const noteDismiss = q<HTMLButtonElement>('drawer-discount-note-dismiss')
	const totalEl = q<HTMLElement>('drawer-total')
	const checkoutBtn = q<HTMLElement>('drawer-checkout-btn')
	const checkoutTotal = q<HTMLElement>('drawer-checkout-total')
	const checkoutReason = q<HTMLElement>('drawer-checkout-reason')
	const headerExtra = q<HTMLElement>('cart-drawer-header-extra')
	const motion =
		backdrop && drawer ? createOverlayMotion(backdrop, drawer) : null

	let releaseTrap: (() => void) | null = null
	let releaseScroll: (() => void) | null = null
	let opener: HTMLElement | null = null

	function renderEmpty(): HTMLElement {
		const empty = el(
			'div',
			'flex flex-col items-center gap-3 px-6 py-16 text-center',
		)
		const tile = el(
			'span',
			'flex size-12 items-center justify-center rounded-xl bg-muted text-muted-foreground',
		)
		tile.appendChild(icon('bag', 'size-6'))
		empty.appendChild(tile)
		empty.appendChild(
			el('p', 'text-base font-semibold text-foreground', labels.emptyCartTitle),
		)
		empty.appendChild(
			el('p', 'max-w-sm text-sm text-muted-foreground', labels.emptyCartDesc),
		)
		if (labels.exploreMenu) {
			const action = el('button', 'btn-secondary mt-1', labels.exploreMenu)
			action.type = 'button'
			action.addEventListener('click', () => close())
			empty.appendChild(action)
		}
		return empty
	}

	function optionLabel(option: CartItem['options'][number]): string {
		let text = option.optionName
		if (option.quantity && option.quantity > 1)
			text = `${option.quantity}× ${text}`
		if (option.half && option.half !== 'whole') {
			text = `${text} (${option.half === 'left' ? labels.left : labels.right})`
		}
		if (option.priceDelta > 0)
			text = `${text} (+${formatMoney(option.priceDelta)})`
		return text
	}

	function capNoteFor(line: CartItem, lines: CartItem[]): string {
		if (!options.constraints) return ''
		const cap = remainingFor(
			line.itemId,
			linesExcluding(lines, line.id),
			options.constraints,
		)
		if (cap.max === null || line.quantity < cap.max) return ''
		const showInventory = options.constraints.showInventory !== false
		switch (cap.reason) {
			case 'inventory':
				return showInventory
					? fillTemplate(labels.onlyNLeft, { count: cap.max })
					: ''
			case 'category-inventory':
				return showInventory
					? fillTemplate(labels.onlyNLeftIn, {
							count: cap.max,
							category: cap.categoryName ?? '',
						})
					: ''
			case 'limit':
				return fillTemplate(labels.limitNPerOrder, {
					count: cap.limit ?? cap.max,
				})
			default:
				return ''
		}
	}

	function renderLine(line: CartItem, lines: CartItem[]): HTMLElement {
		const row = el('li', 'flex gap-3 py-4')
		const body = el('div', 'min-w-0 flex-1')
		const head = el('div', 'flex items-start justify-between gap-3')
		head.appendChild(
			el(
				'p',
				'min-w-0 text-sm font-semibold leading-snug text-foreground',
				line.name,
			),
		)
		head.appendChild(
			el(
				'span',
				'price shrink-0 text-sm text-foreground',
				formatMoney(line.unitPrice * line.quantity),
			),
		)
		body.appendChild(head)

		const visibleOptions = line.options.filter((option) => option.optionName)
		if (visibleOptions.length) {
			body.appendChild(
				el(
					'p',
					'mt-1 text-xs leading-relaxed text-muted-foreground',
					listText(visibleOptions.map(optionLabel), options.locale),
				),
			)
		}
		if (line.instructions) {
			body.appendChild(
				el(
					'p',
					'mt-1 text-xs italic leading-relaxed text-muted-foreground',
					`“${line.instructions}”`,
				),
			)
		}

		const controls = el('div', 'mt-2 flex items-center gap-3')
		const stepper = el(
			'div',
			'inline-flex items-center gap-1 rounded-lg border border-border bg-background p-0.5',
		)
		const minus = el('button', STEP_BTN)
		minus.type = 'button'
		minus.setAttribute('aria-label', `${labels.decrease}: ${line.name}`)
		minus.appendChild(icon('minus', 'size-3.5'))
		const qty = el(
			'span',
			'price min-w-6 text-center text-sm text-foreground',
			String(line.quantity),
		)
		const plus = el('button', STEP_BTN)
		plus.type = 'button'
		plus.setAttribute('aria-label', `${labels.increase}: ${line.name}`)
		plus.appendChild(icon('plus', 'size-3.5'))
		stepper.append(minus, qty, plus)
		const remove = el(
			'button',
			'focus-ring ms-auto rounded-sm text-xs font-semibold text-muted-foreground underline-offset-4 hover:text-destructive hover:underline',
			labels.remove,
		)
		remove.type = 'button'
		remove.setAttribute('aria-label', `${labels.remove}: ${line.name}`)
		controls.append(stepper, remove)
		body.appendChild(controls)

		const note = capNoteFor(line, lines)
		if (note) {
			plus.disabled = true
			body.appendChild(el('p', 'mt-2 text-xs text-muted-foreground', note))
		}

		minus.addEventListener('click', () =>
			store.setQuantity(line.id, line.quantity - 1),
		)
		plus.addEventListener('click', () =>
			store.setQuantity(line.id, line.quantity + 1),
		)
		remove.addEventListener('click', () => store.remove(line.id))

		row.appendChild(body)
		return row
	}

	function refresh() {
		const lines = store.lines()
		const taxInclusive = options.totals.taxInclusive === true
		const estimate = computeTotals(lines, {
			taxRate: options.totals.taxRate,
			taxInclusive,
			deliveryFee:
				typeof options.totals.deliveryFee === 'function'
					? options.totals.deliveryFee()
					: options.totals.deliveryFee,
			mode: options.totals.mode(),
		})
		// Re-price first: a change of state re-enters `refresh`, and the view
		// read below is then the latest one.
		options.discounts?.sync()
		const discountView = options.discounts?.view() ?? NO_CART_DISCOUNTS
		const totals = applyCartQuote(estimate, discountView.quote, {
			locale: options.locale,
			defaultLocale: options.defaultLocale,
		})
		const estimateNote =
			discountView.note === 'before_discounts'
				? labels.beforeDiscounts
				: discountView.note === 'at_checkout'
					? labels.discountsAtCheckout
					: ''
		// A code the region refused for good is told once, here, until the guest
		// removes it.
		const refusal = options.discounts?.refusal?.() ?? null
		const refusalNote =
			refusal && labels.couponNotApplied
				? fillTemplate(labels.couponNotApplied, { code: refusal.code })
				: ''
		const note = [refusalNote, estimateNote].filter(Boolean).join(' ')

		if (badge) badge.textContent = String(totals.count)
		if (trayCount)
			trayCount.textContent = fillTemplate(labels.itemsCount, {
				count: totals.count,
			})
		if (trayTotal) trayTotal.textContent = formatMoney(totals.total)
		if (trayNote) {
			trayNote.textContent = note
			trayNote.classList.toggle('hidden', !note)
		}
		if (noteLive && noteLive.textContent !== note) {
			// The live region stays mounted and only its text changes, so a screen
			// reader announces each new note (a node toggled from display:none
			// often is not).
			noteLive.textContent = note
		}
		if (noteDismiss) {
			noteDismiss.classList.toggle('hidden', !refusalNote)
			if (labels.couponRemove) noteDismiss.textContent = labels.couponRemove
			if (refusal && labels.couponNoteRemove) {
				noteDismiss.setAttribute(
					'aria-label',
					fillTemplate(labels.couponNoteRemove, { code: refusal.code }),
				)
			}
		}
		if (tray) {
			tray.classList.toggle('translate-y-full', totals.count === 0)
			tray.setAttribute('aria-hidden', totals.count === 0 ? 'true' : 'false')
			tray.inert = totals.count === 0
		}

		if (subtotalEl) subtotalEl.textContent = formatMoney(totals.subtotal)
		if (taxEl) taxEl.textContent = formatMoney(totals.tax)
		if (taxLabelEl) {
			const label = taxInclusive
				? taxLabelEl.dataset.inclusiveLabel
				: taxLabelEl.dataset.exclusiveLabel
			if (label) taxLabelEl.textContent = label
		}
		// Display only: a zero tax line is noise in the drawer.
		if (taxRow) taxRow.classList.toggle('hidden', totals.tax <= 0)
		if (deliveryRow)
			deliveryRow.classList.toggle('hidden', totals.deliveryFee <= 0)
		if (deliveryFeeEl)
			deliveryFeeEl.textContent = formatMoney(totals.deliveryFee)
		if (discountRow)
			discountRow.classList.toggle('hidden', totals.discount <= 0)
		if (discountEl) {
			// The sign comes from the number formatter, so it sits right in RTL.
			discountEl.textContent =
				totals.discount > 0 ? formatMoney(-totals.discount) : ''
		}
		if (discountNamesEl) {
			const names = listedDiscountNames(totals.names)
			discountNamesEl.textContent = listText(names, options.locale)
			discountNamesEl.classList.toggle('hidden', names.length === 0)
		}
		if (noteEl) noteEl.textContent = note
		noteRow?.classList.toggle('hidden', !note)
		if (totalEl) totalEl.textContent = formatMoney(totals.total)
		if (checkoutTotal) checkoutTotal.textContent = formatMoney(totals.total)

		if (itemsEl) {
			if (!lines.length) {
				itemsEl.replaceChildren(renderEmpty())
			} else {
				const list = el('ul', 'divide-y divide-border')
				for (const line of lines) list.appendChild(renderLine(line, lines))
				itemsEl.replaceChildren(list)
			}
		}

		const gate = totals.count === 0 ? { allowed: false } : options.gate()
		if (checkoutBtn) {
			checkoutBtn.classList.toggle('pointer-events-none', !gate.allowed)
			checkoutBtn.classList.toggle('opacity-50', !gate.allowed)
			checkoutBtn.setAttribute('aria-disabled', gate.allowed ? 'false' : 'true')
			if (gate.allowed) checkoutBtn.removeAttribute('tabindex')
			else checkoutBtn.setAttribute('tabindex', '-1')
		}
		if (checkoutReason) {
			const reason =
				totals.count > 0 && !gate.allowed ? (gate.reason ?? '') : ''
			checkoutReason.textContent = reason
			checkoutReason.classList.toggle('hidden', !reason)
		}

		if (headerExtra && options.renderHeaderExtra)
			options.renderHeaderExtra(headerExtra)
	}

	function onKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			event.preventDefault()
			close()
		}
	}

	function open() {
		if (!backdrop || !drawer || !motion || motion.isOpen()) return
		opener =
			document.activeElement instanceof HTMLElement
				? document.activeElement
				: null
		refresh()
		motion.open()
		releaseScroll = lockScroll()
		releaseTrap = trapFocus(drawer)
		document.addEventListener('keydown', onKeydown)
		;(closeBtn ?? drawer).focus({ preventScroll: true })
	}

	function isOpen() {
		return motion?.isOpen() ?? false
	}

	function close() {
		if (!motion || !isOpen()) return
		releaseTrap?.()
		releaseTrap = null
		releaseScroll?.()
		releaseScroll = null
		document.removeEventListener('keydown', onKeydown)
		const target = opener
		opener = null
		if (target && target.isConnected) target.focus({ preventScroll: true })
		motion.close()
	}

	noteDismiss?.addEventListener('click', () => {
		options.discounts?.dismissRefusal?.()
		refresh()
		;(closeBtn ?? drawer)?.focus({ preventScroll: true })
	})
	openBtn?.addEventListener('click', open)
	closeBtn?.addEventListener('click', close)
	backdrop?.addEventListener('click', (event) => {
		if (event.target === backdrop) close()
	})
	checkoutBtn?.addEventListener('click', (event) => {
		if (checkoutBtn.getAttribute('aria-disabled') === 'true')
			event.preventDefault()
	})
	store.subscribe(refresh)
	refresh()

	return { open, close, refresh, isOpen }
}
