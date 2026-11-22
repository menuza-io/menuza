import { lowestAvailablePrice } from './catalog.ts'
import { decorateDishPhoto } from './dish-photo.ts'
import { el } from './dom.ts'
import { fillTemplate } from './money.ts'
import { type OrderingItem } from './types.ts'
import { upsellNeedsChoices } from './upsell.ts'

export type UpsellRowLabels = {
	heading: string
	add: string
	/** "Add {name}": the button's accessible name. */
	addNamed: string
}

/**
 * The "Goes well with" row: a photo, name, price and an Add button per
 * dish. Null when there is nothing to suggest, so the row is simply absent.
 * Built with text nodes only: dish names and descriptions are never parsed as
 * HTML.
 */
export function buildUpsellRow(options: {
	items: readonly OrderingItem[]
	labels: UpsellRowLabels
	formatMoney: (amount: number) => string
	/** Tapped Add: add the dish, or open its modal when it needs choices. */
	onAdd: (item: OrderingItem, opener: HTMLElement) => void
	/** `cart` or `checkout`, for tests and styling hooks. */
	place: 'cart' | 'checkout'
}): HTMLElement | null {
	if (options.items.length === 0) return null
	const section = el('section', 'border-t border-border px-5 py-4')
	section.dataset.upsellRow = options.place
	const headingId = `upsell-heading-${options.place}`
	const heading = el(
		'h3',
		'mb-3 text-sm font-semibold text-foreground',
		options.labels.heading,
	)
	heading.id = headingId
	section.setAttribute('aria-labelledby', headingId)
	const list = el('ul', 'flex flex-col gap-3')
	for (const item of options.items) {
		const row = el('li', 'flex items-center gap-3')
		row.dataset.upsellItem = item.id
		if (item.imageUrl) {
			const photo = document.createElement('img')
			photo.src = item.imageUrl
			// Decorative: the name next to it says what it is.
			photo.alt = ''
			photo.loading = 'lazy'
			photo.className = 'size-12 shrink-0 rounded-lg object-cover'
			decorateDishPhoto(photo, {
				itemId: item.id,
				focal: item.imageFocal,
				test: item.photoTest,
			})
			row.appendChild(photo)
		}
		const text = el('div', 'min-w-0 flex-1')
		text.appendChild(
			el('p', 'truncate text-sm font-medium text-foreground', item.displayName),
		)
		text.appendChild(
			el(
				'p',
				'price text-sm text-muted-foreground',
				options.formatMoney(lowestAvailablePrice(item)),
			),
		)
		row.appendChild(text)
		const button = el('button', 'btn-secondary shrink-0', options.labels.add)
		button.type = 'button'
		button.setAttribute(
			'aria-label',
			fillTemplate(options.labels.addNamed, { name: item.displayName }),
		)
		if (upsellNeedsChoices(item)) button.dataset.opensModal = 'true'
		button.addEventListener('click', () => options.onAdd(item, button))
		row.appendChild(button)
		list.appendChild(row)
	}
	section.append(heading, list)
	return section
}
