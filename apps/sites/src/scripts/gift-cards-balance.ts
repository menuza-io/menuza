import { checkBalance, GiftCardClientError } from '~/lib/gift-cards/client'
import { fillGiftCardTemplate, readGiftCardLabels } from '~/lib/gift-cards/read-labels'
import { browserLocale } from '~/lib/locale'
import { createChallenge } from '~/lib/reservations/ui'

/**
 * The balance page: a card number and a human check, then the balance, with
 * the reason when it is 0 (not activated, voided, expired) and "being
 * prepared" (not an error) while a risky purchase is held.
 */

const root = document.getElementById('gift-card-balance-root')
const labels = readGiftCardLabels()

if (root) {
	const form = root.querySelector<HTMLFormElement>('form')!
	const input = root.querySelector<HTMLInputElement>('input[name="code"]')!
	const result = root.querySelector<HTMLElement>('[data-gc-result]')!
	const error = root.querySelector<HTMLElement>('[data-gc-error]')!
	const button = root.querySelector<HTMLButtonElement>('button[type="submit"]')!
	const challenge = createChallenge(
		root.querySelector<HTMLElement>('[data-gc-challenge]')!,
		root.dataset.turnstileSiteKey ?? '',
	)

	form.addEventListener('submit', async (event) => {
		event.preventDefault()
		error.textContent = ''
		result.textContent = ''
		button.disabled = true
		try {
			const view = await checkBalance(input.value.trim(), challenge.token())
			const lines: string[] = [fillGiftCardTemplate(labels.endingIn, { last4: view.last4 })]
			if (view.note === 'being_prepared') lines.push(labels.statusPreparing)
			else if (view.status === 'inactive') lines.push(labels.statusInactive)
			else if (view.status === 'voided') lines.push(labels.statusVoided)
			else if (view.status === 'expired') lines.push(labels.statusExpired)
			else {
				lines.push(
					fillGiftCardTemplate(labels.balanceIs, {
						amount: new Intl.NumberFormat(browserLocale(), {
							style: 'currency',
							currency: view.currency,
						}).format(view.balanceMinor / 100),
					}),
				)
				if (view.expiresAt) {
					lines.push(
						fillGiftCardTemplate(labels.validUntil, {
							date: new Intl.DateTimeFormat(browserLocale(), { dateStyle: 'medium' }).format(view.expiresAt),
						}),
					)
				}
			}
			result.replaceChildren(
				...lines.map((line) => {
					const paragraph = document.createElement('p')
					paragraph.textContent = line
					return paragraph
				}),
			)
		} catch (caught) {
			const code = caught instanceof GiftCardClientError ? caught.code : ''
			error.textContent =
				code === 'code_invalid'
					? labels.errorNotFound
					: code === 'rate_limited'
						? labels.errorRate
						: code === 'verification_failed'
							? labels.errorVerify
							: labels.errorGeneric
		} finally {
			button.disabled = false
			challenge.reset()
		}
	})
}
