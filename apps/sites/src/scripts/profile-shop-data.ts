import { tenantFetch } from '~/lib/client-auth'
import { browserLocaleHref } from '~/lib/locale'

export type ShopOrderRow = {
	productName?: string
	status?: string
	createdAt?: string
	amount?: string
}

export type SavedPaymentMethodRow = {
	brand: string
	last4: string
	expMonth: number
	expYear: number
}

function formatOrderDate(iso: string | null | undefined) {
	if (!iso) return ''
	return new Date(iso).toLocaleString()
}

function formatBrand(brand: string) {
	return brand.charAt(0).toUpperCase() + brand.slice(1)
}

function orderStatusClass(status: string | undefined) {
	const normalized = (status ?? '').toLowerCase()
	if (
		normalized === 'paid' ||
		normalized === 'complete' ||
		normalized === 'completed'
	) {
		return 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
	}
	if (normalized === 'pending' || normalized === 'processing') {
		return 'bg-amber-500/10 text-amber-700 dark:text-amber-400'
	}
	if (
		normalized === 'failed' ||
		normalized === 'canceled' ||
		normalized === 'cancelled'
	) {
		return 'bg-destructive/10 text-destructive'
	}
	return 'bg-muted text-muted-foreground'
}

const emptyStateClass =
	'flex flex-col items-center justify-center gap-3 px-6 py-12 text-center'
const emptyStateIconClass =
	'flex size-11 shrink-0 items-center justify-center rounded-full border border-border bg-muted/40 text-muted-foreground'
const listClass =
	'divide-y divide-border overflow-hidden rounded-lg border border-border bg-background'

function createEmptyState(options: {
	iconSvg: string
	title: string
	hint?: string
	action?: { label: string; href: string }
}) {
	const empty = document.createElement('li')
	empty.className = emptyStateClass

	const icon = document.createElement('span')
	icon.className = emptyStateIconClass
	icon.setAttribute('aria-hidden', 'true')
	icon.innerHTML = options.iconSvg

	const copy = document.createElement('div')
	copy.className = options.action ? 'space-y-3' : 'space-y-1'

	const titleWrap = document.createElement('div')
	titleWrap.className = 'space-y-1'

	const title = document.createElement('p')
	title.className = 'text-sm font-medium text-foreground'
	title.textContent = options.title

	titleWrap.appendChild(title)

	if (options.hint) {
		const hint = document.createElement('p')
		hint.className = 'max-w-sm text-xs leading-relaxed text-muted-foreground'
		hint.textContent = options.hint
		titleWrap.appendChild(hint)
	}

	copy.appendChild(titleWrap)

	if (options.action) {
		const link = document.createElement('a')
		link.href = options.action.href
		link.className =
			'inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:min-w-[9.5rem]'
		link.textContent = options.action.label
		copy.appendChild(link)
	}

	empty.append(icon, copy)
	return empty
}

const ordersEmptyIcon =
	'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="size-5"><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>'

const paymentEmptyIcon =
	'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="size-5"><rect width="20" height="14" x="2" y="5" rx="2"/><line x1="2" x2="22" y1="10" y2="10"/></svg>'

export function renderOrderHistory(
	orderHistory: HTMLElement,
	options: {
		noOrders: string
		noOrdersHint?: string
		browseShop?: string
		shopHref?: string
	},
	orders: ShopOrderRow[],
) {
	orderHistory.className = listClass
	orderHistory.replaceChildren()

	if (orders.length === 0) {
		orderHistory.appendChild(
			createEmptyState({
				iconSvg: ordersEmptyIcon,
				title: options.noOrders,
				hint: options.noOrdersHint,
				action:
					options.browseShop && options.shopHref
						? { label: options.browseShop, href: options.shopHref }
						: undefined,
			}),
		)
		return
	}

	for (const order of orders) {
		const item = document.createElement('li')
		item.className =
			'flex flex-col gap-3 px-4 py-4 transition-colors hover:bg-muted/30 sm:flex-row sm:items-center sm:justify-between'

		const details = document.createElement('div')
		details.className = 'min-w-0 space-y-1.5'

		const name = document.createElement('p')
		name.className = 'font-medium text-foreground'
		name.textContent = String(order.productName ?? '')

		const meta = document.createElement('div')
		meta.className = 'flex flex-wrap items-center gap-2'

		const status = document.createElement('span')
		status.className = `inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${orderStatusClass(order.status)}`
		status.textContent = String(order.status ?? '')

		const date = document.createElement('span')
		date.className = 'text-xs text-muted-foreground'
		date.textContent = formatOrderDate(order.createdAt)

		meta.append(status, date)
		details.append(name, meta)

		const amount = document.createElement('p')
		amount.className =
			'shrink-0 text-sm tabular-nums text-foreground sm:text-base'
		amount.textContent = String(order.amount ?? '')

		item.append(details, amount)
		orderHistory.appendChild(item)
	}
}

