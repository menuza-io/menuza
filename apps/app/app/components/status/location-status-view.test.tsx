// @vitest-environment jsdom
import { screen, within } from '@testing-library/react'
import { getLocationHealth } from '@repo/common/location-health'
import { describe, expect, it } from 'vitest'
import { renderStaff } from '#tests/staff-render.tsx'
import { StatusBlock } from '../dashboard/blocks/status-block.tsx'
import { LocationHealthCard } from './location-status-view.tsx'

const week = JSON.stringify(
	[
		'monday',
		'tuesday',
		'wednesday',
		'thursday',
		'friday',
		'saturday',
		'sunday',
	].map((day) => ({
		day,
		isOpen: true,
		slots: [{ start: '00:00', end: '23:59' }],
	})),
)

function health(overrides: { payments?: boolean; menu?: boolean } = {}) {
	return getLocationHealth({
		now: new Date('2027-03-10T17:00:00Z'),
		location: {
			id: 'loc_1',
			name: 'Main',
			timezone: 'UTC',
			storeHours: week,
			onlineHours: week,
			specialHours: null,
			orderingPausedAt: null,
			orderingPausedUntil: null,
		},
		organization: {
			onlinePaymentsEnabled: overrides.payments ?? true,
			payAtPickupOnly: false,
			sitePublished: true,
			customDomain: null,
			customDomainStatus: null,
		},
		hasActiveMenu: overrides.menu ?? true,
		connections: [],
		phoneAgent: null,
	})
}

describe('Status views (#332)', () => {
	it('a disabled payments account reads Not taking orders with a link to payments', () => {
		renderStaff(
			<LocationHealthCard
				health={health({ payments: false })}
				orgSlug="acme"
			/>,
		)
		const card = screen.getByTestId('location-health')
		expect(within(card).getByTestId('health-summary')).toHaveTextContent(
			'Not taking orders',
		)
		expect(card).toHaveTextContent('The payments account is not active')
		expect(within(card).getByRole('link', { name: 'Fix' })).toHaveAttribute(
			'href',
			'/acme/settings/shop',
		)
	})

	it('a healthy location says all checks passed and links nowhere', () => {
		renderStaff(<LocationHealthCard health={health()} orgSlug="acme" />)
		expect(screen.getByTestId('all-checks-passed')).toBeInTheDocument()
		expect(screen.getByTestId('health-summary')).toHaveTextContent(
			'Taking orders',
		)
		expect(screen.queryByRole('link', { name: 'Fix' })).toBeNull()
	})

	it('the dashboard card lists only locations with a problem, and says when all is clear', () => {
		const ok = health()
		const bad = {
			...health({ menu: false }),
			name: 'Second',
			locationId: 'loc_2',
		}
		renderStaff(
			<StatusBlock
				orgSlug="acme"
				data={{ summary: 'not_taking_orders', locations: [ok, bad] }}
			/>,
		)
		const cards = screen.getAllByTestId('location-health')
		expect(cards).toHaveLength(1)
		expect(cards[0]).toHaveTextContent('Second')
		expect(
			screen.getByRole('link', { name: 'See every check' }),
		).toHaveAttribute('href', '/acme/status')
	})

	it('shows all clear when every location passes', () => {
		renderStaff(
			<StatusBlock
				orgSlug="acme"
				data={{ summary: 'taking_orders', locations: [health()] }}
			/>,
		)
		expect(screen.getByTestId('status-all-clear')).toBeInTheDocument()
		expect(screen.queryByTestId('location-health')).toBeNull()
	})
})
