import { type CartStore } from './cart-store.ts'
import { linesExcluding, remainingFor } from './constraints.ts'
import { el, icon, lockScroll, trapFocus } from './dom.ts'
import { fillTemplate } from './money.ts'
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
		/** A number, or a getter when the fee comes from a live delivery quote. */
		deliveryFee: number | (() => number)
		mode: () => FulfillmentMode
	}
	/** Decides whether the checkout button is usable right now. */
	gate: () => CheckoutGate
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

const DRAWER_HIDDEN = ['translate-x-full', 'rtl:-translate-x-full']

export function computeTotals(
	lines: CartItem[],
	config: { taxRate: number; deliveryFee: number; mode: FulfillmentMode },
) {
	const subtotal = lines.reduce(
		(acc, line) => acc + line.unitPrice * line.quantity,
		0,
	)
	const tax = subtotal * ((config.taxRate || 0) / 100)
	const deliveryFee =
		config.mode === 'delivery' && subtotal > 0 ? config.deliveryFee || 0 : 0
	const count = lines.reduce((acc, line) => acc + line.quantity, 0)
	return {
		subtotal,
		tax,
		deliveryFee,
		total: subtotal + tax + deliveryFee,
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
	const backdrop = q<HTMLElement>('cart-drawer-backdrop')
	const drawer = q<HTMLElement>('cart-drawer')
	const closeBtn = q<HTMLButtonElement>('close-cart-btn')
	const itemsEl = q<HTMLElement>('cart-items-container')
	const subtotalEl = q<HTMLElement>('drawer-subtotal')
	const taxEl = q<HTMLElement>('drawer-tax')
	const taxRow = q<HTMLElement>('drawer-tax-row')
	const deliveryRow = q<HTMLElement>('drawer-delivery-row')
	const deliveryFeeEl = q<HTMLElement>('drawer-delivery-fee')
	const totalEl = q<HTMLElement>('drawer-total')
	const checkoutBtn = q<HTMLElement>('drawer-checkout-btn')
	const checkoutTotal = q<HTMLElement>('drawer-checkout-total')
	const checkoutReason = q<HTMLElement>('drawer-checkout-reason')
	const headerExtra = q<HTMLElement>('cart-drawer-header-extra')

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
					visibleOptions.map(optionLabel).join(', '),
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
		const totals = computeTotals(lines, {
			taxRate: options.totals.taxRate,
			deliveryFee:
				typeof options.totals.deliveryFee === 'function'
					? options.totals.deliveryFee()
					: options.totals.deliveryFee,
			mode: options.totals.mode(),
		})

		if (badge) badge.textContent = String(totals.count)
		if (trayCount)
			trayCount.textContent = fillTemplate(labels.itemsCount, {
				count: totals.count,
			})
		if (trayTotal) trayTotal.textContent = formatMoney(totals.total)
		if (tray) {
			tray.classList.toggle('translate-y-full', totals.count === 0)
			tray.setAttribute('aria-hidden', totals.count === 0 ? 'true' : 'false')
			tray.inert = totals.count === 0
		}

		if (subtotalEl) subtotalEl.textContent = formatMoney(totals.subtotal)
		if (taxEl) taxEl.textContent = formatMoney(totals.tax)
		// Display only: a zero tax line is noise in the drawer.
		if (taxRow) taxRow.classList.toggle('hidden', totals.tax <= 0)
		if (deliveryRow)
			deliveryRow.classList.toggle('hidden', totals.deliveryFee <= 0)
		if (deliveryFeeEl)
			deliveryFeeEl.textContent = formatMoney(totals.deliveryFee)
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
		if (!backdrop || !drawer) return
		opener =
			document.activeElement instanceof HTMLElement
				? document.activeElement
				: null
		refresh()
		backdrop.classList.remove('hidden')
		releaseScroll = lockScroll()
		releaseTrap = trapFocus(drawer)
		document.addEventListener('keydown', onKeydown)
		requestAnimationFrame(() => {
			drawer.classList.remove(...DRAWER_HIDDEN)
			;(closeBtn ?? drawer).focus({ preventScroll: true })
		})
	}

	function isOpen() {
		return Boolean(backdrop && !backdrop.classList.contains('hidden'))
	}

	function close() {
		if (!backdrop || !drawer || !isOpen()) return
		drawer.classList.add(...DRAWER_HIDDEN)
		releaseTrap?.()
		releaseTrap = null
		releaseScroll?.()
		releaseScroll = null
		document.removeEventListener('keydown', onKeydown)
		const target = opener
		opener = null
		window.setTimeout(() => backdrop.classList.add('hidden'), 300)
		if (target && target.isConnected) target.focus({ preventScroll: true })
	}

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
