import { formatCateringMoney } from '@repo/common/catering'
import {
	CateringClientError,
	getBalance,
	payBalance,
	startPayment,
	takeCapability,
} from '~/lib/catering/client'
import {
	fillCateringTemplate,
	readCateringLabels,
} from '~/lib/catering/read-labels'
import { browserLocale } from '~/lib/locale'

/**
 * The pay-the-balance page (#361): what is still owed on a catering order and
 * "Pay the balance" through the hosted checkout. The link is a capability in
 * the URL fragment; voiding or reopening the balance replaces it.
 */
const root = document.getElementById('catering-balance-root')
const labels = readCateringLabels()

if (root) {
	const status = root.querySelector<HTMLElement>('[data-ct-status]')!
	const body = root.querySelector<HTMLElement>('[data-ct-body]')!
	const error = root.querySelector<HTMLElement>('[data-ct-error]')!
	const locale = browserLocale()
	const params = new URLSearchParams(location.search)
	const capability = takeCapability('balance')

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
				const balance = await getBalance(capability.id, capability.token)
				status.textContent = ''
				if (params.get('paid') === '1') return message(labels.paidThanks)
				if (params.get('cancelled') === '1')
					error.textContent = labels.paymentCancelled
				if (balance.status === 'paid') return message(labels.balancePaid)
				if (balance.status === 'void') return message(labels.balanceVoid)
				if (!balance.payable) return message(labels.balanceNone)
				const money = (minor: number) =>
					formatCateringMoney(minor, balance.currency, locale)
				const lines = [
					fillCateringTemplate(labels.balanceOrder, { number: balance.number }),
					fillCateringTemplate(labels.balanceDue, {
						amount: money(balance.owedCents),
					}),
				]
				if (balance.dueAt) {
					lines.push(
						fillCateringTemplate(labels.balanceDueBy, {
							// The due instant is the end of the due day.
							date: new Intl.DateTimeFormat(locale, {
								dateStyle: 'medium',
							}).format(new Date(balance.dueAt - 1)),
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
				const pay = document.createElement('button')
				pay.type = 'button'
				pay.className =
					'h-12 rounded-md bg-primary px-6 text-base font-medium text-primary-foreground'
				pay.textContent = labels.payBalance
				pay.addEventListener('click', async () => {
					error.textContent = ''
					pay.disabled = true
					try {
						const started = await payBalance(capability.id, capability.token)
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
							code === 'invalid_balance_token'
								? labels.quoteGone
								: code === 'balance_already_paid'
									? labels.balancePaid
									: labels.errGeneric
						pay.disabled = false
					}
				})
				body.replaceChildren(summary, pay)
			} catch (caught) {
				status.textContent = ''
				const code = caught instanceof CateringClientError ? caught.code : ''
				message(
					code === 'catering_unavailable'
						? labels.unavailable
						: labels.quoteGone,
				)
			}
		})()
	}
}
