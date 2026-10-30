import {
	SHOP_HOSTED_EMBED_SDK_URL,
	SHOP_INLINE_CARD_SDK_URL,
} from '@repo/payments/shop/client'
import { getAccessToken, tenantFetchResponse } from '~/lib/client-auth'

type ShopCheckoutRoot = HTMLElement & {
	dataset: DOMStringMap & {
		paymentMode?: string
		shopProcessor?: string
		checkoutUi?: string
		orgSlug?: string
		customHost?: string
		buyNow?: string
		payNow?: string
		processing?: string
		checkoutError?: string
		successPath?: string
		useNewCard?: string
	}
}

type SavedPaymentMethod = {
	id: string
	stripePaymentMethodId: string
	brand: string
	last4: string
	expMonth: number
	expYear: number
	label: string
	expires: string
}

declare global {
	interface Window {
		Stripe?: (key: string) => StripeClient
		PolarEmbedCheckout?: {
			create: (
				url: string,
				theme?: 'auto' | 'dark' | 'light',
			) => Promise<PolarEmbedCheckoutHandle>
		}
	}
}

type PolarEmbedCheckoutHandle = {
	addEventListener: (
		event: 'success' | 'close' | 'confirmed',
		handler: (event: { detail?: { checkoutId?: string } }) => void,
	) => void
}

type StripeClient = {
	elements: () => StripeElements
	confirmCardPayment: (
		clientSecret: string,
		data: {
			payment_method: string | { card: StripeElement }
			return_url?: string
		},
	) => Promise<{
		error?: { message?: string }
		paymentIntent?: { id: string; status: string }
	}>
}

type StripeElements = {
	create: (
		type: 'cardNumber' | 'cardExpiry' | 'cardCvc',
		options?: {
			style?: StripeElementStyle
			placeholder?: string
		},
	) => StripeElement
}

type StripeElement = {
	mount: (selector: string) => void
	on: (event: 'focus' | 'blur', handler: () => void) => void
}

function bindCardFieldFocusRing(element: StripeElement, host: HTMLElement) {
	element.on('focus', () => {
		host.classList.add('is-focused')
	})
	element.on('blur', () => {
		host.classList.remove('is-focused')
	})
}

function buildCheckoutBody(root: ShopCheckoutRoot, embed = false) {
	const body: { slug?: string; host?: string; embed?: boolean } = {}
	if (root.dataset.customHost) body.host = root.dataset.customHost
	else if (root.dataset.orgSlug) body.slug = root.dataset.orgSlug
	if (embed) body.embed = true
	return body
}

function buildCheckoutHeaders() {
	const headers: Record<string, string> = {
		'Content-Type': 'application/json',
		Accept: 'application/json',
	}
	const token = getAccessToken()
	if (token) headers.Authorization = `Bearer ${token}`
	return headers
}

type ShopThemeColors = {
	text: string
	background: string
	placeholder: string
	danger: string
}

type StripeElementStyle = {
	base: Record<string, string | Record<string, string>>
	invalid: Record<string, string>
	complete: Record<string, string>
}

let stripeColorProbe: HTMLDivElement | null = null
let stripeColorCanvas: HTMLCanvasElement | null = null

function getStripeColorProbe() {
	if (!stripeColorProbe) {
		stripeColorProbe = document.createElement('div')
		stripeColorProbe.style.display = 'none'
		document.body.appendChild(stripeColorProbe)
	}
	return stripeColorProbe
}

