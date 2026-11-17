// @vitest-environment jsdom
import { DEFAULT_POS_LOCATION_STATION_SETTINGS } from '@repo/common/pos-orders'
import { screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { renderStaff } from '#tests/staff-render.tsx'
import { StationRegisterSettings } from './station-register-settings.tsx'

const location = (cashDiscountBp: number | null) => ({
	id: 'loc1',
	name: 'Downtown',
	currency: 'USD',
	settings: { ...DEFAULT_POS_LOCATION_STATION_SETTINGS, cashDiscountBp },
})

describe('the cash discount field (#375)', () => {
	it('is shown with the saved rate where the region allows it', () => {
		renderStaff(
			<StationRegisterSettings
				orgSlug="acme"
				canWrite
				cashDiscountAllowed
				locations={[location(350)]}
			/>,
		)
		expect(screen.getByLabelText('Cash discount (%)')).toHaveValue('3.50')
	})

	it('is not shown, for KSA, even when a rate is stored', () => {
		renderStaff(
			<StationRegisterSettings
				orgSlug="acme"
				canWrite
				cashDiscountAllowed={false}
				locations={[location(300)]}
			/>,
		)
		expect(screen.queryByLabelText('Cash discount (%)')).toBeNull()
		expect(screen.queryByText(/Cash discount/)).toBeNull()
	})

	it('is not shown by default', () => {
		renderStaff(
			<StationRegisterSettings
				orgSlug="acme"
				canWrite
				locations={[location(null)]}
			/>,
		)
		expect(screen.queryByLabelText('Cash discount (%)')).toBeNull()
	})

	it('refuses a rate over the highest one before it is sent', async () => {
		renderStaff(
			<StationRegisterSettings
				orgSlug="acme"
				canWrite
				cashDiscountAllowed
				locations={[location(null)]}
			/>,
		)
		const field = screen.getByLabelText('Cash discount (%)')
		await userEvent.type(field, '12')
		await userEvent.click(
			screen.getByRole('button', { name: 'Save register settings' }),
		)
		expect(
			await screen.findByText(/Enter a cash discount of 10% or less/),
		).toBeInTheDocument()
	})
})
