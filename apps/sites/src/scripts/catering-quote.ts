import { formatCateringMoney } from '@repo/common/catering'
import {
	CateringClientError,
	getQuote,
	payQuote,
	startPayment,
	takeCapability,
} from '~/lib/catering/client'
import {
	fillCateringTemplate,
	readCateringLabels,
} from '~/lib/catering/read-labels'
import { browserLocale } from '~/lib/locale'

/**
 * The quote page (#124): the lines, charges and total the restaurant set, the
 * deposit due now and the balance later, and "Accept and pay" through the
 * hosted checkout. The link is a capability read from the URL fragment; an old
 * or edited quote answers the same refusal.
 */
const root = document.getElementById('catering-quote-root')
const labels = readCateringLabels()

if (root) {
	const status = root.querySelector<HTMLElement>('[data-ct-status]')!
	const body = root.querySelector<HTMLElement>('[data-ct-body]')!
	const error = root.querySelector<HTMLElement>('[data-ct-error]')!
	const locale = browserLocale()
	const params = new URLSearchParams(location.search)
	const capability = takeCapability('quote')

	const message = (text: string) => {
		status.textContent = ''
		const p = document.createElement('p')
		p.textContent = text
		body.replaceChildren(p)
	}

	if (!capability) {
		message(labels.quoteGone)
	} else {
		void (async () => {
			try {
				const quote = await getQuote(capability.id, capability.token)
				status.textContent = ''
				const money = (minor: number) =>
					formatCateringMoney(minor, quote.currency, locale)
				if (params.get('paid') === '1' || quote.status === 'paid') {
					message(
						params.get('paid') === '1'
							? labels.paidThanks
							: labels.quoteAlreadyPaid,
					)
					return
				}
				if (params.get('cancelled') === '1')
					error.textContent = labels.paymentCancelled
				if (quote.status === 'expired') return message(labels.quoteExpired)
				if (!quote.payable && quote.status !== 'accepted')
					return message(labels.quoteGone)

				const list = document.createElement('ul')
				list.className = 'flex flex-col gap-1'
				for (const line of quote.lines) {
					const li = document.createElement('li')
					li.className = 'flex justify-between gap-3'
					const detail = [...line.variantNames, ...line.options]
						.filter(Boolean)
						.join(', ')
					const name = document.createElement('span')
					name.textContent = `${line.quantity} × ${line.itemName}${detail ? ` (${detail})` : ''}`
					const price = document.createElement('span')
					price.className = 'tabular-nums'
					price.textContent = money(line.totalCents)
					li.append(name, price)
					list.append(li)
				}
				for (const charge of quote.charges) {
					const li = document.createElement('li')
					li.className = 'flex justify-between gap-3'
					const name = document.createElement('span')
					name.textContent = charge.label
					const price = document.createElement('span')
					price.className = 'tabular-nums'
					price.textContent = money(charge.amountCents)
					li.append(name, price)
					list.append(li)
				}
				const lines: string[] = []
				if (quote.eventAt) {
					lines.push(
						`${labels.quoteEvent}: ${new Intl.DateTimeFormat(locale, { dateStyle: 'full', timeStyle: 'short' }).format(new Date(quote.eventAt))}`,
					)
				}
				lines.push(
					`${labels.quoteTax}: ${money(quote.taxCents)}`,
					`${labels.quoteTotal}: ${money(quote.totalCents)}`,
				)
				if (quote.deposit.balanceCents > 0) {
					lines.push(
						fillCateringTemplate(labels.quoteDueNow, {
							amount: money(quote.deposit.depositCents),
						}),
						fillCateringTemplate(labels.quoteBalanceLater, {
							amount: money(quote.deposit.balanceCents),
						}),
					)
				}
				if (quote.expiresAt) {
					lines.push(
						fillCateringTemplate(labels.quoteValidUntil, {
							date: new Intl.DateTimeFormat(locale, {
								dateStyle: 'medium',
							}).format(new Date(quote.expiresAt)),
						}),
					)
				}
				const summary = document.createElement('div')
				summary.className = 'flex flex-col gap-1 font-medium'
				for (const text of lines) {
					const p = document.createElement('p')
					p.textContent = text
					summary.append(p)
				}
				const nodes: HTMLElement[] = [list, summary]
				if (quote.note) {
					const note = document.createElement('p')
					note.className = 'rounded-md border p-3 text-sm whitespace-pre-wrap'
					note.dir = 'auto'
					note.textContent = `${labels.quoteNote}: ${quote.note}`
					nodes.push(note)
				}
				const pay = document.createElement('button')
				pay.type = 'button'
				pay.className =
					'h-12 rounded-md bg-primary px-6 text-base font-medium text-primary-foreground'
				pay.textContent = labels.acceptAndPay
				pay.addEventListener('click', async () => {
					error.textContent = ''
					pay.disabled = true
					try {
						const started = await payQuote(capability.id, capability.token)
						location.assign(
							await startPayment(
								started.orderRef,
								started.paymentToken,
								locale,
							),
						)
					} catch (caught) {
						const code =
							caught instanceof CateringClientError ? caught.code : ''
						error.textContent =
							code === 'quote_expired'
								? labels.quoteExpired
								: code === 'invalid_quote_token' || code === 'quote_cancelled'
									? labels.quoteGone
									: labels.errGeneric
						pay.disabled = false
					}
				})
				nodes.push(pay)
				body.replaceChildren(...nodes)
			} catch (caught) {
				status.textContent = ''
				const code = caught instanceof CateringClientError ? caught.code : ''
				message(
					code === 'quote_not_payable'
						? labels.quoteNotReady
						: code === 'catering_unavailable'
							? labels.unavailable
							: labels.quoteGone,
				)
			}
		})()
	}
}
