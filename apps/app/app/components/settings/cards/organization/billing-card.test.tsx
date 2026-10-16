// @vitest-environment jsdom

import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { brand } from '@repo/config/brand'
import { render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { beforeEach, describe, expect, it } from 'vitest'
import { BillingCard } from './billing-card'

beforeEach(() => {
	i18n.load('en', {})
	i18n.activate('en')
})

function renderBilling() {
	const router = createMemoryRouter(
		[
			{
				path: '/:orgSlug/settings/billing',
				element: (
					<BillingCard
						organization={{
							id: 'org-1',
							name: 'Acme',
							slug: 'acme',
							stripeCustomerId: null,
							stripeSubscriptionId: null,
							stripeProductId: null,
							planName: null,
							subscriptionStatus: null,
						}}
						plansAndPrices={null}
					/>
				),
			},
		],
		{ initialEntries: ['/acme/settings/billing'] },
	)
	return render(
		<I18nProvider i18n={i18n}>
			<RouterProvider router={router} />
		</I18nProvider>,
	)
}

describe('BillingCard', () => {
	// App has no /contact, /support or /pricing routes; those paths are read as
	// an organization slug and land on "404 Organization not found".
	it('does not link to App paths that do not exist', () => {
		renderBilling()

		for (const link of screen.getAllByRole('link')) {
			const href = link.getAttribute('href') ?? ''
			expect(href).not.toMatch(/^\/(contact|support|pricing)\b/)
		}
	})

	it('sends contact links to the support inbox', () => {
		renderBilling()

		for (const name of [/get in touch/i, /schedule a call/i, /learn more/i]) {
			expect(screen.getByRole('link', { name }).getAttribute('href')).toMatch(
				new RegExp(`^mailto:${brand.supportEmail}\\?subject=`),
			)
		}
	})

	it('points Subscribe at the plans on the same page', () => {
		const { container } = renderBilling()

		const href = screen
			.getByRole('link', { name: /subscribe/i })
			.getAttribute('href')
		expect(href).toMatch(/^#/)
		expect(container.querySelector(href!)).not.toBeNull()
	})
})
