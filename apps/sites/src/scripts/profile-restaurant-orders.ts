import {
	type CustomerOrderListItem,
	type CustomerOrdersPage,
} from '@repo/common/customer-orders'
import { getLocalizedMenuValue } from '@repo/common/menu-types'
import { reorderHref } from './reorder'
import { redirectToLogin, tenantFetch } from '~/lib/client-auth'
import { formatMoney } from '~/lib/ordering/money'

/**
 * Profile, Orders (#112): the signed-in guest's restaurant orders, newest
 * first, with a detail view and "Order again". Browser direct to the region
 * with the customer token: the list holds only orders linked to the guest's
 * `customer_id`, and Sites never sees them.
 */

export type RestaurantOrdersLabels = {
	empty: string
	emptyHint: string
	orderAgain: string
	finish: string
	details: string
	hideDetails: string
	loadMore: string
	loadError: string
	retry: string
	items: string
	subtotal: string
	total: string
	tax: string
	number: string
	statuses: Record<string, string>
}

type ReceiptLine = {
	itemName: string
	quantity: number
	totalCents: number
	variantNames?: string[]
	options?: Array<{ optionName: string; quantity: number }>
}

type Receipt = {
	subtotalCents: number
	taxCents: number
	totalCents: number
	currency: string
	lines: ReceiptLine[]
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

const button =
	'inline-flex min-h-10 items-center justify-center rounded-md px-4 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'

export function summaryOf(
	order: CustomerOrderListItem,
	locale: string,
	defaultLocale: string,
): string {
	const names = order.itemNames
		.map((name) => getLocalizedMenuValue(name, locale, defaultLocale))
		.filter(Boolean)
	const extra = order.itemCount - names.length
	return extra > 0 && names.length > 0
		? `${names.join(', ')} +${extra}`
		: names.join(', ')
}

function renderDetail(
	receipt: Receipt,
	labels: RestaurantOrdersLabels,
	locale: string,
	defaultLocale: string,
) {
	const box = el('div', 'space-y-2 border-t border-border px-4 py-3 text-sm')
	box.appendChild(el('p', 'text-xs text-muted-foreground', labels.items))
	const list = el('ul', 'space-y-1')
	for (const line of receipt.lines) {
		const choices = [
			...(line.variantNames ?? []).map((n) =>
				getLocalizedMenuValue(n, locale, defaultLocale),
			),
			...(line.options ?? []).map((o) =>
				getLocalizedMenuValue(o.optionName, locale, defaultLocale),
			),
		].filter(Boolean)
		const row = el('li', 'flex justify-between gap-3')
		row.appendChild(
			el(
				'span',
				'min-w-0 break-words',
				`${line.quantity}× ${getLocalizedMenuValue(line.itemName, locale, defaultLocale)}${choices.length ? ` (${choices.join(', ')})` : ''}`,
			),
		)
		row.appendChild(
			el(
				'span',
				'shrink-0 tabular-nums',
				formatMoney(line.totalCents / 100, receipt.currency, locale),
			),
		)
		list.appendChild(row)
	}
	box.appendChild(list)
	const totals: Array<[string, number]> = [
		[labels.subtotal, receipt.subtotalCents],
		...(receipt.taxCents > 0
			? ([[labels.tax, receipt.taxCents]] as Array<[string, number]>)
			: []),
		[labels.total, receipt.totalCents],
	]
	for (const [label, cents] of totals) {
		const row = el('div', 'flex justify-between gap-3 text-muted-foreground')
		row.append(
			el('span', '', label),
			el(
				'span',
				'tabular-nums',
				formatMoney(cents / 100, receipt.currency, locale),
			),
		)
		box.appendChild(row)
	}
	return box
}

export function renderOrderRow(
	order: CustomerOrderListItem,
	options: {
		labels: RestaurantOrdersLabels
		locale: string
		defaultLocale: string
		localePrefix: string
		loadDetail: (id: string) => Promise<Receipt | null>
	},
): HTMLElement {
	const { labels, locale, defaultLocale } = options
	const item = el('li', 'text-sm')
	item.dataset.orderId = order.id
	const head = el(
		'div',
		'flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between',
	)
	const info = el('div', 'min-w-0 space-y-1')
	const title = el(
		'p',
		'font-medium text-foreground',
		`${labels.number} ${order.number}`,
	)
	const meta = el(
		'div',
		'flex flex-wrap items-center gap-2 text-xs text-muted-foreground',
	)
	const status = el(
		'span',
		'inline-flex rounded-full bg-muted px-2 py-0.5 font-medium text-muted-foreground',
		labels.statuses[order.status] ?? order.status,
	)
	status.dataset.status = order.status
	meta.append(
		status,
		el(
			'span',
			'',
			order.createdAt ? new Date(order.createdAt).toLocaleString(locale) : '',
		),
		el(
			'span',
			'',
			getLocalizedMenuValue(order.location.name, locale, defaultLocale),
		),
	)
	info.append(
		title,
		meta,
		el(
			'p',
			'break-words text-muted-foreground',
			summaryOf(order, locale, defaultLocale),
		),
	)
	const side = el('div', 'flex shrink-0 flex-wrap items-center gap-2')
	side.appendChild(
		el(
			'span',
			'tabular-nums text-foreground',
			formatMoney(order.totalCents / 100, order.currency, locale),
		),
	)
	const detailPanel = el('div', 'hidden')
	const toggle = el(
		'button',
		`${button} border border-border text-foreground`,
		labels.details,
	)
	toggle.type = 'button'
	let loaded = false
	toggle.addEventListener('click', async () => {
		const open = detailPanel.classList.contains('hidden')
		if (open && !loaded) {
			const receipt = await options.loadDetail(order.id)
			if (!receipt) return
			detailPanel.replaceChildren(
				renderDetail(receipt, labels, locale, defaultLocale),
			)
			loaded = true
		}
		detailPanel.classList.toggle('hidden', !open)
		toggle.textContent = open ? labels.hideDetails : labels.details
	})
	side.appendChild(toggle)
	if (order.canReorder) {
		const again = el(
			'a',
			`${button} bg-primary text-primary-foreground hover:bg-primary/90`,
			order.canFinish ? labels.finish : labels.orderAgain,
		)
		again.href = reorderHref(order.id, options.localePrefix)
		again.dataset.reorder = order.canFinish ? 'finish' : 'again'
		side.appendChild(again)
	}
	head.append(info, side)
	item.append(head, detailPanel)
	return item
}

export async function initRestaurantOrders(root: HTMLElement) {
	const list = root.querySelector<HTMLElement>('[data-restaurant-orders-list]')
	const loading = root.querySelector<HTMLElement>(
		'[data-restaurant-orders-loading]',
	)
	const more = root.querySelector<HTMLButtonElement>(
		'[data-restaurant-orders-more]',
	)
	const message = root.querySelector<HTMLElement>(
		'[data-restaurant-orders-message]',
	)
	if (!list) return
	const labels = JSON.parse(
		root.dataset.labels ?? '{}',
	) as RestaurantOrdersLabels
	const locale = root.dataset.locale || 'en'
	const defaultLocale = root.dataset.defaultLocale || 'en'
	const localePrefix = root.dataset.localePrefix || ''
	let cursor: string | null = null
	let shown = 0

	const loadDetail = async (id: string): Promise<Receipt | null> => {
		try {
			const { session, response } = await tenantFetch(
				`/customer/orders/${encodeURIComponent(id)}`,
				{ cache: 'no-store' },
			)
			if (session === 'signed_out') {
				redirectToLogin()
				return null
			}
			if (!response.ok) return null
			return ((await response.json()) as { order: Receipt }).order
		} catch {
			return null
		}
	}

	async function loadPage() {
		if (more) more.disabled = true
		try {
			const query = cursor ? `?${new URLSearchParams({ cursor })}` : ''
			const { session, response } = await tenantFetch(
				`/customer/orders${query}`,
				{
					cache: 'no-store',
				},
			)
			if (session === 'signed_out') {
				redirectToLogin()
				return
			}
			if (!response.ok) throw new Error('failed')
			const page = (await response.json()) as CustomerOrdersPage
			loading?.classList.add('hidden')
			for (const order of page.orders) {
				list!.appendChild(
					renderOrderRow(order, {
						labels,
						locale,
						defaultLocale,
						localePrefix,
						loadDetail,
					}),
				)
			}
			shown += page.orders.length
			cursor = page.nextCursor
			if (message) message.textContent = ''
			if (shown === 0 && message) {
				message.textContent = `${labels.empty} ${labels.emptyHint}`
			}
			more?.classList.toggle('hidden', !cursor)
		} catch {
			loading?.classList.add('hidden')
			if (message) message.textContent = labels.loadError
		} finally {
			if (more) more.disabled = false
		}
	}

	more?.addEventListener('click', () => void loadPage())
	await loadPage()
}

const root =
	typeof document !== 'undefined'
		? document.getElementById('restaurant-orders-root')
		: null
if (root) void initRestaurantOrders(root)
