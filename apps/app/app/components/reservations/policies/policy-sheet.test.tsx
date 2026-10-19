// @vitest-environment jsdom
import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { PolicySheet } from '#app/components/reservations/policies/policy-sheet.tsx'
import { RESERVATIONS_LAYOUT_ROUTE_ID } from '#app/utils/reservations/use-reservation-locales.ts'

function setup(
	languages: { locales: string[]; defaultLocale: string },
	onSave = vi.fn(async (_body: unknown) => undefined),
) {
	i18n.load('en', {})
	i18n.activate('en')
	const router = createMemoryRouter([
		{
			id: RESERVATIONS_LAYOUT_ROUTE_ID,
			path: '/',
			HydrateFallback: () => null,
			loader: () => ({ siteLocales: languages }),
			children: [
				{
					index: true,
					element: (
						<PolicySheet
							open
							onClose={() => undefined}
							policy={null}
							currency="USD"
							region="us"
							onSave={onSave}
						/>
					),
				},
			],
		},
	])
	render(
		<I18nProvider i18n={i18n}>
			<RouterProvider router={router} />
		</I18nProvider>,
	)
	return onSave
}

describe('PolicySheet terms languages', () => {
	it('writes the terms in each language of the organization', async () => {
		const onSave = setup({ locales: ['en', 'es'], defaultLocale: 'en' })
		const name = await screen.findByTestId('policy-name')
		fireEvent.change(name, { target: { value: 'Guarantee' } })
		fireEvent.change(screen.getByTestId('policy-amount'), {
			target: { value: '25' },
		})
		fireEvent.change(screen.getByTestId('policy-terms'), {
			target: { value: 'Pay now.' },
		})
		fireEvent.click(screen.getByRole('radio', { name: 'Spanish' }))
		fireEvent.change(screen.getByTestId('policy-terms'), {
			target: { value: 'Pague ahora.' },
		})
		fireEvent.click(screen.getByTestId('policy-save'))
		await waitFor(() => expect(onSave).toHaveBeenCalled())
		expect(onSave.mock.calls[0]![0]).toMatchObject({
			termsI18n: { en: 'Pay now.', es: 'Pague ahora.' },
		})
	})

	it('has no language picker for a one-language organization', async () => {
		setup({ locales: ['en'], defaultLocale: 'en' })
		await screen.findByTestId('policy-name')
		expect(screen.queryByRole('radiogroup')).toBeNull()
		expect(screen.queryByText(/Arabic/)).toBeNull()
	})
})
