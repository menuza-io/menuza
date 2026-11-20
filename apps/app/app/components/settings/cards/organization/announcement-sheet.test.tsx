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
import {
	AnnouncementSheet,
	AnnouncementSchema,
	isSafeAnnouncementLink,
	type AnnouncementRecord,
} from './announcement-sheet'

beforeEach(() => {
	i18n.load('en', {})
	i18n.activate('en')
})

function renderSheet(
	locales: SiteContentLocale[],
	extra: Partial<React.ComponentProps<typeof AnnouncementSheet>> = {},
) {
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
							timeZone="America/New_York"
							{...extra}
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

const ended: AnnouncementRecord = {
	id: 'a1',
	content: { en: 'Closed for Eid' },
	type: 'info',
	isEnabled: true,
	linkUrl: null,
	linkLabel: {},
	linkNewTab: true,
	position: 1,
	startsAt: '2026-03-08T14:00:00.000Z',
	endsAt: '2026-03-08T22:00:00.000Z',
	status: 'ended',
	createdAt: '2026-03-01T00:00:00.000Z',
	updatedAt: '2026-03-01T00:00:00.000Z',
}

describe('AnnouncementSheet show window (#238)', () => {
	it('shows "Show from" and "Until I turn it off" for a new announcement', async () => {
		renderSheet(['en'])
		expect(await screen.findByLabelText('Show from')).toHaveValue('')
		expect(
			screen.getByRole('checkbox', { name: 'Until I turn it off' }),
		).toBeChecked()
		expect(screen.queryByLabelText('Show until')).not.toBeInTheDocument()
		expect(
			screen.getByText(
				/Times are in your site's time zone \(America\/New_York\)/,
			),
		).toBeInTheDocument()
	})

	it('shows the stored window in the site time zone and the end field when set', async () => {
		renderSheet(['en'], { announcement: ended })
		// 14:00Z and 22:00Z on 8 March 2026 are 10:00 and 18:00 in New York (EDT).
		expect(await screen.findByLabelText('Show from')).toHaveValue(
			'2026-03-08T10:00',
		)
		expect(screen.getByLabelText('Show until')).toHaveValue('2026-03-08T18:00')
		expect(
			screen.getByRole('checkbox', { name: 'Until I turn it off' }),
		).not.toBeChecked()
	})

	it('reusing an ended announcement keeps the text and clears the window', async () => {
		renderSheet(['en'], { announcement: ended, asNew: true })
		expect(await screen.findByText('New announcement')).toBeInTheDocument()
		expect(screen.getByLabelText('Show from')).toHaveValue('')
		expect(
			screen.getByRole('checkbox', { name: 'Until I turn it off' }),
		).toBeChecked()
		expect(screen.getByDisplayValue('Closed for Eid')).toBeInTheDocument()
	})

	it('reveals "Show until" when "Until I turn it off" is unchecked', async () => {
		renderSheet(['en'])
		await userEvent.click(
			await screen.findByRole('checkbox', { name: 'Until I turn it off' }),
		)
		expect(await screen.findByLabelText('Show until')).toBeInTheDocument()
	})
})

describe('AnnouncementSchema window (#238)', () => {
	const base = {
		contentJson: JSON.stringify({ en: 'Hi' }),
		defaultLocale: 'en',
		type: 'info',
	}
	it('accepts no dates, from only, and a valid window', () => {
		for (const dates of [
			{},
			{ startsAtLocal: '2026-03-08T10:00' },
			{ startsAtLocal: '2026-03-08T10:00', endsAtLocal: '2026-03-09T10:00' },
			{ startsAtLocal: '', endsAtLocal: '' },
		]) {
			expect(AnnouncementSchema.safeParse({ ...base, ...dates }).success).toBe(
				true,
			)
		}
	})
	it('refuses "until" at or before "from" and malformed values', () => {
		expect(
			AnnouncementSchema.safeParse({
				...base,
				startsAtLocal: '2026-03-08T10:00',
				endsAtLocal: '2026-03-08T10:00',
			}).success,
		).toBe(false)
		expect(
			AnnouncementSchema.safeParse({
				...base,
				startsAtLocal: '2026-03-08T10:00',
				endsAtLocal: '2026-03-07T10:00',
			}).success,
		).toBe(false)
		expect(
			AnnouncementSchema.safeParse({ ...base, startsAtLocal: 'tomorrow' })
				.success,
		).toBe(false)
	})
})
