import {
	ORDER_PAY_LINK_HEADER,
	type OrderPayLinkStart,
	type OrderPayLinkSummary,
} from '@repo/common/order-pay-links'
import { formatCateringMoney } from '@repo/common/catering'
import { startPayment } from '~/lib/catering/client'
import { browserLocale } from '~/lib/locale'
import { getTenantApiBase } from '~/lib/tenant-api'

/**
 * Guest pay-what-you-owe page (`/menu/pay`, #163).
 *
 * The capability token travels in the URL fragment (`#p=<token>`) and is kept
 * in sessionStorage so returning from hosted checkout still has it without
 * ever putting it in a query string or server log.
 */

const STORAGE_KEY = 'menuza:order-pay-token'

function readCapabilityToken(): string | null {
	const hash = location.hash.startsWith('#') ? location.hash.slice(1) : ''
	const hashParams = new URLSearchParams(hash)
	const fromHash = hashParams.get('p')?.trim()
	if (fromHash) {
		try {
			sessionStorage.setItem(STORAGE_KEY, fromHash)
		} catch {
			// Ignore storage errors in restricted browsing modes.
		}
		history.replaceState(null, '', location.pathname + location.search)
		return fromHash
	}
	try {
		return sessionStorage.getItem(STORAGE_KEY)
	} catch {
		return null
	}
}

const root = document.getElementById('order-pay-root')
const labelsEl = document.getElementById('order-pay-labels')
const labels = labelsEl?.textContent
	? (JSON.parse(labelsEl.textContent) as Record<string, string>)
	: {}

if (root) {
	const status = root.querySelector<HTMLElement>('[data-op-status]')!
	const body = root.querySelector<HTMLElement>('[data-op-body]')!
	const errorEl = root.querySelector<HTMLElement>('[data-op-error]')!
	const slug = root.dataset.orgSlug ?? ''
	const locale = browserLocale()
	const params = new URLSearchParams(location.search)
	const token = readCapabilityToken()

	const showMessage = (text: string) => {
		status.textContent = ''
		const p = document.createElement('p')
		p.className = 'text-base'
		p.textContent = text
		body.replaceChildren(p)
	}

	if (!token) {
		showMessage(labels.invalid ?? 'This payment link is not valid.')
	} else {
		const apiBase = getTenantApiBase()
		const query = slug
			? `slug=${encodeURIComponent(slug)}`
			: `host=${encodeURIComponent(location.host)}`

		void (async () => {
			try {
				if (params.get('paid') === '1') {
					showMessage(
						labels.paidThanks ?? 'Thank you! Your payment has been received.',
					)
					return
				}
				const res = await fetch(`${apiBase}/orders/pay?${query}`, {
					headers: { [ORDER_PAY_LINK_HEADER]: token },
					cache: 'no-store',
				})
				const data = (await res.json().catch(() => null)) as
					OrderPayLinkSummary | { error?: string; message?: string } | null
				status.textContent = ''
				if (!res.ok || !data || 'error' in data) {
					const code = data && 'error' in data ? data.error : ''
					if (code === 'pay_link_expired') {
						showMessage(labels.expired ?? 'This payment link has expired.')
					} else if (code === 'order_cancelled') {
						showMessage(labels.cancelled ?? 'This order was cancelled.')
					} else {
						showMessage(labels.invalid ?? 'This payment link is not valid.')
					}
					return
				}

				if (params.get('cancelled') === '1') {
					errorEl.textContent = labels.paymentCancelled ?? ''
				}
				if (data.paymentStatus === 'paid' || data.amountDueCents <= 0) {
					showMessage(labels.paid ?? 'This order is already paid in full.')
					return
				}
				if (!data.payable) {
					showMessage(
						labels.nothingDue ?? 'There is nothing due on this order.',
					)
					return
				}

				const money = (minor: number) =>
					formatCateringMoney(minor, data.currency, locale)

				const card = document.createElement('div')
				card.className = 'flex flex-col gap-3 rounded-lg border p-4'

				const heading = document.createElement('p')
				heading.className = 'text-base font-semibold'
				heading.textContent = `${labels.orderNumber ?? 'Order'} #${data.number}${data.locationName ? ` · ${data.locationName}` : ''}`
				card.append(heading)

				if (data.lines.length > 0) {
					const list = document.createElement('ul')
					list.className = 'flex flex-col gap-1 border-t pt-2 text-sm'
					for (const line of data.lines) {
						const li = document.createElement('li')
						li.className = 'flex justify-between gap-2'
						const left = document.createElement('span')
						left.textContent = `${line.quantity} × ${line.name}`
						const right = document.createElement('span')
						right.textContent = money(line.totalCents)
						li.append(left, right)
						list.append(li)
					}
					card.append(list)
				}

				const totals = document.createElement('div')
				totals.className = 'flex flex-col gap-1 border-t pt-2 text-sm'
				const addRow = (label: string, val: string, bold = false) => {
					const row = document.createElement('div')
					row.className = `flex justify-between${bold ? ' text-base font-semibold' : ''}`
					const a = document.createElement('span')
					a.textContent = label
					const b = document.createElement('span')
					b.textContent = val
					row.append(a, b)
					totals.append(row)
				}
				addRow(labels.total ?? 'Order total', money(data.totalCents))
				if (data.paidCents > 0) {
					addRow(labels.paidSoFar ?? 'Paid so far', money(data.paidCents))
				}
				addRow(
					labels.amountDue ?? 'Amount due',
					money(data.amountDueCents),
					true,
				)
				card.append(totals)

				const payBtn = document.createElement('button')
				payBtn.type = 'button'
				payBtn.className =
					'h-12 rounded-md bg-primary px-6 text-base font-medium text-primary-foreground'
				payBtn.textContent = `${labels.payNow ?? 'Pay now'} · ${money(data.amountDueCents)}`
				payBtn.addEventListener('click', async () => {
					errorEl.textContent = ''
					payBtn.disabled = true
					try {
						const startRes = await fetch(`${apiBase}/orders/pay?${query}`, {
							method: 'POST',
							headers: { [ORDER_PAY_LINK_HEADER]: token },
							cache: 'no-store',
						})
						const started = (await startRes.json().catch(() => null)) as
							OrderPayLinkStart | { error?: string; message?: string } | null
						if (!startRes.ok || !started || 'error' in started) {
							const code = started && 'error' in started ? started.error : ''
							errorEl.textContent =
								code === 'order_fully_paid'
									? (labels.paid ?? 'This order is already paid in full.')
									: code === 'nothing_due'
										? (labels.nothingDue ?? 'Nothing due.')
										: (labels.errGeneric ?? 'Could not start payment.')
							payBtn.disabled = false
							return
						}
						const checkoutUrl = await startPayment(
							started.orderRef,
							started.paymentToken,
							locale,
						)
						location.assign(checkoutUrl)
					} catch {
						errorEl.textContent =
							labels.errGeneric ?? 'Could not start payment.'
						payBtn.disabled = false
					}
				})

				body.replaceChildren(card, payBtn)
			} catch {
				status.textContent = ''
				showMessage(labels.errGeneric ?? 'Could not load order.')
			}
		})()
	}
}
