// @vitest-environment jsdom

import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { beforeEach, describe, expect, it } from 'vitest'
import { type CancelRequestContext } from '#app/utils/billing/cancel-request.ts'
import { CancelRequestForm } from './cancel-request-form.tsx'
import { ChangeRequestCard } from './change-request-card.tsx'

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

const context: CancelRequestContext = {
	cutoff: '2026-12-14T12:00:00.000Z',
	retentionOffer: 'Pause for two months, free.',
	locations: [{ id: 'loc_1', name: 'Olaya' }],
	downgradeTo: 'Base',
	open: null,
}
const downloads = [{ label: 'Download your menu', href: '/acme/menu/export' }]

describe('CancelRequestForm (#379)', () => {
	it('states the cutoff date above the button, before the owner confirms', () => {
		renderIn(
			<CancelRequestForm
				context={context}
				downloads={downloads}
				billingHref="/acme/settings/billing"
				error={null}
			/>,
		)
		const cutoff = screen.getByTestId('cancel-cutoff')
		expect(cutoff.textContent).toContain('December 14, 2026')
		const button = screen.getByRole('button', { name: 'Send request' })
		// The date comes first in the document, then the button.
		expect(
			cutoff.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy()
		expect(button).toBeDisabled()
	})

	it('offers the retention offer and data exports before sending', () => {
		renderIn(
			<CancelRequestForm
				context={context}
				downloads={downloads}
				billingHref="/acme/settings/billing"
				error={null}
			/>,
		)
		expect(screen.getByTestId('retention-offer').textContent).toContain(
			'Pause for two months, free.',
		)
		expect(
			screen
				.getByRole('link', { name: 'Download your menu' })
				.getAttribute('href'),
		).toBe('/acme/menu/export')
	})

	it('cannot be sent when the billing date is not known', () => {
		renderIn(
			<CancelRequestForm
				context={{ ...context, cutoff: null }}
				downloads={downloads}
				billingHref="/acme/settings/billing"
				error={null}
			/>,
		)
		expect(screen.getByTestId('cancel-cutoff').textContent).toContain(
			'could not read your billing date',
		)
		expect(screen.getByRole('button', { name: 'Send request' })).toBeDisabled()
	})

	it('does not show the downgrade choice when there is no smaller plan', () => {
		renderIn(
			<CancelRequestForm
				context={{ ...context, downgradeTo: null }}
				downloads={downloads}
				billingHref="/acme/settings/billing"
				error={null}
			/>,
		)
		expect(screen.queryByText('Move to a smaller plan')).toBeNull()
		expect(screen.getByText('Cancel everything')).toBeTruthy()
	})

	it('names an error from the server', () => {
		renderIn(
			<CancelRequestForm
				context={context}
				downloads={downloads}
				billingHref="/acme/settings/billing"
				error="already_requested"
			/>,
		)
		expect(screen.getByTestId('cancel-error').textContent).toContain(
			'already have a request open',
		)
	})

	it('points to the open request instead of a second form', () => {
		renderIn(
			<CancelRequestForm
				context={{
					...context,
					open: {
						id: 'r1',
						kind: 'cancel_organization',
						reason: 'other',
						subReason: null,
						locationIds: [],
						targetPlan: null,
						effectiveAt: context.cutoff,
						createdAt: '2026-11-28T00:00:00.000Z',
					},
				}}
				downloads={downloads}
				billingHref="/acme/settings/billing"
				error={null}
			/>,
		)
		expect(screen.getByTestId('cancel-request-open')).toBeTruthy()
		expect(screen.queryByTestId('cancel-form')).toBeNull()
	})
})

describe('ChangeRequestCard (#379)', () => {
	it('offers a request when none is open', () => {
		renderIn(<ChangeRequestCard orgSlug="acme" open={null} />)
		expect(
			screen
				.getByRole('button', { name: 'Request a change' })
				.getAttribute('href'),
		).toBe('/acme/settings/billing/cancel')
	})

	it('says nothing changed and when it takes effect, with a way to withdraw', () => {
		renderIn(
			<ChangeRequestCard
				orgSlug="acme"
				open={{
					id: 'r1',
					kind: 'cancel_organization',
					reason: 'too_expensive',
					subReason: null,
					locationIds: [],
					targetPlan: null,
					effectiveAt: '2026-12-14T12:00:00.000Z',
					createdAt: '2026-11-28T00:00:00.000Z',
				}}
			/>,
		)
		const card = screen.getByTestId('change-request-open')
		expect(card.textContent).toContain('Nothing has changed')
		expect(card.textContent).toContain('December 14, 2026')
		expect(
			screen.getByRole('button', { name: 'Withdraw request' }),
		).toBeTruthy()
	})
})
