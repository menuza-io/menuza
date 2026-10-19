// @vitest-environment jsdom
import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { describe, expect, it } from 'vitest'
import {
	LocalizedMapField,
	ReservationLocaleProvider,
	ReservationLocaleSwitcher,
} from '#app/components/reservations/localized-fields.tsx'
import { type LocalizedMap } from '#app/utils/reservations/localized.ts'
import { RESERVATIONS_LAYOUT_ROUTE_ID } from '#app/utils/reservations/use-reservation-locales.ts'

function Harness({ initial }: { initial: LocalizedMap }) {
	const [value, setValue] = useState(initial)
	return (
		<ReservationLocaleProvider>
			<ReservationLocaleSwitcher />
			<LocalizedMapField
				label="Name"
				value={value}
				onChange={setValue}
				data-testid="field"
			/>
			<output data-testid="json">{JSON.stringify(value)}</output>
		</ReservationLocaleProvider>
	)
}

function renderWith(
	languages: { locales: string[]; defaultLocale: string } | null,
	initial: LocalizedMap,
) {
	i18n.load('en', {})
	i18n.activate('en')
	const router = createMemoryRouter([
		{
			id: RESERVATIONS_LAYOUT_ROUTE_ID,
			path: '/',
			HydrateFallback: () => null,
			loader: () => (languages ? { siteLocales: languages } : null),
			children: [{ index: true, element: <Harness initial={initial} /> }],
		},
	])
	render(
		<I18nProvider i18n={i18n}>
			<RouterProvider router={router} />
		</I18nProvider>,
	)
}

const field = () => screen.getByTestId('field') as HTMLInputElement
const json = () =>
	JSON.parse(screen.getByTestId('json').textContent ?? '{}') as LocalizedMap

describe('LocalizedMapField', () => {
	it('is one plain input with no switcher for a one-language organization', async () => {
		renderWith({ locales: ['en'], defaultLocale: 'en' }, { en: 'Patio' })
		await screen.findByTestId('field')
		expect(screen.queryByRole('radiogroup')).toBeNull()
		expect(field().value).toBe('Patio')
		fireEvent.change(field(), { target: { value: 'Terrace' } })
		expect(json()).toEqual({ en: 'Terrace' })
	})

	it('uses the platform default language outside the reservations layout', async () => {
		renderWith(null, { en: 'Patio' })
		await screen.findByTestId('field')
		expect(screen.queryByRole('radiogroup')).toBeNull()
	})

	it('starts on the default language and edits the active language', async () => {
		renderWith(
			{ locales: ['ar', 'en', 'fr'], defaultLocale: 'ar' },
			{ ar: 'الشرفة' },
		)
		await screen.findByTestId('field')
		// The default (Arabic here) is first and active, whatever the interface language.
		expect(screen.getAllByRole('radio').map((r) => r.textContent)).toEqual([
			'ar',
			'en',
			'fr',
		])
		expect(field().value).toBe('الشرفة')
		expect(field().getAttribute('dir')).toBe('rtl')

		fireEvent.click(screen.getByRole('radio', { name: 'French' }))
		// Another language starts empty and shows the default text as its hint.
		expect(field().value).toBe('')
		expect(field().placeholder).toBe('الشرفة')
		expect(field().getAttribute('dir')).toBe('ltr')
		fireEvent.change(field(), { target: { value: 'Terrasse' } })
		expect(json()).toEqual({ ar: 'الشرفة', fr: 'Terrasse' })

		fireEvent.click(screen.getByRole('radio', { name: 'Arabic' }))
		expect(field().value).toBe('الشرفة')
	})

	it('offers exactly the enabled languages', async () => {
		renderWith({ locales: ['de', 'zh'], defaultLocale: 'de' }, {})
		await screen.findByTestId('field')
		expect(screen.getAllByRole('radio').map((r) => r.textContent)).toEqual([
			'de',
			'zh',
		])
	})
})