export function renderPaymentMethods(
	paymentMethodsList: HTMLElement,
	options: {
		noPaymentMethods: string
		noPaymentMethodsHint?: string
		expiresLabel: string
	},
	methods: SavedPaymentMethodRow[],
) {
	paymentMethodsList.className = listClass
	paymentMethodsList.replaceChildren()

	if (methods.length === 0) {
		paymentMethodsList.appendChild(
			createEmptyState({
				iconSvg: paymentEmptyIcon,
				title: options.noPaymentMethods,
				hint: options.noPaymentMethodsHint,
			}),
		)
		return
	}

	for (const method of methods) {
		const item = document.createElement('li')
		item.className =
			'flex flex-wrap items-center justify-between gap-3 px-4 py-4 transition-colors hover:bg-muted/30'

		const labelWrap = document.createElement('div')
		labelWrap.className = 'flex min-w-0 items-center gap-3'

		const icon = document.createElement('span')
		icon.className =
			'flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-muted/40 text-muted-foreground'
		icon.setAttribute('aria-hidden', 'true')
		icon.innerHTML =
			'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="size-4"><rect width="20" height="14" x="2" y="5" rx="2"/><line x1="2" x2="22" y1="10" y2="10"/></svg>'

		const label = document.createElement('p')
		label.className = 'font-medium text-foreground'
		label.textContent = `${formatBrand(method.brand)} •••• ${method.last4}`

		labelWrap.append(icon, label)

		const expiry = document.createElement('p')
		expiry.className = 'text-sm tabular-nums text-muted-foreground'
		expiry.textContent = `${options.expiresLabel} ${String(method.expMonth).padStart(2, '0')}/${String(method.expYear).slice(-2)}`

		item.append(labelWrap, expiry)
		paymentMethodsList.appendChild(item)
	}
}

export async function loadPaymentMethods(options: {
	paymentMethodsList: HTMLElement | null
	paymentMethodsLoading: HTMLElement | null
	noPaymentMethods: string
	noPaymentMethodsHint?: string
	expiresLabel: string
}) {
	const {
		paymentMethodsList,
		paymentMethodsLoading,
		noPaymentMethods,
		noPaymentMethodsHint,
		expiresLabel,
	} = options
	if (!paymentMethodsList) return

	try {
		const methodsRes = await tenantFetch('/shop/payment-methods')
		if (methodsRes.status === 401) {
			window.location.replace(browserLocaleHref('/login'))
			return
		}
		if (methodsRes.ok) {
			const data = (await methodsRes.json()) as {
				paymentMethods?: SavedPaymentMethodRow[]
			}
			const methods = Array.isArray(data.paymentMethods)
				? data.paymentMethods
				: []
			renderPaymentMethods(
				paymentMethodsList,
				{ noPaymentMethods, noPaymentMethodsHint, expiresLabel },
				methods,
			)
		} else {
			renderPaymentMethods(
				paymentMethodsList,
				{ noPaymentMethods, noPaymentMethodsHint, expiresLabel },
				[],
			)
		}
	} catch (error) {
		console.error('Failed to load payment methods:', error)
		renderPaymentMethods(
			paymentMethodsList,
			{ noPaymentMethods, noPaymentMethodsHint, expiresLabel },
			[],
		)
	} finally {
		paymentMethodsLoading?.classList.add('hidden')
		paymentMethodsList.classList.remove('hidden')
	}
}

export async function loadOrders(options: {
	orderHistory: HTMLElement | null
	orderHistoryLoading: HTMLElement | null
	noOrders: string
	noOrdersHint?: string
	browseShop?: string
	shopHref?: string
}) {
	const {
		orderHistory,
		orderHistoryLoading,
		noOrders,
		noOrdersHint,
		browseShop,
		shopHref,
	} = options
	if (!orderHistory) return

	try {
		const ordersRes = await tenantFetch('/shop/orders')
		if (ordersRes.status === 401) {
			window.location.replace(browserLocaleHref('/login'))
			return
		}
		if (ordersRes.ok) {
			const data = (await ordersRes.json()) as { orders?: ShopOrderRow[] }
			const orders = Array.isArray(data.orders) ? data.orders : []
			renderOrderHistory(
				orderHistory,
				{ noOrders, noOrdersHint, browseShop, shopHref },
				orders,
			)
		} else {
			renderOrderHistory(
				orderHistory,
				{ noOrders, noOrdersHint, browseShop, shopHref },
				[],
			)
		}
	} catch (error) {
		console.error('Failed to load orders:', error)
		renderOrderHistory(
			orderHistory,
			{ noOrders, noOrdersHint, browseShop, shopHref },
			[],
		)
	} finally {
		orderHistoryLoading?.classList.add('hidden')
		orderHistory.classList.remove('hidden')
	}
}
