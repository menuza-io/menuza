// @vitest-environment jsdom
import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { type ShortLinkRow } from '#app/utils/marketing/short-links.server.ts'
import { renderStaff } from '#tests/staff-render.tsx'
import { ShortLinksScreen } from './short-links-screen.tsx'

const link: ShortLinkRow = {
	id: 'l1',
	code: 'abc2345',
	kind: 'link',
	ref: null,
	label: 'Window sticker',
	targetPath: '/menu',
	utmSource: null,
	utmMedium: null,
	utmCampaign: null,
	utmContent: null,
	disabled: false,
	createdAt: 1,
	clicksThisMonth: 4,
	clicksTotal: 9,
	daily: [],
	orders: 2,
	revenueMinor: 4500,
}

describe('ShortLinksScreen (#159, #115)', () => {
	it('shows the link, its clicks and the orders placed after a click', () => {
		renderStaff(
			<ShortLinksScreen
				links={[link]}
				siteOrigin="https://acme.example.com"
				canWrite={false}
				error={null}
			/>,
		)
		expect(
			screen.getByText('https://acme.example.com/l/abc2345'),
		).toBeInTheDocument()
		expect(screen.getByTestId('short-link-clicks')).toHaveTextContent(
			'Clicks: 4 this month',
		)
		expect(screen.getByTestId('short-link-orders')).toHaveTextContent(
			'Orders after a click: 2',
		)
	})
})
