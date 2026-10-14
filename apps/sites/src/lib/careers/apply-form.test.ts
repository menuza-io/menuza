// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applicationSource, initApplyForm } from './apply-form.ts'

const MESSAGES = {
	sending: 'Sending...',
	submit: 'Send application',
	success: 'Thank you.',
	checkAnswers: 'Check the answers.',
	required: 'Required.',
	chooseLocation: 'Pick a place.',
	badEmail: 'Bad email.',
	badPhone: 'Bad phone.',
	contact: 'Need contact.',
	consent: 'Need consent.',
	verify: 'Verify first.',
	verifyFailed: 'Verification failed.',
	closed: 'Closed.',
	tooMany: 'Too many.',
	unavailable: 'Unavailable.',
	network: 'Offline.',
}

function mount(options: { turnstile?: boolean; picker?: boolean } = {}) {
	document.body.innerHTML = `
	<form data-apply-form data-tenant-api-url="https://us.tenant.test"
		data-posting-slug="line-cook" data-org-slug="acme" data-locale="en"
		data-consent-version="2026-10" data-success-class="ok" data-error-class="bad"
		${options.turnstile ? 'data-turnstile="on"' : ''}
		data-messages='${JSON.stringify(MESSAGES)}' novalidate>
		<input name="website" />
		${
			options.picker
				? '<fieldset data-locations><input type="checkbox" name="scopeIds" value="loc1" /><input type="checkbox" name="scopeIds" value="loc2" /><p class="hidden" data-error-for="scopeIds"></p></fieldset>'
				: ''
		}
		<input name="firstName" /><p class="hidden" data-error-for="firstName"></p>
		<input name="lastName" /><p class="hidden" data-error-for="lastName"></p>
		<input name="email" /><p class="hidden" data-error-for="email"></p>
		<input name="phone" /><p class="hidden" data-error-for="phone"></p>
		<fieldset data-question="weekends" data-kind="yes_no">
			<input type="radio" name="q:weekends" value="yes" />
			<input type="radio" name="q:weekends" value="no" />
			<p class="hidden" data-error-for="q:weekends"></p>
		</fieldset>
		<div data-question="about" data-kind="open">
			<textarea name="q:about"></textarea><p class="hidden" data-error-for="q:about"></p>
		</div>
		<input type="checkbox" name="consent" /><p class="hidden" data-error-for="consent"></p>
		<input name="cf-turnstile-response" />
		<p data-apply-status class="hidden" tabindex="-1"></p>
		<button type="submit">Send application</button>
	</form>`
	return document.querySelector('form')!
}

function fill(form: HTMLFormElement, values: Record<string, string | boolean>) {
	for (const [name, value] of Object.entries(values)) {
		const controls = form.querySelectorAll<HTMLInputElement>(`[name="${name}"]`)
		controls.forEach((control) => {
			if (control.type === 'radio') control.checked = control.value === value
			else if (control.type === 'checkbox') control.checked = value === true
			else control.value = String(value)
		})
	}
}

const GOOD = {
	firstName: 'Sara',
	lastName: 'Ali',
	email: 'sara@example.com',
	'q:weekends': 'yes',
	'q:about': 'Two years on the grill',
	consent: true,
}

function submit(form: HTMLFormElement) {
	form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }))
	return new Promise((resolve) => setTimeout(resolve, 0))
}

let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
	fetchMock = vi.fn(async () =>
		Response.json({ received: true }, { status: 201 }),
	)
})
afterEach(() => {
	document.body.innerHTML = ''
})

describe('applicationSource', () => {
	it('reads where a visitor came from, from a fixed list', () => {
		expect(applicationSource('?src=qr')).toBe('qr')
		expect(applicationSource('?src=share')).toBe('share_link')
		expect(applicationSource('?src=newsletter')).toBe('careers_page')
		expect(applicationSource('')).toBe('careers_page')
	})
})

