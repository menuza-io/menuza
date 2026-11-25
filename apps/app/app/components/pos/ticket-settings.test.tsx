// @vitest-environment jsdom
import { TICKET_FIELDS, TICKET_TYPES } from '@repo/common/ticket-config'
import { cleanup, screen, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderStaff } from '#tests/staff-render.tsx'
import { TicketPreview, TicketSettings } from './ticket-settings.tsx'

afterEach(() => cleanup())

const location = (tickets = {}) => ({ id: 'loc1', name: 'Downtown', tickets })
/** A Base UI switch says it is off-limits with an attribute, not always `disabled`. */
const isOff = (el: HTMLElement) =>
	el.hasAttribute('disabled') ||
	el.getAttribute('aria-disabled') === 'true' ||
	el.hasAttribute('data-disabled')
const preview = () =>
	document.querySelector<HTMLElement>('[data-ticket-preview]')!

describe('the ticket settings (#363)', () => {
	it('hiding a field removes it from the live preview, and showing it brings it back', async () => {
		const user = userEvent.setup()
		renderStaff(
			<TicketSettings orgSlug="acme" canWrite locations={[location()]} />,
		)
		expect(preview().textContent).toContain('Served by Sam L.')
		await user.click(screen.getByRole('switch', { name: 'Show Served by' }))
		expect(preview().textContent).not.toContain('Served by')
		// Everything else is still there.
		expect(preview().textContent).toContain('Burger')
		expect(preview().textContent).toContain('Total')
		await user.click(screen.getByRole('switch', { name: 'Show Served by' }))
		expect(preview().textContent).toContain('Served by Sam L.')
	})

	it('follows the ticket type: a kitchen ticket has its own fields', async () => {
		const user = userEvent.setup()
		renderStaff(
			<TicketSettings orgSlug="acme" canWrite locations={[location()]} />,
		)
		await user.click(
			screen.getByRole('button', { name: 'Kitchen station ticket' }),
		)
		expect(preview().dataset.ticketPreview).toBe('kitchen')
		expect(preview().textContent).toContain('Kitchen ticket')
		expect(preview().textContent).toContain('Utensils: yes')
		await user.click(
			screen.getByRole('switch', { name: 'Show Utensils answer' }),
		)
		expect(preview().textContent).not.toContain('Utensils')
		// The receipt's settings were not touched.
		await user.click(screen.getByRole('button', { name: 'Guest receipt' }))
		expect(preview().textContent).toContain('Served by Sam L.')
	})

	it('what the law and the totals need cannot be switched off', async () => {
		renderStaff(
			<TicketSettings orgSlug="acme" canWrite locations={[location()]} />,
		)
		for (const label of ['VAT number', 'Items', 'Tax', 'Total'])
			expect(isOff(screen.getByRole('switch', { name: `Show ${label}` }))).toBe(
				true,
			)
		expect(preview().textContent).toContain('VAT No.')
	})

	it('makes a line bold or larger in the preview', async () => {
		const user = userEvent.setup()
		renderStaff(
			<TicketSettings orgSlug="acme" canWrite locations={[location()]} />,
		)
		await user.click(screen.getByRole('switch', { name: 'Bold Total' }))
		await user.click(screen.getByRole('switch', { name: 'Larger Total' }))
		const total = within(preview()).getByText('Total').parentElement!
		expect(total.className).toContain('font-bold')
		expect(total.className).toContain('text-base')
	})

	it('starts from what is saved, and a saved hidden field is hidden in the preview', () => {
		renderStaff(
			<TicketSettings
				orgSlug="acme"
				canWrite
				locations={[location({ receipt: { thankYou: { show: false } } })]}
			/>,
		)
		expect(preview().textContent).not.toContain('Thank you!')
		expect(
			screen.getByRole('switch', { name: 'Show “Thank you” line' }),
		).not.toBeChecked()
	})

	it('offers the preview of changes only and of a cancellation slip once those are on', async () => {
		const user = userEvent.setup()
		renderStaff(
			<TicketSettings orgSlug="acme" canWrite locations={[location()]} />,
		)
		await user.click(
			screen.getByRole('button', { name: 'Kitchen station ticket' }),
		)
		expect(screen.queryByRole('button', { name: 'Changes only' })).toBeNull()
		await user.click(
			screen.getByRole('switch', {
				name: 'Print only what changed on an adjusted order',
			}),
		)
		await user.click(
			screen.getByRole('switch', {
				name: 'Print a cancellation slip when an order is cancelled',
			}),
		)
		await user.click(screen.getByRole('button', { name: 'Changes only' }))
		expect(preview().textContent).toContain('changes only')
		expect(preview().textContent).toContain('Cheesecake')
		expect(preview().textContent).not.toContain('Burger')
		await user.click(screen.getByRole('button', { name: 'Cancellation slip' }))
		expect(preview().textContent).toContain('CANCELLED')
	})

	it('says plainly which tickets Station cannot print yet', async () => {
		const user = userEvent.setup()
		renderStaff(
			<TicketSettings orgSlug="acme" canWrite locations={[location()]} />,
		)
		expect(screen.queryByText(/does not print this ticket yet/)).toBeNull()
		await user.click(
			screen.getByRole('button', { name: 'Assembly (expo) ticket' }),
		)
		expect(screen.getByText(/does not print this ticket yet/)).toBeTruthy()
		await user.click(screen.getByRole('button', { name: 'Item label' }))
		expect(screen.getByText(/does not print this ticket yet/)).toBeTruthy()
	})

	it('shows no controls to a member who cannot edit', () => {
		renderStaff(
			<TicketSettings
				orgSlug="acme"
				canWrite={false}
				locations={[location()]}
			/>,
		)
		expect(
			screen.queryByRole('button', { name: 'Save ticket settings' }),
		).toBeNull()
		expect(isOff(screen.getByRole('switch', { name: 'Show Served by' }))).toBe(
			true,
		)
	})

	it('saves nothing until something changed', async () => {
		const user = userEvent.setup()
		renderStaff(
			<TicketSettings orgSlug="acme" canWrite locations={[location()]} />,
		)
		const save = screen.getByRole('button', { name: 'Save ticket settings' })
		expect(save).toBeDisabled()
		await user.click(screen.getByRole('switch', { name: 'Show Served by' }))
		expect(save).toBeEnabled()
		await user.click(screen.getByRole('switch', { name: 'Show Served by' }))
		// Back to what is saved: no change to send.
		expect(save).toBeDisabled()
	})
})

