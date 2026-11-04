function className(form: HTMLFormElement, key: string, fallback: string) {
	return form.dataset[key] || fallback
}

async function submitWebsiteForm(formElement: HTMLFormElement, event: Event) {
	event.preventDefault()
	const button = formElement.querySelector('button[type="submit"]')
	const status = formElement.querySelector('[data-form-status]')
	if (
		!(button instanceof HTMLButtonElement) ||
		!(status instanceof HTMLElement)
	) {
		return
	}
	const successClass = className(formElement, 'successClass', '')
	const errorClass = className(formElement, 'errorClass', '')
	button.disabled = true
	formElement.setAttribute('aria-busy', 'true')
	button.textContent = formElement.dataset.submittingLabel || 'Submitting...'
	status.textContent = ''
	status.className = 'sr-only'
	const formData = new FormData(formElement)
	const website = String(formData.get('website') || '')
	formData.delete('website')
	const turnstileToken = String(formData.get('cf-turnstile-response') || '')
	formData.delete('cf-turnstile-response')
	if (formElement.dataset.turnstileSiteKey && !turnstileToken) {
		status.textContent =
			formElement.dataset.verificationLabel ||
			'Complete the verification check before submitting.'
		status.className = errorClass
		button.disabled = false
		formElement.setAttribute('aria-busy', 'false')
		button.textContent = formElement.dataset.submitLabel || 'Submit'
		return
	}
	try {
		const response = await fetch(
			`${formElement.dataset.tenantApiUrl}/forms/${formElement.dataset.formId}/submissions`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					slug: formElement.dataset.orgSlug,
					host: formElement.dataset.customHost,
					website,
					turnstileToken: turnstileToken || undefined,
					values: Object.fromEntries(
						Array.from(new Set(formData.keys())).map((key) => {
							const values = formData.getAll(key).map(String)
							return [key, values.length > 1 ? values : values[0] || '']
						}),
					),
				}),
			},
		)
		const result = (await response.json().catch(() => ({}))) as {
			error?: string
			message?: string
		}
		if (!response.ok) {
			throw new Error(
				result.error ||
					formElement.dataset.errorLabel ||
					'Unable to submit the form.',
			)
		}
		formElement.reset()
		const turnstile = (globalThis as { turnstile?: { reset?: () => void } })
			.turnstile
		turnstile?.reset?.()
		status.textContent =
			formElement.dataset.successMessage || result.message || 'Thank you.'
		status.className = successClass
	} catch (error) {
		status.textContent =
			error instanceof Error
				? error.message
				: formElement.dataset.errorLabel || 'Unable to submit the form.'
		status.className = errorClass
		const turnstile = (globalThis as { turnstile?: { reset?: () => void } })
			.turnstile
		turnstile?.reset?.()
	} finally {
		button.disabled = false
		formElement.setAttribute('aria-busy', 'false')
		button.textContent = formElement.dataset.submitLabel || 'Submit'
	}
}

let listening = false

/** Binds every public website form. Safe to call again after a preview refresh. */
export function initWebsiteForms(root: ParentNode = document) {
	for (const formElement of root.querySelectorAll('form[data-form-id]')) {
		if (!(formElement instanceof HTMLFormElement)) continue
		if (formElement.dataset.formBound === '1') continue
		formElement.dataset.formBound = '1'
		formElement.addEventListener('submit', (event) => {
			void submitWebsiteForm(formElement, event)
		})
	}
	if (!listening) {
		listening = true
		document.addEventListener('sites:content-updated', () => {
			initWebsiteForms()
		})
	}
}
