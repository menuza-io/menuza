import { giftCardCheckoutQuoteSchema, type GiftCardCheckoutQuote } from '@repo/common/gift-card-contract'
import { getAccessToken, getBrowserTenantApiUrl, getOrgBinding } from '~/lib/client-auth'
import { fetchOptions, listMine } from '~/lib/gift-cards/client'
import { fillGiftCardTemplate, type readGiftCardLabels } from '~/lib/gift-cards/read-labels'

/**
 * "Add gift card" on the checkout: a typed number, or a card saved to the
 * guest's account, applied after discounts and loyalty. The browser asks the
 * regional tenant-api for what the card would take (`POST /orders/quote`) and
 * sends the amount it showed with the order; the region compares it and
 * refuses a different one (`gift_card_changed`). The card number lives only in
 * this closure: it is never written to storage, the address or Sites' server.
 */

type Labels = ReturnType<typeof readGiftCardLabels>

export type GiftCardCheckout = {
	/** What the order carries, or null when no card is applied. */
	payload(): { code?: string; savedCardId?: string; expectedAmountMinor: number } | null
	applied(): GiftCardCheckoutQuote | null
	/** Prices the card again against the order as it is now (the cart or tip changed). */
	refresh(): Promise<void>
	/** Re-prices and says whether the amount the guest saw still stands. */
	confirm(): Promise<boolean>
}

export function createGiftCardCheckout(options: {
	mount: HTMLElement
	labels: Labels
	currency: string
	pricedOrder: () => Record<string, unknown> | null
	onChange: () => void
}): GiftCardCheckout {
	const { mount, labels } = options
	let secret: { code?: string; savedCardId?: string } | null = null
	let quote: GiftCardCheckoutQuote | null = null
	let busy = false
	let message = ''
	let enabled = false
	const money = (minor: number) =>
		new Intl.NumberFormat(document.documentElement.lang || undefined, {
			style: 'currency',
			currency: options.currency,
		}).format(minor / 100)

	async function price(
		input: { code?: string; savedCardId?: string },
	): Promise<GiftCardCheckoutQuote> {
		const order = options.pricedOrder()
		if (!order) throw new Error('order_unpriceable')
		const headers: Record<string, string> = { 'Content-Type': 'application/json' }
		const access = getAccessToken()
		if (access) headers.Authorization = `Bearer ${access}`
		const response = await fetch(`${getBrowserTenantApiUrl()}/orders/quote`, {
			method: 'POST',
			headers,
			cache: 'no-store',
			body: JSON.stringify({
				...getOrgBinding(),
				...order,
				giftCard: { ...input, expectedAmountMinor: 0 },
			}),
		})
		const body = (await response.json().catch(() => ({}))) as Record<string, unknown>
		if (!response.ok) {
			const code = typeof body.error === 'string' ? body.error : 'request_failed'
			throw new Error(code)
		}
		return giftCardCheckoutQuoteSchema.parse(body.giftCard)
	}

	function errorText(code: string): string {
		if (code === 'gift_card_balance_low') return labels.giftCardLowBalance
		if (code === 'gift_card_changed') return labels.giftCardChanged
		return labels.giftCardInvalid
	}

	function render() {
		mount.replaceChildren()
		mount.hidden = !enabled
		if (!enabled) return
		if (quote) {
			const line = document.createElement('p')
			line.className = 'text-sm'
			line.textContent = fillGiftCardTemplate(labels.giftCardApplied, {
				last4: quote.last4,
				amount: money(quote.appliedMinor),
			})
			const rest = document.createElement('p')
			rest.className = 'text-sm font-medium'
			rest.textContent = fillGiftCardTemplate(labels.giftCardRest, { amount: money(quote.dueMinor) })
			const remove = document.createElement('button')
			remove.type = 'button'
			remove.className = 'btn-secondary min-h-10 px-3 text-sm'
			remove.textContent = labels.giftCardRemove
			remove.addEventListener('click', () => {
				secret = null
				quote = null
				message = ''
				render()
				options.onChange()
			})
			mount.append(line, rest, remove)
			return
		}
		const form = document.createElement('div')
		form.className = 'flex flex-col gap-2'
		const label = document.createElement('label')
		label.className = 'text-sm font-medium'
		label.textContent = labels.giftCardCode
		const input = document.createElement('input')
		input.className = 'h-12 w-full rounded-md border border-input bg-background px-3 text-base'
		input.autocomplete = 'off'
		input.autocapitalize = 'characters'
		input.spellcheck = false
		const apply = document.createElement('button')
		apply.type = 'button'
		apply.className = 'btn-secondary min-h-12 px-5'
		apply.textContent = labels.giftCardApply
		apply.disabled = busy
		const note = document.createElement('p')
		note.className = 'text-sm text-destructive'
		note.setAttribute('role', 'alert')
		note.textContent = message
		apply.addEventListener('click', async () => {
			const typed = input.value.trim()
			if (typed.length < 8) return
			busy = true
			apply.disabled = true
			try {
				quote = await price({ code: typed })
				secret = { code: typed }
				message = ''
			} catch (error) {
				message = errorText(error instanceof Error ? error.message : '')
			} finally {
				busy = false
				render()
				options.onChange()
			}
		})
		form.append(label, input, apply, note)
		mount.append(form)
		// Saved cards with a balance are one tap, no typing.
		if (getAccessToken()) {
			void listMine()
				.then((cards) => {
					if (cards === 'signed_out' || quote) return
					const usable = cards.filter((card) => card.status === 'active' && card.balanceMinor > 0)
					for (const card of usable) {
						const use = document.createElement('button')
						use.type = 'button'
						use.className = 'btn-secondary min-h-12 px-4 text-start'
						use.textContent = `${labels.giftCardSaved}: ${fillGiftCardTemplate(labels.endingIn, { last4: card.last4 })} · ${money(card.balanceMinor)}`
						use.addEventListener('click', async () => {
							try {
								quote = await price({ savedCardId: card.id })
								secret = { savedCardId: card.id }
								message = ''
							} catch (error) {
								message = errorText(error instanceof Error ? error.message : '')
							}
							render()
							options.onChange()
						})
						form.append(use)
					}
				})
				.catch(() => undefined)
		}
	}

	async function refresh() {
		if (!secret || !enabled) return
		try {
			quote = await price(secret)
			message = ''
		} catch (error) {
			quote = null
			secret = null
			message = errorText(error instanceof Error ? error.message : '')
		}
		render()
	}

	void fetchOptions().then((found) => {
		enabled = Boolean(found?.enabled)
		render()
	})
	render()

	return {
		payload() {
			if (!secret || !quote) return null
			return { ...secret, expectedAmountMinor: quote.appliedMinor }
		},
		applied: () => quote,
		refresh,
		async confirm() {
			if (!secret) return true
			const before = quote?.appliedMinor ?? 0
			await refresh()
			if (!quote || quote.appliedMinor !== before) {
				options.onChange()
				return false
			}
			return true
		},
	}
}