describe('every ticket type draws a preview from its field list', () => {
	it.each(TICKET_TYPES)('%s', (type) => {
		renderStaff(<TicketPreview type={type} config={{}} />)
		expect(preview().dataset.ticketPreview).toBe(type)
		// Hiding any hideable field changes the preview, and never empties it.
		const before = preview().textContent
		expect(before!.length).toBeGreaterThan(10)
		cleanup()
		const hide = Object.fromEntries(
			TICKET_FIELDS[type]
				.filter((field) => !field.locked)
				.map((field) => [field.key, { show: false }]),
		)
		renderStaff(<TicketPreview type={type} config={{ [type]: hide }} />)
		expect(preview().textContent!.length).toBeLessThan(before!.length)
		expect(preview().textContent!.length).toBeGreaterThan(0)
		vi.clearAllMocks()
	})
})

describe('logo and codes on the receipt (#263)', () => {
	const withTargets = (
		targets: { reviewUrl: string | null; appUrl: string | null },
		logoUrl: string | null = '/resources/images?objectKey=x',
	) => ({ ...location(), targets, logoUrl })
	const both = {
		reviewUrl: 'https://g.page/r/abc/review',
		appUrl: 'https://site.test/get-app?p=print',
	}

	it('shows the logo and both codes with captions in the preview once switched on', async () => {
		const user = userEvent.setup()
		renderStaff(
			<TicketSettings
				orgSlug="acme"
				canWrite
				locations={[withTargets(both)]}
			/>,
		)
		expect(preview().querySelector('[data-preview-logo]')).toBeNull()
		expect(preview().querySelector('[data-preview-code]')).toBeNull()
		await user.click(screen.getByRole('switch', { name: 'Logo at the top' }))
		await user.click(screen.getByRole('switch', { name: 'Review code' }))
		await user.click(screen.getByRole('switch', { name: 'App or rewards code' }))
		expect(preview().querySelector('[data-preview-logo]')).not.toBeNull()
		expect(
			preview().querySelector('[data-preview-code="review"]')!.textContent,
		).toContain('Enjoyed it? Tell us')
		expect(
			preview().querySelector('[data-preview-code="app"]')!.textContent,
		).toContain('Order ahead next time')
	})

	it('lets the owner reword a caption and shows it in the preview', async () => {
		const user = userEvent.setup()
		renderStaff(
			<TicketSettings
				orgSlug="acme"
				canWrite
				locations={[withTargets(both)]}
			/>,
		)
		await user.click(screen.getByRole('switch', { name: 'Review code' }))
		await user.type(
			screen.getByRole('textbox', { name: 'Review code caption' }),
			'Rate us',
		)
		expect(
			preview().querySelector('[data-preview-code="review"]')!.textContent,
		).toContain('Rate us')
	})

	it('offers no review code for a location without a review link, and says why', () => {
		renderStaff(
			<TicketSettings
				orgSlug="acme"
				canWrite
				locations={[withTargets({ reviewUrl: null, appUrl: both.appUrl })]}
			/>,
		)
		expect(isOff(screen.getByRole('switch', { name: 'Review code' }))).toBe(
			true,
		)
		expect(
			screen.getByText(/Add the location’s Google review link/),
		).toBeTruthy()
		expect(preview().querySelector('[data-preview-code="review"]')).toBeNull()
	})

	it('shows nothing extra for a location that has switched nothing on', () => {
		renderStaff(
			<TicketSettings
				orgSlug="acme"
				canWrite
				locations={[withTargets(both)]}
			/>,
		)
		expect(preview().querySelector('[data-preview-code]')).toBeNull()
		expect(preview().querySelector('[data-preview-logo]')).toBeNull()
	})
})
