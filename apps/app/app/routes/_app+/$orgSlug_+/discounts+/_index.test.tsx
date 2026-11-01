// @vitest-environment jsdom
import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { createRoutesStub } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	emptyEditorState,
	stateToDefinition,
} from '#app/utils/discounts/editor-model.ts'
import DiscountsIndexRoute from './_index.tsx'

const built = stateToDefinition(
	{ ...emptyEditorState(), name: 'Old lunch', percent: '10' },
	{ currency: 'USD', status: 'archived' },
)
if (!built.ok) throw new Error('fixture')
const definition = built.definition

const originalScrollIntoView = Element.prototype.scrollIntoView

beforeEach(() => {
	vi.stubGlobal(
		'ResizeObserver',
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	)
	// The usage counts are not under test: a failed fetch shows dashes.
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => new Response('no', { status: 500 })),
	)
	Element.prototype.scrollIntoView = vi.fn()
})

afterEach(() => {
	vi.unstubAllGlobals()
	Element.prototype.scrollIntoView = originalScrollIntoView
})

function renderList(actionResult: unknown) {
	i18n.load('en', {})
	i18n.activate('en')
	const Stub = createRoutesStub([
		{
			path: '/acme/discounts',
			Component: DiscountsIndexRoute,
			HydrateFallback: () => null,
			loader: () => ({
				orgSlug: 'acme',
				currency: 'USD',
				canWrite: true,
				locationZones: {},
				discounts: [
					{
						id: 'disc_1',
						version: 3,
						definition,
						name: 'Old lunch',
						status: 'archived',
						application: 'automatic',
						updatedAt: '2026-10-01T00:00:00.000Z',
						codes: [],
					},
				],
			}),
			action: () => actionResult,
		},
	])
	return render(
		<I18nProvider i18n={i18n}>
			<Stub initialEntries={['/acme/discounts?status=archived']} />
		</I18nProvider>,
	)
}

describe('discounts list', () => {
	it('says at page level that a restore hit the discount limit', async () => {
		renderList({ limit: 'discounts' })
		await userEvent.click(
			await screen.findByRole('button', { name: 'Restore Old lunch' }),
		)
		const alert = await screen.findByText(
			'You have reached the limit of 500 discounts. Archive some you no longer use.',
		)
		expect(alert.getAttribute('role')).toBe('alert')
		// Not a row-level line: it sits outside the table.
		expect(alert.closest('table')).toBeNull()
	})

	it('words the coupon code limit for a restore too', async () => {
		renderList({ limit: 'codes' })
		await userEvent.click(
			await screen.findByRole('button', { name: 'Restore Old lunch' }),
		)
		expect(
			await screen.findByText(
				'You have reached the limit of 2,000 coupon codes across all discounts.',
			),
		).toBeTruthy()
	})
})
