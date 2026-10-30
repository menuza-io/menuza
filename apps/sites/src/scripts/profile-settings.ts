import { loadPaymentMethods } from './profile-shop-data'
import {
	redirectToLogin,
	setSessionTokens,
	tenantFetch,
} from '~/lib/client-auth'

async function loadProfile(options: {
	nameInput: HTMLElement | null
	emailInput: HTMLElement | null
	phoneInput: HTMLElement | null
	profileLoading: HTMLElement | null
	form: HTMLElement | null
	onTransient: () => void
}) {
	const { nameInput, emailInput, phoneInput, profileLoading, form } = options

	try {
		const { session, response: res } = await tenantFetch('/auth/me')
		if (session === 'signed_out') {
			redirectToLogin()
			return
		}
		if (session === 'transient') {
			options.onTransient()
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
	} finally {
		profileLoading?.classList.add('hidden')
		form?.classList.remove('hidden')
	}
}

export function initProfileSettingsPage() {
	const pageRoot = document.getElementById('profile-settings-root')
	const noPaymentMethods =
		pageRoot?.dataset.noPaymentMethods || 'No saved payment methods yet.'
	const noPaymentMethodsHint = pageRoot?.dataset.noPaymentMethodsHint
	const expiresLabel = pageRoot?.dataset.expires || 'Expires'

	const form = document.getElementById('profile-form')
	const profileLoading = document.getElementById('profile-loading')
	const errorMessage = document.getElementById('error-message')
	const successMessage = document.getElementById('success-message')
	const submitButton = document.getElementById('submit-button')
	const nameInput = document.getElementById('name')
	const emailInput = document.getElementById('email')
	const phoneInput = document.getElementById('phone')
	const paymentMethodsList = document.getElementById('payment-methods')
	const paymentMethodsLoading = document.getElementById(
		'payment-methods-loading',
	)
	const saveLabel = form?.dataset.save || 'Save Changes'
	const savingLabel = form?.dataset.saving || 'Saving...'
	const errorLabel = form?.dataset.error || 'Something went wrong.'
	const networkLabel =
		form?.dataset.network || 'Network error. Please try again.'

	const showError = (text: string) => {
		if (!errorMessage) return
		const message = errorMessage.querySelector('p')
		if (message) message.textContent = text
		errorMessage.classList.remove('hidden')
	}

	void loadProfile({
		nameInput,
		emailInput,
		phoneInput,
		profileLoading,
		form,
		onTransient: () => showError(networkLabel),
	})
	void loadPaymentMethods({
		paymentMethodsList,
		paymentMethodsLoading,
		noPaymentMethods,
		noPaymentMethodsHint,
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

if (document.getElementById('profile-settings-root')) {
	initProfileSettingsPage()
}
