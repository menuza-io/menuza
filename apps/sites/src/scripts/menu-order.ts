import { getAccessToken, tenantFetch } from '~/lib/client-auth'

type CartLine = {
	menuItemId?: string
	name: string
	quantity: number
	unitPriceCents: number
}

const root = document.getElementById('menu-order-root')
const cartLinesEl = document.getElementById('menu-cart-lines')
const cartTotalEl = document.getElementById('menu-cart-total')
const placeBtn = document.getElementById(
	'menu-place-order',
) as HTMLButtonElement | null
const messageEl = document.getElementById('menu-order-message')

const cart: CartLine[] = []

function formatMoney(cents: number) {
	return new Intl.NumberFormat(undefined, {
		style: 'currency',
		currency: 'USD',
	}).format(cents / 100)
}

function renderCart() {
	if (!cartLinesEl || !cartTotalEl || !placeBtn) return
	cartLinesEl.innerHTML = ''
	let total = 0
	for (const line of cart) {
		total += line.unitPriceCents * line.quantity
		const li = document.createElement('li')
		li.textContent = `${line.quantity}× ${line.name} — ${formatMoney(line.unitPriceCents * line.quantity)}`
		cartLinesEl.appendChild(li)
	}
	cartTotalEl.textContent = total > 0 ? `Total: ${formatMoney(total)}` : ''
	placeBtn.disabled = cart.length === 0
}

function addLine(line: CartLine) {
	const existing = cart.find(
		(entry) => entry.menuItemId === line.menuItemId && entry.name === line.name,
	)
	if (existing) {
		existing.quantity += 1
	} else {
		cart.push({ ...line, quantity: 1 })
	}
	renderCart()
}

document.querySelectorAll('[data-menu-item]').forEach((row) => {
	const el = row as HTMLElement
	const btn = el.querySelector('.menu-add-btn')
	btn?.addEventListener('click', () => {
		addLine({
			menuItemId: el.dataset.itemId,
			name: el.dataset.itemName || 'Item',
			unitPriceCents: Number(el.dataset.itemPrice || 0),
		})
	})
})

placeBtn?.addEventListener('click', async () => {
	if (!root || cart.length === 0) return
	const token = getAccessToken()
	if (!token) {
		if (messageEl) {
			messageEl.textContent = root.dataset.signInRequired || 'Sign in required'
		}
		window.location.href = '/login?redirect=/order'
		return
	}

	const locationId = root.dataset.locationId
	if (!locationId) {
		if (messageEl) messageEl.textContent = 'Location unavailable'
		return
	}

	placeBtn.disabled = true
	try {
		const response = await tenantFetch('/shop/food-orders', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				locationId,
				fulfillmentType: 'pickup',
				items: cart.map((line) => ({
					menuItemId: line.menuItemId,
					name: line.name,
					quantity: line.quantity,
					unitPriceCents: line.unitPriceCents,
				})),
			}),
		})
		if (!response.ok) {
			const err = (await response.json().catch(() => ({}))) as {
				error?: string
			}
			throw new Error(err.error || 'Unable to place order')
		}
		cart.length = 0
		renderCart()
		if (messageEl) {
			messageEl.textContent = 'Order placed! Payment checkout is coming soon.'
		}
	} catch (error) {
		if (messageEl) {
			messageEl.textContent =
				error instanceof Error ? error.message : 'Unable to place order'
		}
	} finally {
		placeBtn.disabled = cart.length === 0
	}
})

renderCart()
