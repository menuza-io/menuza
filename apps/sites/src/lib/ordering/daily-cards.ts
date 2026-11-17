import { dailyView, type DailyAvailability } from './daily-availability.ts'
import { fillTemplate } from './money.ts'

/**
 * Paints today's daily-limit state (#409) on the menu cards. The markup of a
 * dish with no published sell-out always carries a hidden sold-out badge and
 * a hidden "Only N left" badge; this only toggles them and the card around
 * them, so it can run again with a newer answer and give a dish back when a
 * manager tops it up. A dish the menu itself marks sold out is left alone.
 */

const LIVE_CARD = ['surface', 'surface-interactive', 'cursor-pointer']
const SOLD_CARD = ['border-dashed', 'border-border', 'bg-muted/40']

export function paintDailyCards(
	root: ParentNode,
	availability: DailyAvailability,
	labels: { onlyNLeft: string },
): void {
	const cards = root.querySelectorAll<HTMLElement>(
		'.js-item-card, .js-popular-card',
	)
	for (const card of cards) {
		const id = card.dataset.itemId
		if (!id) continue
		// What the page was published as, remembered before the first paint.
		card.dataset.publishedSoldOut ??=
			card.dataset.soldOut ??
			(card instanceof HTMLButtonElement && card.disabled ? 'true' : 'false')
		if (card.dataset.publishedSoldOut === 'true') continue

		const view = dailyView(availability, 'item', id)
		const soldOut = view?.soldOut === true
		const left = view && !view.soldOut ? view.left : null

		card.dataset.soldOut = soldOut ? 'true' : 'false'
		if (soldOut) card.setAttribute('aria-disabled', 'true')
		else card.removeAttribute('aria-disabled')
		if (card instanceof HTMLButtonElement) {
			// The popular rail's cards are the button themselves.
			card.disabled = soldOut
			card.classList.toggle('opacity-70', soldOut)
		} else {
			card.classList.remove(...(soldOut ? LIVE_CARD : SOLD_CARD))
			card.classList.add(...(soldOut ? SOLD_CARD : LIVE_CARD))
			const open = card.querySelector<HTMLButtonElement>('.js-item-open')
			if (open) open.disabled = soldOut
			card
				.querySelector('h3')
				?.classList.toggle('text-muted-foreground', soldOut)
			card.querySelector('h3')?.classList.toggle('text-foreground', !soldOut)
		}
		for (const image of card.querySelectorAll('img')) {
			image.classList.toggle('grayscale', soldOut)
		}
		for (const add of card.querySelectorAll<HTMLElement>('.add-btn')) {
			add.hidden = soldOut
		}
		for (const price of card.querySelectorAll<HTMLElement>('.js-price-block')) {
			price.hidden = soldOut
		}
		for (const badge of card.querySelectorAll<HTMLElement>(
			'.js-sold-out-badge',
		)) {
			badge.hidden = !soldOut
		}
		for (const badge of card.querySelectorAll<HTMLElement>('.js-daily-left')) {
			badge.hidden = left === null
			// Words from a template and a number: never markup.
			badge.textContent =
				left === null ? '' : fillTemplate(labels.onlyNLeft, { count: left })
		}
	}
}
