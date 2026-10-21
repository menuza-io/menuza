// @vitest-environment jsdom
import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { type ReactElement } from 'react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeSettingsResponse } from '#app/utils/reservations/messages-fixtures.ts'
import {
	ReservationsApiError,
	type ReservationsScopedClient,
} from '#app/utils/reservations/reservations-client.ts'
import { MessageSettingsScreen } from './message-settings.tsx'

const languages = vi.hoisted(() => ({
	locales: ['en', 'ar'] as string[],
	defaultLocale: 'en',
}))
vi.mock('#app/utils/reservations/use-reservation-locales.ts', () => ({
	useReservationLocales: () => languages,
}))

/** The translate helper behind the language switcher needs a data router. */
function renderStaff(ui: ReactElement) {
	i18n.load('en', {})
	i18n.activate('en')
	const router = createMemoryRouter([{ path: '/', element: ui }])
	return render(
		<I18nProvider i18n={i18n}>
			<RouterProvider router={router} />
		</I18nProvider>,
	)
}

const PATH = '/operator/reservations/setup/message-texts'

type Call = {
	path: string
	options: {
		method?: string
		query?: Record<string, string>
		body?: Record<string, unknown>
	}
}

function previewBody(kind: string, locale: string) {
	return {
		ok: true,
		sample: true,
		kind,
		locale,
		subject: `Subject ${kind} ${locale}`,
		html: `<p>Sample ${kind} ${locale}</p>`,
		text: 'text',
		sms: `SMS ${kind}`,
	}
}

function setup(
	options: {
		canWrite?: boolean
		waitlistEnabled?: boolean
		dataRegion?: 'us' | 'ksa'
		onPut?: (call: Call) => unknown
	} = {},
) {
	const calls: Call[] = []
	const request = vi.fn(async (path: string, opts: Call['options'] = {}) => {
		calls.push({ path, options: opts })
		if (path === `${PATH}/preview`) {
			return previewBody(opts.query!.kind!, opts.query!.locale!)
		}
		if (opts.method === 'PUT') {
			return options.onPut?.({ path, options: opts })
		}
		return makeSettingsResponse()
	})
	const client = {
		scope: 'setup',
		request,
	} as unknown as ReservationsScopedClient
	renderStaff(
		<MessageSettingsScreen
			client={client}
			locationId="loc_1"
			canWrite={options.canWrite ?? true}
			waitlistEnabled={options.waitlistEnabled ?? false}
			dataRegion={options.dataRegion ?? 'us'}
		/>,
	)
	return { calls, request }
}

function input(testId: string) {
	return screen.getByTestId(testId) as HTMLInputElement
}

