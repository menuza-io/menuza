import {
	getAccessToken,
	redirectToLogin,
	setSessionTokens,
	tenantErrorMessage,
	tenantFetch,
} from '~/lib/client-auth'
import { browserLocaleHref } from '~/lib/locale'

export function initCompleteNamePage() {
	if (!getAccessToken()) {
		redirectToLogin()
		return
	}

	const form = document.getElementById(
		'complete-name-form',
	) as HTMLFormElement | null
	const errorMessage = document.getElementById('error-message')
	const submitButton = form?.querySelector<HTMLButtonElement>(
		'button[type="submit"]',
	)
	if (!form || !errorMessage || !submitButton) return
	const continueLabel = form.dataset.continue || 'Continue'
	const savingLabel = form.dataset.saving || 'Saving...'
	const errorLabel = form.dataset.error || 'Something went wrong.'
	const networkLabel = form.dataset.network || 'Network error. Please try again.'

	const showError = (message: string) => {
		errorMessage.textContent = message
		errorMessage.classList.remove('hidden')
	}

	async function skipIfNamed() {
		try {
			const { session, response: res } = await tenantFetch('/auth/me')
			if (session === 'signed_out') {
				redirectToLogin()
				return
			}
			// A session that could not be checked for now: stay on the form.
			if (session === 'transient' || !res.ok) return
			const data = (await res.json()) as {
				customer?: { needsName?: boolean; name?: string }
			}
			if (data.customer && data.customer.needsName !== true) {
				window.location.replace(browserLocaleHref('/'))
			}
		} catch {
			// Stay on the form if profile cannot be loaded
		}
	}

	void skipIfNamed()

	form.addEventListener('submit', async (e) => {
		e.preventDefault()
		errorMessage.classList.add('hidden')
		submitButton.disabled = true
		submitButton.textContent = savingLabel

		const name = new FormData(form).get('name')?.toString().trim() || ''

		try {
			const { session, response: res } = await tenantFetch('/auth/profile', {
				method: 'POST',
				body: JSON.stringify({ name }),
			})
			if (session === 'signed_out') {
				redirectToLogin()
				return
			}
			if (session === 'transient') {
				showError(networkLabel)
				return
			}
			const data = (await res.json().catch(() => ({}))) as Record<
				string,
				unknown
			>
			if (res.ok) {
				setSessionTokens({
					accessToken:
						typeof data.accessToken === 'string' ? data.accessToken : undefined,
					refreshToken:
						typeof data.refreshToken === 'string'
							? data.refreshToken
							: undefined,
				})
				window.location.href = browserLocaleHref('/')
			} else {
				showError(tenantErrorMessage(data, errorLabel))
			}
		} catch {
			showError(networkLabel)
		} finally {
			submitButton.disabled = false
			submitButton.textContent = continueLabel
		}
	})
}

if (document.getElementById('complete-name-form')) {
	initCompleteNamePage()
}
