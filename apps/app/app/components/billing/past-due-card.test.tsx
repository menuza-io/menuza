// @vitest-environment jsdom

import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { beforeEach, describe, expect, it } from 'vitest'
import { PastDueBanner } from './past-due-banner.tsx'
import {
	PastDueCard,
	cardLabel,
	type PastDueView,
	type RetryOutcome,
} from './past-due-card.tsx'

beforeEach(() => {
	i18n.load('en', {})
	i18n.activate('en')
})

function renderIn(element: React.ReactElement) {
	const router = createMemoryRouter([{ path: '/', element }], {
		initialEntries: ['/'],
	})
	return render(
		<I18nProvider i18n={i18n}>
			<RouterProvider router={router} />
		</I18nProvider>,
	)
}

const view: PastDueView = {
	since: '2026-11-03T00:00:00.000Z',
	daysOverdue: 5,
	issue: {
		invoice: {
			id: 'in_1',
			amountDue: 4999,
			currency: 'usd',
			attemptCount: 3,
			nextPaymentAttempt: Date.UTC(2026, 10, 6, 12) / 1000,
			hostedInvoiceUrl: null,
		},
		attempts: [
			{
				at: Date.UTC(2026, 10, 3, 12) / 1000,
				brand: 'visa',
				last4: '1234',
				reason: 'card_declined',
			},
			{
				at: Date.UTC(2026, 10, 1, 12) / 1000,
				brand: 'mastercard',
				last4: '9999',
				reason: 'expired_card',
			},
		],
	},
}

describe('PastDueCard (#237)', () => {
	it('shows the unpaid invoice with Retry payment', () => {
		renderIn(<PastDueCard view={view} retry={null} />)
		expect(screen.getByTestId('past-due-invoice').textContent).toContain(
			'$49.99',
		)
		expect(screen.getByRole('button', { name: 'Retry payment' })).toBeTruthy()
	})

	it('lists each failed attempt with the card and date, then the next try date', () => {
		renderIn(<PastDueCard view={view} retry={null} />)
		const attempts = screen.getAllByTestId('past-due-attempt')
		expect(attempts).toHaveLength(2)
		expect(attempts[0]?.textContent).toBe(
			'Failed with Visa ending 1234 on Nov 3.',
		)
		expect(attempts[1]?.textContent).toBe(
			'Failed with Mastercard ending 9999 on Nov 1.',
		)
		expect(screen.getByTestId('past-due-next-try').textContent).toBe(
			'Next try Nov 6.',
		)
	})

	it('says how it went after a retry', () => {
		const declined: RetryOutcome = {
			status: 'declined',
			reason: 'card_declined',
		}
		const { unmount } = renderIn(<PastDueCard view={view} retry={declined} />)
		expect(screen.getByTestId('retry-failed').textContent).toContain(
			'The card was declined',
		)
		unmount()
		renderIn(<PastDueCard view={view} retry={{ status: 'paid' }} />)
		expect(screen.getByTestId('retry-paid')).toBeTruthy()
	})

	it('still works when the provider could not be read', () => {
		renderIn(<PastDueCard view={{ ...view, issue: null }} retry={null} />)
		expect(screen.queryByRole('button', { name: 'Retry payment' })).toBeNull()
		expect(
			screen.getByRole('button', { name: 'Update payment method' }),
		).toBeTruthy()
	})

	it('names card brands', () => {
		expect(cardLabel('amex')).toBe('American Express')
		expect(cardLabel('unknown_brand')).toBe('Unknown_brand')
		expect(cardLabel(null)).toBeNull()
	})
})

describe('PastDueBanner (#237)', () => {
	it('is one line that links to billing', () => {
		renderIn(<PastDueBanner orgSlug="acme" />)
		expect(screen.getByTestId('past-due-banner').textContent).toContain(
			'Payment failed. Update your payment method.',
		)
		expect(
			screen.getByRole('link', { name: 'Go to billing' }).getAttribute('href'),
		).toBe('/acme/settings/billing')
	})
})
