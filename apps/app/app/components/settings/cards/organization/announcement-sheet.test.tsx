// @vitest-environment jsdom

import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { type SiteContentLocale } from '@repo/common/site-locales'
import { TooltipProvider } from '@repo/ui/tooltip'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { beforeEach, describe, expect, it } from 'vitest'
import { LocaleContext } from '#app/components/website/locale-fields.tsx'
import { TranslateProvider } from '#app/components/website/translate-provider.tsx'
import { AnnouncementSheet, isSafeAnnouncementLink } from './announcement-sheet'

beforeEach(() => {
	i18n.load('en', {})
	i18n.activate('en')
})

function renderSheet(locales: SiteContentLocale[]) {
	const router = createMemoryRouter([
		{
			path: '/',
			element: (
				<LocaleContext.Provider
					value={{
						activeLocale: 'en',
						defaultLocale: 'en',
						locales,
						setActiveLocale: () => {},
					}}
				>
					<TranslateProvider activeLocale="en" defaultLocale="en">
						<AnnouncementSheet
							open
							onOpenChange={() => {}}
							organizationId="org-1"
							localesConfig={{ locales, defaultLocale: 'en' }}
						/>
					</TranslateProvider>
				</LocaleContext.Provider>
			),
		},
	])
	return render(
		<I18nProvider i18n={i18n}>
			<TooltipProvider>
				<RouterProvider router={router} />
			</TooltipProvider>
		</I18nProvider>,
	)
}

describe('AnnouncementSheet', () => {
	it('does not mention switching locales on a single-locale site', async () => {
		renderSheet(['en'])

		expect(
			await screen.findByText(
				'Enabled banners appear at the top of your public site.',
			),
		).toBeInTheDocument()
		expect(screen.queryByText(/switch locales/i)).not.toBeInTheDocument()
		expect(
			screen.queryByText('Default language required'),
		).not.toBeInTheDocument()
		expect(
			screen.queryByRole('radiogroup', { name: 'Content language' }),
		).not.toBeInTheDocument()
	})

	it('explains translating when the site has several locales', async () => {
		renderSheet(['en', 'ar'])

		expect(await screen.findByText(/switch locales/i)).toBeInTheDocument()
		expect(screen.getByText('Default language required')).toBeInTheDocument()
		expect(
			screen.getByRole('radiogroup', { name: 'Content language' }),
		).toBeInTheDocument()
	})

	it('marks the empty content textarea invalid on submit', async () => {
		const user = userEvent.setup()
		renderSheet(['en'])

		const content = await screen.findByLabelText('Content')
		expect(content).not.toHaveAttribute('aria-invalid')

		await user.click(screen.getByRole('button', { name: 'Add announcement' }))

		expect(content).toHaveAttribute('aria-invalid', 'true')
		const describedBy = content.getAttribute('aria-describedby')
		expect(describedBy).toBeTruthy()
		expect(document.getElementById(describedBy!)).toHaveTextContent(
			/content is required/i,
		)
	})
})

describe('isSafeAnnouncementLink', () => {
	it('accepts http(s) URLs and site paths', () => {
		for (const v of ['https://example.com/a', 'http://example.com', '/pricing'])
			expect(isSafeAnnouncementLink(v)).toBe(true)
	})

	it('rejects script and other schemes, and protocol-relative URLs', () => {
		for (const v of [
			'javascript:alert(1)',
			' JavaScript:alert(1)',
			'data:text/html,hi',
			'//evil.com',
			'/\\evil.com',
			'example.com',
		])
			expect(isSafeAnnouncementLink(v)).toBe(false)
	})
})
