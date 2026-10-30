import {
	redirectToLogin,
	setSessionTokens,
	tenantFetch,
} from '~/lib/client-auth'

type ShopOrderRow = {
	productName?: string
	status?: string
	createdAt?: string
	amount?: string
}

type SavedPaymentMethodRow = {
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

function renderOrderHistory(
	orderHistory: HTMLElement,
	noOrders: string,
	orders: ShopOrderRow[],
) {
	orderHistory.replaceChildren()
	if (orders.length === 0) {
		const empty = document.createElement('li')
		empty.className = 'px-4 py-6 text-center text-sm text-muted-foreground'
		empty.textContent = noOrders
		orderHistory.appendChild(empty)
		return
	}
	for (const order of orders) {
		const item = document.createElement('li')
		item.className =
			'flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm'

		const details = document.createElement('div')
		const name = document.createElement('p')
		name.className = 'font-medium text-foreground'
		name.textContent = String(order.productName ?? '')
		const meta = document.createElement('p')
		meta.className = 'text-muted-foreground'
		meta.textContent = `${order.status} · ${formatOrderDate(order.createdAt)}`
		details.append(name, meta)

		const amount = document.createElement('p')
		amount.className = 'font-medium text-foreground'
		amount.textContent = String(order.amount ?? '')

		item.append(details, amount)
		orderHistory.appendChild(item)
	}
}

function renderPaymentMethods(
	paymentMethodsList: HTMLElement,
	noPaymentMethods: string,
	expiresLabel: string,
	methods: SavedPaymentMethodRow[],
) {
	paymentMethodsList.replaceChildren()
	if (methods.length === 0) {
		const empty = document.createElement('li')
		empty.className = 'px-4 py-6 text-center text-sm text-muted-foreground'
		empty.textContent = noPaymentMethods
		paymentMethodsList.appendChild(empty)
		return
	}
	for (const method of methods) {
		const item = document.createElement('li')
		item.className =
			'flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm'

		const label = document.createElement('p')
		label.className = 'font-medium text-foreground'
		label.textContent = `${formatBrand(method.brand)} •••• ${method.last4}`

		const expiry = document.createElement('p')
		expiry.className = 'text-muted-foreground'
		expiry.textContent = `${expiresLabel} ${String(method.expMonth).padStart(2, '0')}/${String(method.expYear).slice(-2)}`

		item.append(label, expiry)
		paymentMethodsList.appendChild(item)
	}
}

async function loadShopAccountData(options: {
	orderHistory: HTMLElement | null
	paymentMethodsList: HTMLElement | null
	noOrders: string
	noPaymentMethods: string
	expiresLabel: string
}) {
	const {
		orderHistory,
		paymentMethodsList,
		noOrders,
		noPaymentMethods,
		expiresLabel,
	} = options

	try {
		const [orders, methods] = await Promise.all([
			tenantFetch('/shop/orders'),
			tenantFetch('/shop/payment-methods'),
		])

		if (orders.session === 'signed_out' || methods.session === 'signed_out') {
			redirectToLogin()
			return
		}
		// A session that could not be checked for now leaves a list as it is.
		const ordersRes = orders.session === 'ok' ? orders.response : null
		const methodsRes = methods.session === 'ok' ? methods.response : null

		if (ordersRes?.ok && orderHistory) {
			const data = (await ordersRes.json()) as { orders?: ShopOrderRow[] }
			const orders = Array.isArray(data.orders) ? data.orders : []
			renderOrderHistory(orderHistory, noOrders, orders)
		}

		if (methodsRes?.ok && paymentMethodsList) {
			const data = (await methodsRes.json()) as {
				paymentMethods?: SavedPaymentMethodRow[]
			}
			const methods = Array.isArray(data.paymentMethods)
				? data.paymentMethods
				: []
			renderPaymentMethods(
				paymentMethodsList,
				noPaymentMethods,
				expiresLabel,
				methods,
			)
		}
	} catch (error) {
		console.error('Failed to load shop account data:', error)
	}
}

async function loadProfile(options: {
	nameInput: HTMLElement | null
	emailInput: HTMLElement | null
	phoneInput: HTMLElement | null
	onTransient: () => void
}) {
	const { nameInput, emailInput, phoneInput, onTransient } = options

	try {
		const { session, response: res } = await tenantFetch('/auth/me')
		if (session === 'signed_out') {
			redirectToLogin()
			return
		}
		if (session === 'transient') {
			onTransient()
			return
		}
		if (res.ok) {
			const data = (await res.json()) as {
				customer?: { name?: string; email?: string; phone?: string }
			}
			if (data.customer) {
				if (data.customer.name && nameInput instanceof HTMLInputElement) {
					nameInput.value = data.customer.name
				}
				if (data.customer.email && emailInput instanceof HTMLInputElement) {
					emailInput.value = data.customer.email
				}
				if (data.customer.phone && phoneInput instanceof HTMLInputElement) {
					phoneInput.value = data.customer.phone
				}
			}
		}
	} catch (err) {
		console.error('Failed to load profile:', err)
	}
}

export function initProfilePage() {
	const pageRoot = document.getElementById('profile-page-root')
	const noOrders = pageRoot?.dataset.noOrders || 'No orders yet.'
	const noPaymentMethods =
		pageRoot?.dataset.noPaymentMethods || 'No saved payment methods yet.'
	const expiresLabel = pageRoot?.dataset.expires || 'Expires'

	const form = document.getElementById('profile-form')
	const errorMessage = document.getElementById('error-message')
	const successMessage = document.getElementById('success-message')
	const submitButton = document.getElementById('submit-button')
	const nameInput = document.getElementById('name')
	const emailInput = document.getElementById('email')
	const phoneInput = document.getElementById('phone')
	const orderHistory = document.getElementById('order-history')
	const paymentMethodsList = document.getElementById('payment-methods')
	const saveLabel = form?.dataset.save || 'Save Changes'
	const savingLabel = form?.dataset.saving || 'Saving...'
	const errorLabel = form?.dataset.error || 'Something went wrong.'
	const networkLabel =
		form?.dataset.network || 'Network error. Please try again.'

	const showError = (message: string) => {
		if (!errorMessage) return
		errorMessage.textContent = message
		errorMessage.classList.remove('hidden')
	}

	void loadProfile({
		nameInput,
		emailInput,
		phoneInput,
		onTransient: () => showError(networkLabel),
	})
	void loadShopAccountData({
		orderHistory,
		paymentMethodsList,
		noOrders,
		noPaymentMethods,
		expiresLabel,
	})

	form?.addEventListener('submit', async (e) => {
		e.preventDefault()
		if (
			!(form instanceof HTMLFormElement) ||
			!(submitButton instanceof HTMLButtonElement)
		) {
			return
		}

		const formData = new FormData(form)
		const name = formData.get('name')?.toString() || ''
		const email = formData.get('email')?.toString() || ''

		errorMessage?.classList.add('hidden')
		successMessage?.classList.add('hidden')

		submitButton.disabled = true
		submitButton.textContent = savingLabel

		try {
			const { session, response: res } = await tenantFetch('/auth/profile', {
				method: 'POST',
				body: JSON.stringify({ name, email }),
			})
			if (session === 'signed_out') {
				redirectToLogin()
				return
			}
			if (session === 'transient') {
				showError(networkLabel)
				return
			}
			const data = (await res.json()) as {
				accessToken?: string
				refreshToken?: string
				error?: string
			}

			if (res.ok) {
				setSessionTokens({
					accessToken:
						typeof data.accessToken === 'string' ? data.accessToken : undefined,
					refreshToken:
						typeof data.refreshToken === 'string'
							? data.refreshToken
							: undefined,
				})
				successMessage?.classList.remove('hidden')
			} else {
				showError(data.error || errorLabel)
			}
		} catch {
			showError(networkLabel)
		} finally {
			submitButton.disabled = false
			submitButton.textContent = saveLabel
		}
	})
}

if (document.getElementById('profile-page-root')) {
	initProfilePage()
}