describe('the application form', () => {
	it('posts straight to the regional node with the consent version and where they came from', async () => {
		const form = mount()
		initApplyForm(form, { fetchImpl: fetchMock as never, search: '?src=qr' })
		fill(form, GOOD)
		await submit(form)
		expect(fetchMock).toHaveBeenCalledTimes(1)
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
		expect(url).toBe('https://us.tenant.test/careers/apply')
		expect(init.method).toBe('POST')
		expect(JSON.parse(String(init.body))).toEqual({
			slug: 'acme',
			postingSlug: 'line-cook',
			firstName: 'Sara',
			lastName: 'Ali',
			email: 'sara@example.com',
			locale: 'en',
			answers: { weekends: 'yes', about: 'Two years on the grill' },
			source: 'qr',
			consent: true,
			consentVersion: '2026-10',
			website: '',
		})
		const status = form.querySelector('[data-apply-status]')!
		expect(status.textContent).toBe('Thank you.')
		expect(status.className).toBe('ok')
	})

	it('thanks the applicant, locks the form, and cannot be sent twice', async () => {
		const form = mount()
		initApplyForm(form, { fetchImpl: fetchMock as never })
		fill(form, GOOD)
		await submit(form)
		const button = form.querySelector('button')!
		expect(button.classList.contains('hidden')).toBe(true)
		expect(
			form.querySelector<HTMLInputElement>('[name="firstName"]')!.disabled,
		).toBe(true)
		await submit(form)
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})

	it('tells a person what is missing before sending anything', async () => {
		const form = mount()
		initApplyForm(form, { fetchImpl: fetchMock as never })
		await submit(form)
		expect(fetchMock).not.toHaveBeenCalled()
		const errorFor = (name: string) =>
			form.querySelector(`[data-error-for="${name}"]`)!
		expect(errorFor('firstName').textContent).toBe('Required.')
		expect(errorFor('lastName').textContent).toBe('Required.')
		expect(errorFor('email').textContent).toBe('Need contact.')
		expect(errorFor('q:weekends').textContent).toBe('Required.')
		expect(errorFor('consent').textContent).toBe('Need consent.')
		// An optional question is not required.
		expect(errorFor('q:about').textContent).toBe('')
		expect(
			form.querySelector('[name="firstName"]')!.getAttribute('aria-invalid'),
		).toBe('true')
		expect(form.querySelector('[name="firstName"]')).toHaveFocus()
	})

	it('accepts a phone instead of an email, and refuses an obviously bad email', async () => {
		const form = mount()
		initApplyForm(form, { fetchImpl: fetchMock as never })
		fill(form, { ...GOOD, email: 'nope' })
		await submit(form)
		expect(form.querySelector('[data-error-for="email"]')!.textContent).toBe(
			'Bad email.',
		)
		expect(fetchMock).not.toHaveBeenCalled()
		fill(form, { ...GOOD, email: '', phone: '+14155550123' })
		await submit(form)
		expect(fetchMock).toHaveBeenCalledTimes(1)
		const body = JSON.parse(
			String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body),
		)
		expect(body.email).toBeUndefined()
		expect(body.phone).toBe('+14155550123')
	})

	it('needs the human check when one is on the page', async () => {
		const form = mount({ turnstile: true })
		initApplyForm(form, { fetchImpl: fetchMock as never })
		fill(form, GOOD)
		await submit(form)
		expect(fetchMock).not.toHaveBeenCalled()
		const status = form.querySelector('[data-apply-status]')!
		expect(status.textContent).toBe('Verify first.')
		fill(form, { 'cf-turnstile-response': 'token' })
		await submit(form)
		expect(
			JSON.parse(
				String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body),
			).turnstileToken,
		).toBe('token')
	})

	it('marks the fields the server objects to, and resets the check', async () => {
		fetchMock.mockResolvedValue(
			Response.json(
				{
					error: 'invalid_answers',
					problems: [{ questionId: 'weekends', code: 'missing' }],
				},
				{ status: 400 },
			),
		)
		const reset = vi.fn()
		const form = mount()
		initApplyForm(form, {
			fetchImpl: fetchMock as never,
			resetChallenge: reset,
		})
		fill(form, GOOD)
		await submit(form)
		expect(
			form.querySelector('[data-error-for="q:weekends"]')!.textContent,
		).toBe('Required.')
		expect(form.querySelector('[data-apply-status]')!.textContent).toBe(
			'Check the answers.',
		)
		expect(reset).toHaveBeenCalled()
		// The form stays usable and the button comes back.
		expect(form.querySelector('button')!.disabled).toBe(false)
		expect(form.querySelector('button')!.textContent).toBe('Send application')
	})

	it('maps a server phone problem to the phone field', async () => {
		fetchMock.mockResolvedValue(
			Response.json(
				{
					error: 'Invalid request',
					issues: [{ path: 'phone', code: 'custom' }],
				},
				{ status: 400 },
			),
		)
		const form = mount()
		initApplyForm(form, { fetchImpl: fetchMock as never })
		fill(form, { ...GOOD, phone: '0512345678' })
		await submit(form)
		expect(form.querySelector('[data-error-for="phone"]')!.textContent).toBe(
			'Bad phone.',
		)
	})

	it.each([
		[403, 'Verification failed.'],
		[404, 'Closed.'],
		[429, 'Too many.'],
		[503, 'Unavailable.'],
		[500, 'Unavailable.'],
	])('answers %s in plain words', async (statusCode, text) => {
		fetchMock.mockResolvedValue(
			Response.json({ error: 'x' }, { status: statusCode }),
		)
		const form = mount()
		initApplyForm(form, { fetchImpl: fetchMock as never })
		fill(form, GOOD)
		await submit(form)
		const status = form.querySelector('[data-apply-status]')!
		expect(status.textContent).toBe(text)
		expect(status.className).toBe('bad')
		expect(form.querySelector('button')!.disabled).toBe(false)
	})

	it('says so when the network fails, and lets them try again', async () => {
		fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
		const form = mount()
		initApplyForm(form, { fetchImpl: fetchMock as never })
		fill(form, GOOD)
		await submit(form)
		expect(form.querySelector('[data-apply-status]')!.textContent).toBe(
			'Offline.',
		)
		expect(form.querySelector('button')!.disabled).toBe(false)
	})

	it('sends the honeypot as it finds it, so the server can ignore a bot', async () => {
		const form = mount()
		initApplyForm(form, { fetchImpl: fetchMock as never })
		fill(form, { ...GOOD, website: 'https://spam.example' })
		await submit(form)
		expect(
			JSON.parse(
				String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body),
			).website,
		).toBe('https://spam.example')
	})

	it('puts nothing the visitor typed into the page as markup', async () => {
		const form = mount()
		initApplyForm(form, { fetchImpl: fetchMock as never })
		fill(form, { ...GOOD, firstName: '<img src=x onerror=alert(1)>' })
		await submit(form)
		expect(document.querySelector('img')).toBeNull()
	})

	it('needs at least one location when the job is at several, and sends every one chosen', async () => {
		const form = mount({ picker: true })
		initApplyForm(form, { fetchImpl: fetchMock as never })
		fill(form, GOOD)
		await submit(form)
		// Nothing leaves the browser without a place.
		expect(fetchMock).not.toHaveBeenCalled()
		expect(form.querySelector('[data-error-for="scopeIds"]')?.textContent).toBe(
			'Pick a place.',
		)

		form
			.querySelectorAll<HTMLInputElement>('[name="scopeIds"]')
			.forEach((box) => (box.checked = true))
		await submit(form)
		expect(fetchMock).toHaveBeenCalledTimes(1)
		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
		expect(JSON.parse(String(init.body)).scopeIds).toEqual(['loc1', 'loc2'])
	})

	it("marks the locations when the server says one is not the job's", async () => {
		fetchMock.mockResolvedValueOnce(
			Response.json({ error: 'invalid_scope' }, { status: 400 }),
		)
		const form = mount({ picker: true })
		initApplyForm(form, { fetchImpl: fetchMock as never })
		fill(form, GOOD)
		form.querySelector<HTMLInputElement>('[value="loc1"]')!.checked = true
		await submit(form)
		expect(form.querySelector('[data-error-for="scopeIds"]')?.textContent).toBe(
			'Pick a place.',
		)
	})
})
