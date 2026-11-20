import { type PublicFormField } from '@repo/common/public-form'
import {
	buildFormPayload,
	choiceAnswersFrom,
	visibleFieldIds,
	type FormLocation,
} from './website-form-fields'

/** The field definitions and offered locations the server rendered with the form. */
function formMeta(formElement: HTMLFormElement) {
	try {
		const fields = JSON.parse(
			formElement.dataset.fields || '[]',
		) as PublicFormField[]
		const offered = JSON.parse(formElement.dataset.offered || '{}') as Record<
			string,
			FormLocation[]
		>
		return Array.isArray(fields) && fields.length > 0
			? { fields, offered }
			: null
	} catch {
		return null
	}
}

/**
 * Shows or hides conditional fields for the answers so far (#357). A hidden
 * field's inputs are disabled, so it is never validated or submitted.
 */
export function applyFieldConditions(formElement: HTMLFormElement) {
	const meta = formMeta(formElement)
	if (!meta) return
	const data = new FormData(formElement)
	const answers = choiceAnswersFrom(meta.fields, (name) => {
		const value = data.get(name)
		return typeof value === 'string' ? value : undefined
	})
	const visible = visibleFieldIds(meta.fields, answers)
	for (const wrapper of formElement.querySelectorAll<HTMLElement>(
		'[data-field-id]',
	)) {
		const show = visible.has(wrapper.dataset.fieldId || '')
		wrapper.hidden = !show
		for (const control of wrapper.querySelectorAll<
			HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
		>('input, select, textarea')) {
			control.disabled = !show
		}
	}
}

function className(form: HTMLFormElement, key: string, fallback: string) {
	return form.dataset[key] || fallback
}

/** The values (and location names) the browser sends: visible fields only. */
function submissionBody(formElement: HTMLFormElement, formData: FormData) {
	const meta = formMeta(formElement)
	if (!meta) {
		return {
			values: Object.fromEntries(
				Array.from(new Set(formData.keys())).map((key) => {
					const values = formData.getAll(key).map(String)
					return [key, values.length > 1 ? values : values[0] || '']
				}),
			),
		}
	}
	const payload = buildFormPayload(meta.fields, {
		getAll: (name) => formData.getAll(name).map(String),
		offered: meta.offered,
	})
	return {
		values: payload.values,
		locationLabels: payload.locationLabels,
		unavailableFields: payload.unavailableFields,
	}
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
					...submissionBody(formElement, formData),
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
		formElement.addEventListener('change', () =>
			applyFieldConditions(formElement),
		)
		formElement.addEventListener('reset', () => {
			// After the reset has cleared the answers.
			setTimeout(() => applyFieldConditions(formElement), 0)
		})
		applyFieldConditions(formElement)
	}
	if (!listening) {
		listening = true
		document.addEventListener('sites:content-updated', () => {
			initWebsiteForms()
		})
	}
}
