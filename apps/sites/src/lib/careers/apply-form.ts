/**
 * The careers application form, in the visitor's browser. It posts straight to
 * the organization's regional node (`data-tenant-api-url`): a name, phone number
 * or email never passes through this site's server. Which organization it is for
 * is decided by the node from the page's own address; the slug or host sent along
 * only matters for local development.
 *
 * Kept as a module (not an inline script) so it can be tested against a real DOM.
 */

export type ApplyMessages = {
	sending: string
	submit: string
	success: string
	checkAnswers: string
	required: string
	badEmail: string
	badPhone: string
	contact: string
	consent: string
	verify: string
	verifyFailed: string
	closed: string
	tooMany: string
	unavailable: string
	network: string
}

export type ApplyFormDeps = {
	fetchImpl?: typeof fetch
	/** The page's query string, for `?src=`. */
	search?: string
	/** Resets the human check after a failed try. */
	resetChallenge?: () => void
}

type Problem = { questionId?: string }
type Issue = { path?: string }

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** `?src=qr` and `?src=share` say where a visitor came from. */
export function applicationSource(search: string): string {
	const src = new URLSearchParams(search).get('src')
	return src === 'qr' ? 'qr' : src === 'share' ? 'share_link' : 'careers_page'
}

export function initApplyForm(
	form: HTMLFormElement,
	deps: ApplyFormDeps = {},
): void {
	const fetchImpl = deps.fetchImpl ?? ((...args) => fetch(...args))
	const messages = JSON.parse(form.dataset.messages || '{}') as ApplyMessages
	const successClass = form.dataset.successClass || ''
	const errorClass = form.dataset.errorClass || ''
	const status = form.querySelector<HTMLElement>('[data-apply-status]')
	const button = form.querySelector<HTMLButtonElement>('button[type="submit"]')
	if (!status || !button) return
	const source = applicationSource(deps.search ?? '')

	// Matched by comparing, not by building a selector: question ids are the
	// posting's own and are never trusted to be selector-safe.
	const errorFor = (name: string) =>
		Array.from(form.querySelectorAll<HTMLElement>('[data-error-for]')).find(
			(node) => node.dataset.errorFor === name,
		) ?? null

	function clearErrors() {
		form.querySelectorAll<HTMLElement>('[data-error-for]').forEach((node) => {
			node.textContent = ''
			node.classList.add('hidden')
		})
		form
			.querySelectorAll('[aria-invalid]')
			.forEach((node) => node.removeAttribute('aria-invalid'))
	}

	function fieldError(name: string, message: string): boolean {
		const node = errorFor(name)
		if (!node) return false
		node.textContent = message
		node.classList.remove('hidden')
		const control = form.elements.namedItem(name)
		const first =
			control instanceof RadioNodeList ? (control[0] as Element) : control
		if (first instanceof HTMLElement) first.setAttribute('aria-invalid', 'true')
		return true
	}

	function show(kind: 'ok' | 'error', text: string) {
		status!.textContent = text
		status!.className = kind === 'ok' ? successClass : errorClass
		status!.focus()
	}

	function collect() {
		const data = new FormData(form)
		const answers: Record<string, string> = {}
		form.querySelectorAll('[data-question]').forEach((node) => {
			const id = node.getAttribute('data-question')!
			const value = String(data.get(`q:${id}`) || '').trim()
			if (value !== '') answers[id] = value
		})
		const text = (key: string) => String(data.get(key) || '').trim()
		return {
			slug: form.dataset.orgSlug || undefined,
			host: form.dataset.customHost || undefined,
			postingSlug: form.dataset.postingSlug,
			firstName: text('firstName'),
			lastName: text('lastName'),
			email: text('email') || undefined,
			phone: text('phone') || undefined,
			locale: form.dataset.locale || 'en',
			answers,
			source,
			consent: data.get('consent') === 'on',
			consentVersion: form.dataset.consentVersion,
			website: text('website'),
			turnstileToken: text('cf-turnstile-response') || undefined,
		}
	}

	// Cheap checks first, so a person is told what is missing without a round trip.
	function validate(body: ReturnType<typeof collect>): boolean {
		let ok = true
		const fail = (name: string, message: string) => {
			fieldError(name, message)
			ok = false
		}
		if (!body.firstName) fail('firstName', messages.required)
		if (!body.lastName) fail('lastName', messages.required)
		if (!body.email && !body.phone) {
			fail('email', messages.contact)
		} else if (body.email && !EMAIL.test(body.email)) {
			fail('email', messages.badEmail)
		}
		form.querySelectorAll('[data-question]').forEach((node) => {
			const id = node.getAttribute('data-question')!
			const textarea = node.querySelector('textarea')
			const needs =
				node.getAttribute('data-kind') === 'yes_no' || textarea?.required
			if (needs && !body.answers[id]) fail(`q:${id}`, messages.required)
		})
		if (!body.consent) fail('consent', messages.consent)
		if (form.dataset.turnstile && !body.turnstileToken) {
			status!.textContent = messages.verify
			status!.className = errorClass
			ok = false
		}
		return ok
	}

	form.addEventListener('submit', async (event) => {
		event.preventDefault()
		if (button.disabled) return
		clearErrors()
		status.className = 'hidden'
		const body = collect()
		if (!validate(body)) {
			const firstInvalid = form.querySelector<HTMLElement>(
				'[aria-invalid="true"]',
			)
			if (firstInvalid) firstInvalid.focus()
			else if (!status.classList.contains('hidden')) status.focus()
			return
		}
		button.disabled = true
		button.textContent = messages.sending
		let sent = false
		try {
			const response = await fetchImpl(
				`${form.dataset.tenantApiUrl}/careers/apply`,
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(body),
				},
			)
			const result = (await response.json().catch(() => ({}))) as {
				error?: string
				problems?: Problem[]
				issues?: Issue[]
			}
			if (response.ok) {
				sent = true
				form.reset()
				clearErrors()
				show('ok', messages.success)
				form
					.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
						'input, textarea',
					)
					.forEach((node) => (node.disabled = true))
				button.classList.add('hidden')
				return
			}
			if (response.status === 400) {
				let marked = false
				for (const problem of result.problems ?? []) {
					if (problem.questionId) {
						marked =
							fieldError(`q:${problem.questionId}`, messages.required) || marked
					}
				}
				for (const issue of result.issues ?? []) {
					const path = String(issue.path ?? '')
					if (path === 'phone') {
						marked = fieldError('phone', messages.badPhone) || marked
					} else if (path === 'email') {
						marked = fieldError('email', messages.badEmail) || marked
					} else if (path === 'consent' || path === 'consentVersion') {
						marked = fieldError('consent', messages.consent) || marked
					} else if (path === 'firstName' || path === 'lastName') {
						marked = fieldError(path, messages.required) || marked
					}
				}
				show('error', messages.checkAnswers)
				const firstInvalid = form.querySelector<HTMLElement>(
					'[aria-invalid="true"]',
				)
				if (marked && firstInvalid) firstInvalid.focus()
			} else if (response.status === 403) {
				show('error', messages.verifyFailed)
			} else if (response.status === 404) {
				show('error', messages.closed)
			} else if (response.status === 429) {
				show('error', messages.tooMany)
			} else {
				show('error', messages.unavailable)
			}
			deps.resetChallenge?.()
		} catch {
			show('error', messages.network)
			deps.resetChallenge?.()
		} finally {
			if (!sent) {
				button.disabled = false
				button.textContent = messages.submit
			}
		}
	})
}