describe('MessageSettingsScreen', () => {
	beforeEach(() => {
		vi.restoreAllMocks()
		languages.locales = ['en', 'ar']
		languages.defaultLocale = 'en'
	})

	const pickLanguage = (name: string) =>
		fireEvent.click(screen.getByRole('radio', { name }))

	it('shows the saved values', async () => {
		setup()
		await screen.findByTestId('message-kinds-card')

		expect(
			screen
				.getByTestId('message-kind-switch-confirmation')
				.getAttribute('aria-checked'),
		).toBe('true')
		expect(
			screen
				.getByTestId('message-kind-switch-reconfirm_request')
				.getAttribute('aria-checked'),
		).toBe('false')
		expect(input('message-reminder-hours').value).toBe('24')
		expect(input('message-reconfirm-hours').value).toBe('48')
		expect(input('message-quiet-start').value).toBe('21:00')
		expect(input('message-quiet-end').value).toBe('08:00')
		expect(
			screen.getByTestId('message-sms-switch').getAttribute('aria-checked'),
		).toBe('true')
		expect(input('message-note-confirmation').value).toBe('See you soon')
		// Another language starts empty; the default text is its placeholder.
		pickLanguage('Arabic')
		expect(input('message-note-confirmation').value).toBe('')
		expect(input('message-note-confirmation').placeholder).toBe('See you soon')
		expect(screen.queryByTestId('message-dirty-badge')).toBeNull()
		// The save bar only appears once something changed.
		expect(screen.queryByTestId('message-save')).toBeNull()
	})

	it('shows one note field per kind and no switcher for a one-language organization', async () => {
		languages.locales = ['en']
		setup()
		await screen.findByTestId('message-kinds-card')
		expect(screen.queryByRole('radiogroup')).toBeNull()
		expect(input('message-note-confirmation').value).toBe('See you soon')
		expect(screen.queryByTestId('message-preview-locale-ar')).toBeNull()
		expect(screen.queryByText(/Arabic/)).toBeNull()
	})

	it('offers every language of the organization, not a fixed pair', async () => {
		languages.locales = ['es', 'fr', 'zh']
		languages.defaultLocale = 'es'
		const { calls } = setup()
		await screen.findByTestId('message-kinds-card')
		expect(screen.getAllByRole('radio').map((r) => r.textContent)).toEqual([
			'es',
			'fr',
			'zh',
		])
		// The preview starts in the organization default language.
		await screen.findByTestId('message-preview-frame')
		expect(
			calls.find((c) => c.path === `${PATH}/preview`)!.options.query,
		).toEqual({ locationId: 'loc_1', kind: 'confirmation', locale: 'es' })
		pickLanguage('French')
		fireEvent.change(input('message-note-reminder'), {
			target: { value: 'À bientôt' },
		})
		expect(input('message-note-reminder').value).toBe('À bientôt')
	})

	it('hides waitlist kinds unless the waitlist is on', async () => {
		setup()
		await screen.findByTestId('message-kinds-card')
		expect(screen.queryByTestId('message-kind-row-waitlist_joined')).toBeNull()
		expect(screen.queryByTestId('message-note-row-waitlist_joined')).toBeNull()
	})

	it('shows waitlist kinds when the waitlist is on', async () => {
		setup({ waitlistEnabled: true })
		await screen.findByTestId('message-kind-row-waitlist_joined')
		expect(screen.getByTestId('message-note-row-waitlist_joined')).toBeTruthy()
	})

	it('saves a toggled kind with the expected version', async () => {
		const { calls } = setup({
			onPut: () =>
				makeSettingsResponse({
					version: 4,
					messaging: {
						...(makeSettingsResponse().messaging as object),
						kinds: { confirmation: true, reminder: false },
					},
					kinds: (makeSettingsResponse().kinds as Array<{ kind: string }>).map(
						(k) => (k.kind === 'reminder' ? { ...k, enabled: false } : k),
					),
				}),
		})
		await screen.findByTestId('message-kinds-card')

		fireEvent.click(screen.getByTestId('message-kind-switch-reminder'))
		expect(await screen.findByTestId('message-dirty-badge')).toBeTruthy()
		fireEvent.click(screen.getByTestId('message-save'))

		await screen.findByTestId('message-saved')
		const put = calls.find((c) => c.options.method === 'PUT')!
		expect(put.options.body).toEqual({
			locationId: 'loc_1',
			expectedVersion: 3,
			messaging: { kinds: { reminder: false } },
		})
		expect(screen.queryByTestId('message-dirty-badge')).toBeNull()
		expect(
			screen
				.getByTestId('message-kind-switch-reminder')
				.getAttribute('aria-checked'),
		).toBe('false')
	})

	it('saves hours and a custom note', async () => {
		const { calls } = setup({
			onPut: () => makeSettingsResponse({ version: 4 }),
		})
		await screen.findByTestId('message-kinds-card')

		fireEvent.change(input('message-reminder-hours'), {
			target: { value: '12' },
		})
		pickLanguage('Arabic')
		fireEvent.change(input('message-note-reminder'), {
			target: { value: 'نراكم قريبا' },
		})
		fireEvent.click(screen.getByTestId('message-save'))

		await screen.findByTestId('message-saved')
		expect(calls.find((c) => c.options.method === 'PUT')!.options.body).toEqual(
			{
				locationId: 'loc_1',
				expectedVersion: 3,
				messaging: { reminderHours: 12 },
				texts: [{ kind: 'reminder', locale: 'ar', customNote: 'نراكم قريبا' }],
			},
		)
	})

	it('blocks saving invalid hours', async () => {
		setup()
		await screen.findByTestId('message-kinds-card')
		fireEvent.change(input('message-reminder-hours'), {
			target: { value: '0' },
		})
		expect(screen.getByTestId('message-save')).toBeDisabled()
		expect(
			screen.getByText(/Enter a whole number of hours from 1 to 168/),
		).toBeTruthy()
	})

	it('reloads on a 409, explains it and keeps the unsaved edits', async () => {
		const newer = makeSettingsResponse({
			version: 9,
			messaging: {
				...(makeSettingsResponse().messaging as object),
				reminderHours: 6,
			},
		})
		const { calls } = setup({
			onPut: () => {
				throw new ReservationsApiError('stale_version', 409, {
					error: 'stale_version',
					current: newer,
					settings: newer,
					version: 9,
				})
			},
		})
		await screen.findByTestId('message-kinds-card')

		fireEvent.click(screen.getByTestId('message-kind-switch-reminder'))
		fireEvent.click(screen.getByTestId('message-save'))

		await screen.findByTestId('message-conflict')
		expect(screen.getByTestId('message-conflict').textContent).toMatch(
			/latest version is loaded and your edits are kept/,
		)
		expect(input('message-reminder-hours').value).toBe('6')
		expect(
			screen
				.getByTestId('message-kind-switch-reminder')
				.getAttribute('aria-checked'),
		).toBe('false')
		expect(screen.getByTestId('message-dirty-badge')).toBeTruthy()

		// The next save carries the version that was just loaded and only our edit.
		calls.length = 0
		fireEvent.click(screen.getByTestId('message-save'))
		await waitFor(() =>
			expect(calls.some((c) => c.options.method === 'PUT')).toBe(true),
		)
		expect(calls.find((c) => c.options.method === 'PUT')!.options.body).toEqual(
			{
				locationId: 'loc_1',
				expectedVersion: 9,
				messaging: { kinds: { reminder: false } },
			},
		)
	})

	it('keeps the draft and shows the error when a save fails', async () => {
		setup({
			onPut: () => {
				throw new ReservationsApiError('Boom', 500, { message: 'Boom' })
			},
		})
		await screen.findByTestId('message-kinds-card')
		fireEvent.click(screen.getByTestId('message-kind-switch-reminder'))
		fireEvent.click(screen.getByTestId('message-save'))

		expect((await screen.findByTestId('message-error')).textContent).toBe(
			'Boom',
		)
		expect(screen.getByTestId('message-dirty-badge')).toBeTruthy()
		expect(
			screen
				.getByTestId('message-kind-switch-reminder')
				.getAttribute('aria-checked'),
		).toBe('false')
	})

	it('requests a preview and shows it in a sandboxed frame', async () => {
		const { calls } = setup()
		const frame = (await screen.findByTestId(
			'message-preview-frame',
		)) as HTMLIFrameElement
		expect(frame.getAttribute('sandbox')).toBe('')
		expect(frame.getAttribute('srcdoc')).toBe('<p>Sample confirmation en</p>')
		expect(screen.getByTestId('message-preview-subject').textContent).toBe(
			'Subject confirmation en',
		)
		expect(screen.getByTestId('message-preview-sms').textContent).toBe(
			'SMS confirmation',
		)
		expect(
			calls.find((c) => c.path === `${PATH}/preview`)!.options.query,
		).toEqual({ locationId: 'loc_1', kind: 'confirmation', locale: 'en' })

		fireEvent.click(screen.getByTestId('message-preview-pick-reminder'))
		fireEvent.click(screen.getByTestId('message-preview-locale-ar'))
		await waitFor(() =>
			expect(
				screen.getByTestId('message-preview-frame').getAttribute('srcdoc'),
			).toBe('<p>Sample reminder ar</p>'),
		)
		expect(
			calls.filter((c) => c.path === `${PATH}/preview`).at(-1)!.options.query,
		).toEqual({ locationId: 'loc_1', kind: 'reminder', locale: 'ar' })
	})

	it('always opens the preview when Preview is clicked, even for the kind already shown and with empty notes', async () => {
		setup()
		await screen.findByTestId('message-preview-frame')
		const card = screen.getByTestId('message-preview-card')
		const scroll = vi.fn()
		card.scrollIntoView = scroll
		fireEvent.click(screen.getByTestId('message-preview-pick-confirmation'))
		expect(scroll).toHaveBeenCalled()
		expect(card).toHaveFocus()
		expect(
			screen.getByTestId('message-preview-note-status').textContent,
		).toMatch(/custom note/)
		// Arabic has no saved note in the fixture: the default text is marked as such.
		fireEvent.click(screen.getByTestId('message-preview-locale-ar'))
		expect(
			screen.getByTestId('message-preview-note-status').textContent,
		).toMatch(/^No custom note/)
	})

	it('retries a failed preview', async () => {
		let fail = true
		const request = vi.fn(async (path: string) => {
			if (path.endsWith('/preview')) {
				if (fail)
					throw new ReservationsApiError('No preview', 500, {
						message: 'No preview',
					})
				return {
					kind: 'confirmation',
					locale: 'en',
					subject: 'S',
					html: '<p>ok</p>',
					sms: null,
				}
			}
			return makeSettingsResponse()
		})
		renderStaff(
			<MessageSettingsScreen
				client={
					{ scope: 'setup', request } as unknown as ReservationsScopedClient
				}
				locationId="loc_1"
				canWrite
				waitlistEnabled={false}
				dataRegion="us"
			/>,
		)
		fireEvent.click(await screen.findByTestId('message-preview-retry'))
		fail = false
		await waitFor(() =>
			expect(
				screen.getByTestId('message-preview-frame').getAttribute('srcdoc'),
			).toBe('<p>ok</p>'),
		)
	})

	it('shows a preview error without breaking the screen', async () => {
		const request = vi.fn(async (path: string) => {
			if (path.endsWith('/preview')) {
				throw new ReservationsApiError('No preview', 500, {
					message: 'No preview',
				})
			}
			return makeSettingsResponse()
		})
		renderStaff(
			<MessageSettingsScreen
				client={
					{ scope: 'setup', request } as unknown as ReservationsScopedClient
				}
				locationId="loc_1"
				canWrite
				waitlistEnabled={false}
				dataRegion="us"
			/>,
		)
		expect(
			(await screen.findByTestId('message-preview-error')).textContent,
		).toContain('No preview')
		expect(screen.getByTestId('message-preview-retry')).toBeTruthy()
		expect(screen.getByTestId('message-kinds-card')).toBeTruthy()
	})

	it('is read-only without write access', async () => {
		setup({ canWrite: false })
		await screen.findByTestId('message-kinds-card')
		expect(screen.queryByTestId('message-save')).toBeNull()
		expect(input('message-reminder-hours').disabled).toBe(true)
		expect(input('message-note-confirmation').disabled).toBe(true)
		expect(
			screen
				.getByTestId('message-kind-switch-reminder')
				.hasAttribute('data-disabled'),
		).toBe(true)
	})

	it('explains that Saudi Arabia locations receive email only', async () => {
		setup({ dataRegion: 'ksa' })
		await screen.findByTestId('message-delivery-card')
		expect(screen.getByTestId('message-sms-note').textContent).toMatch(
			/email only/,
		)
		expect(
			screen.getByTestId('message-sms-switch').hasAttribute('data-disabled'),
		).toBe(true)
	})

	it('offers a retry when the settings cannot be loaded', async () => {
		const request = vi.fn(async () => {
			throw new ReservationsApiError('Down', 503, { message: 'Down' })
		})
		renderStaff(
			<MessageSettingsScreen
				client={
					{ scope: 'setup', request } as unknown as ReservationsScopedClient
				}
				locationId="loc_1"
				canWrite
				waitlistEnabled={false}
				dataRegion="us"
			/>,
		)
		expect(
			(await screen.findByTestId('message-settings-load-error')).textContent,
		).toContain('could not be loaded') // plain copy, never the server text
	})
})