function isStripeSafeColor(value: string) {
	const color = value.trim()
	if (/^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(color)) return true
	if (/^rgb\(/i.test(color)) return true
	if (/^hsl\(/i.test(color)) return true
	return false
}

/** Stripe.js rejects oklch()/lab(); normalize via canvas to #rrggbb or rgb(). */
function toStripeColor(color: string, fallback: string) {
	const value = color.trim()
	if (value && isStripeSafeColor(value)) return value

	if (!stripeColorCanvas) {
		stripeColorCanvas = document.createElement('canvas')
		stripeColorCanvas.width = 1
		stripeColorCanvas.height = 1
	}

	const ctx = stripeColorCanvas.getContext('2d')
	if (!ctx) {
		return isStripeSafeColor(fallback) ? fallback : '#18181b'
	}

	for (const candidate of [value, fallback]) {
		if (!candidate) continue
		try {
			ctx.fillStyle = '#000000'
			ctx.fillStyle = candidate
			const normalized = ctx.fillStyle
			if (normalized && isStripeSafeColor(normalized)) {
				return normalized
			}
		} catch {
			/* try next candidate */
		}
	}

	return isStripeSafeColor(fallback) ? fallback : '#18181b'
}

function readTailwindColor(
	classes: string,
	property: 'color' | 'backgroundColor',
	fallback: string,
) {
	const probe = getStripeColorProbe()
	probe.className = classes
	const computed = getComputedStyle(probe)[property]
	return toStripeColor(computed || '', fallback)
}

function cssVarAsStripeColor(
	varName: string,
	fallback: string,
	property: 'color' | 'backgroundColor' = 'color',
) {
	const probe = getStripeColorProbe()
	probe.className = ''
	probe.style.color = ''
	probe.style.backgroundColor = ''
	probe.style[property] = `var(${varName}, ${fallback})`
	const computed = getComputedStyle(probe)[property]
	return toStripeColor(computed || '', fallback)
}

function cssVarAsString(varName: string, fallback: string) {
	const value = getComputedStyle(document.documentElement)
		.getPropertyValue(varName)
		.trim()
	return value || fallback
}

function buildShopThemeColors(): ShopThemeColors {
	const isDark =
		document.documentElement.classList.contains('dark') ||
		document.documentElement.dataset.siteTheme === 'dark'

	return {
		text: readTailwindColor(
			'text-foreground',
			'color',
			isDark ? '#fafafa' : '#18181b',
		),
		background: readTailwindColor(
			'bg-background',
			'backgroundColor',
			isDark ? '#09090b' : '#ffffff',
		),
		placeholder: readTailwindColor(
			'text-muted-foreground',
			'color',
			isDark ? '#a1a1aa' : '#71717a',
		),
		danger: cssVarAsStripeColor('--destructive', '#ef4444'),
	}
}

function buildCardElementStyle(colors: ShopThemeColors): StripeElementStyle {
	return {
		base: {
			color: colors.text,
			backgroundColor: colors.background,
			fontSize: '16px',
			fontFamily: cssVarAsString('--font-sans', 'system-ui, sans-serif'),
			'::placeholder': {
				color: colors.placeholder,
			},
		},
		invalid: {
			color: colors.danger,
		},
		complete: {
			color: colors.text,
		},
	}
}

function formatBrand(brand: string) {
	return brand.charAt(0).toUpperCase() + brand.slice(1)
}

async function loadSavedPaymentMethods(): Promise<SavedPaymentMethod[]> {
	if (!getAccessToken()) return []

	try {
		const response = await tenantFetchResponse('/shop/payment-methods')
		if (!response.ok) return []
		const data = await response.json()
		if (!Array.isArray(data.paymentMethods)) return []
		return data.paymentMethods as SavedPaymentMethod[]
	} catch {
		return []
	}
}

function renderSavedPaymentMethods(
	root: ShopCheckoutRoot,
	methods: SavedPaymentMethod[],
	onSelectionChange?: (useNewCard: boolean) => void,
) {
	const host = document.getElementById('shop-saved-payment-methods')
	const optionsHost = document.getElementById('shop-payment-method-options')
	const newCardFields = document.getElementById('shop-new-card-fields')
	if (!host || !optionsHost || !newCardFields || methods.length === 0) return

	const useNewCardLabel = root.dataset.useNewCard || 'Use a new card'
	host.classList.remove('hidden')

	optionsHost.innerHTML = [
		...methods.map((method, index) => {
			const inputId = `shop-payment-method-${method.id}`
			return `
				<label class="shop-payment-option" for="${inputId}">
					<input
						type="radio"
						name="shop-payment-method"
						id="${inputId}"
						value="${method.stripePaymentMethodId}"
						${index === 0 ? 'checked' : ''}
					/>
					<span class="text-foreground">
						${formatBrand(method.brand)} •••• ${method.last4}
						<span class="text-muted-foreground"> · ${method.expires}</span>
					</span>
				</label>
			`
		}),
		`
			<label class="shop-payment-option" for="shop-payment-method-new">
				<input
					type="radio"
					name="shop-payment-method"
					id="shop-payment-method-new"
					value="new"
				/>
				<span class="text-foreground">${useNewCardLabel}</span>
			</label>
		`,
	].join('')

	const syncSelection = () => {
		const useNewCard = isUsingNewCard()
		newCardFields.classList.toggle('hidden', !useNewCard)
		onSelectionChange?.(useNewCard)
	}

	optionsHost
		.querySelectorAll('input[name="shop-payment-method"]')
		.forEach((input) => {
			input.addEventListener('change', syncSelection)
		})

	syncSelection()
}

function getSelectedPaymentMethodId() {
	const selected = document.querySelector<HTMLInputElement>(
		'input[name="shop-payment-method"]:checked',
	)
	if (!selected || selected.value === 'new') return null
	return selected.value
}

function isUsingNewCard() {
	const savedHost = document.getElementById('shop-saved-payment-methods')
	if (!savedHost || savedHost.classList.contains('hidden')) return true
	return getSelectedPaymentMethodId() === null
}

async function loadInlineCardSdk() {
	if (window.Stripe) return window.Stripe

	await new Promise<void>((resolve, reject) => {
		const script = document.createElement('script')
		script.src = SHOP_INLINE_CARD_SDK_URL
		script.async = true
		script.onload = () => resolve()
		script.onerror = () => reject(new Error('Failed to load card checkout SDK'))
		document.head.appendChild(script)
	})

	if (!window.Stripe) {
		throw new Error('Card checkout SDK did not initialize')
	}

	return window.Stripe
}

async function loadHostedEmbedSdk() {
	if (window.PolarEmbedCheckout) return window.PolarEmbedCheckout

	await new Promise<void>((resolve, reject) => {
		const script = document.createElement('script')
		script.src = SHOP_HOSTED_EMBED_SDK_URL
		script.async = true
		script.onload = () => resolve()
		script.onerror = () =>
			reject(new Error('Failed to load hosted checkout embed'))
		document.head.appendChild(script)
	})

	if (!window.PolarEmbedCheckout) {
		throw new Error('Hosted checkout embed did not initialize')
	}

	return window.PolarEmbedCheckout
}

async function startRedirectCheckout(
	root: ShopCheckoutRoot,
	button: HTMLButtonElement,
	embed = false,
) {
	const processing = root.dataset.processing || 'Redirecting…'
	const checkoutError =
		root.dataset.checkoutError || 'Unable to start checkout. Please try again.'
	const buyNow = root.dataset.buyNow || 'Buy now'
	const successPath = root.dataset.successPath || '/shop/success'

	button.setAttribute('disabled', 'true')
	button.textContent = processing

	try {
		const response = await fetch('/api/shop/checkout', {
			method: 'POST',
			headers: buildCheckoutHeaders(),
			body: JSON.stringify(buildCheckoutBody(root, embed)),
		})
		const data = await response.json()
		if (!response.ok || !data.checkoutUrl) {
			throw new Error(data.error || 'checkout failed')
		}

		if (embed && root.dataset.checkoutUi === 'hosted-embed') {
			const HostedEmbedCheckout = await loadHostedEmbedSdk()
			const checkout = await HostedEmbedCheckout.create(
				data.checkoutUrl,
				'auto',
			)
			checkout.addEventListener('success', () => {
				const checkoutId = data.sessionId
					? `?checkout_id=${encodeURIComponent(data.sessionId)}`
					: ''
				window.location.href = `${successPath}${checkoutId}`
			})
			checkout.addEventListener('close', () => {
				button.removeAttribute('disabled')
				button.textContent = buyNow
			})
			return
		}

		window.location.href = data.checkoutUrl
	} catch {
		button.removeAttribute('disabled')
		button.textContent = buyNow
		alert(checkoutError)
	}
}

async function initInlineCheckout(root: ShopCheckoutRoot) {
	const payButton = document.getElementById(
		'shop-pay-btn',
	) as HTMLButtonElement | null
	const errorHost = document.getElementById('shop-payment-error')

	if (!payButton) return

	const checkoutError =
		root.dataset.checkoutError || 'Unable to process payment. Please try again.'
	const payNow = root.dataset.payNow || 'Pay now'
	const processing = root.dataset.processing || 'Processing…'
	const successPath = root.dataset.successPath || '/shop/success'

	payButton.setAttribute('disabled', 'true')
	payButton.textContent = processing

	let clientSecret = ''
	let paymentIntentId = ''

	try {
		const response = await fetch('/api/shop/payment-intent', {
			method: 'POST',
			headers: buildCheckoutHeaders(),
			body: JSON.stringify(buildCheckoutBody(root)),
		})
		const data = await response.json()
		if (!response.ok || !data.clientSecret || !data.publishableKey) {
			throw new Error(data.error || 'payment setup failed')
		}

		clientSecret = data.clientSecret
		paymentIntentId = data.paymentIntentId

		const savedPaymentMethods = await loadSavedPaymentMethods()

		const Stripe = await loadInlineCardSdk()
		const stripe = Stripe(data.publishableKey)
		const elementStyle = buildCardElementStyle(buildShopThemeColors())
		const elements = stripe.elements()
		const cardNumber = elements.create('cardNumber', {
			style: elementStyle,
			placeholder: '1234 1234 1234 1234',
		})
		const cardExpiry = elements.create('cardExpiry', { style: elementStyle })
		const cardCvc = elements.create('cardCvc', { style: elementStyle })
		let cardElementsMounted = false

		const mountCardElements = () => {
			if (cardElementsMounted) return
			cardNumber.mount('#shop-card-number')
			cardExpiry.mount('#shop-card-expiry')
			cardCvc.mount('#shop-card-cvc')
			cardElementsMounted = true
		}

		renderSavedPaymentMethods(root, savedPaymentMethods, (useNewCard) => {
			if (useNewCard) mountCardElements()
		})

		if (isUsingNewCard()) {
			mountCardElements()
		}

		const cardNumberHost = document
			.getElementById('shop-card-number')
			?.closest('.shop-card-field')
		const cardExpiryHost = document
			.getElementById('shop-card-expiry')
			?.closest('.shop-card-field')
		const cardCvcHost = document
			.getElementById('shop-card-cvc')
			?.closest('.shop-card-field')
		if (cardNumberHost instanceof HTMLElement) {
			bindCardFieldFocusRing(cardNumber, cardNumberHost)
		}
		if (cardExpiryHost instanceof HTMLElement) {
			bindCardFieldFocusRing(cardExpiry, cardExpiryHost)
		}
		if (cardCvcHost instanceof HTMLElement) {
			bindCardFieldFocusRing(cardCvc, cardCvcHost)
		}

		payButton.removeAttribute('disabled')
		payButton.textContent = payNow

		payButton.addEventListener('click', async () => {
			payButton.setAttribute('disabled', 'true')
			payButton.textContent = processing
			if (errorHost) errorHost.textContent = ''

			const returnUrl = new URL(successPath, window.location.origin)
			returnUrl.searchParams.set('payment_intent', paymentIntentId)

			const savedPaymentMethodId = getSelectedPaymentMethodId()
			const result = await stripe.confirmCardPayment(
				clientSecret,
				savedPaymentMethodId
					? {
							payment_method: savedPaymentMethodId,
							return_url: returnUrl.toString(),
						}
					: {
							payment_method: { card: cardNumber },
							return_url: returnUrl.toString(),
						},
			)

			if (result.error) {
				if (errorHost) {
					errorHost.textContent = result.error.message || checkoutError
				}
				payButton.removeAttribute('disabled')
				payButton.textContent = payNow
				return
			}

			if (result.paymentIntent?.status === 'succeeded') {
				window.location.href = `${successPath}?payment_intent=${result.paymentIntent.id}`
			}
		})
	} catch (error) {
		if (errorHost) {
			errorHost.textContent =
				error instanceof Error ? error.message : checkoutError
		}
		payButton.textContent = payNow
		payButton.removeAttribute('disabled')
	}
}

function initShopCheckout() {
	const root = document.getElementById(
		'shop-checkout-root',
	) as ShopCheckoutRoot | null
	if (!root || root.dataset.checkoutInitialized === 'true') return
	root.dataset.checkoutInitialized = 'true'

	if (root.dataset.checkoutUi === 'inline-card') {
		void initInlineCheckout(root)
		return
	}

	const button = document.getElementById(
		'shop-buy-btn',
	) as HTMLButtonElement | null
	button?.addEventListener('click', () => {
		if (button) {
			void startRedirectCheckout(
				root,
				button,
				root.dataset.checkoutUi === 'hosted-embed',
			)
		}
	})
}

initShopCheckout()
