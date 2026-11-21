// @vitest-environment jsdom
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderStaff } from '#tests/staff-render.tsx'
import { JourneyStepAttribution } from './journey-step-attribution.tsx'

const answer = {
	currency: 'usd',
	steps: [
		{
			nodeId: 'e1',
			clicked: { orders: 2, revenueMinor: 4000 },
			reached: { orders: 5, revenueMinor: 11000 },
		},
		{
			nodeId: 's1',
			clicked: { orders: 0, revenueMinor: 0 },
			reached: { orders: 1, revenueMinor: 900 },
		},
	],
}

describe('JourneyStepAttribution (#115)', () => {
	afterEach(() => vi.unstubAllGlobals())

	it('lists orders and revenue per step and switches between Clicked and Reached', async () => {
		const fetchMock = vi.fn(async () => Response.json(answer))
		vi.stubGlobal('fetch', fetchMock)
		renderStaff(
			<JourneyStepAttribution
				journeyId="j 1"
				jwt="jwt"
				tenantApiUrl="http://region"
				labels={[
					{ nodeId: 'e1', type: 'action_email', summary: 'Welcome in' },
					{ nodeId: 's1', type: 'action_sms', summary: '' },
				]}
			/>,
		)
		expect(await screen.findByTestId('step-attribution-e1')).toBeInTheDocument()
		expect(fetchMock).toHaveBeenCalledWith(
			'http://region/operator/journeys/j%201/attribution',
			expect.objectContaining({
				headers: { Authorization: 'Bearer jwt' },
			}),
		)
		const first = screen.getByTestId('step-attribution-e1')
		expect(first).toHaveTextContent('Email: Welcome in')
		expect(first).toHaveTextContent('2')
		expect(first).toHaveTextContent('$40.00')
		expect(screen.getByTestId('step-attribution-s1')).toHaveTextContent('Text')

		await userEvent.click(screen.getByTestId('step-attribution-reached'))
		expect(screen.getByTestId('step-attribution-e1')).toHaveTextContent('5')
		expect(screen.getByTestId('step-attribution-e1')).toHaveTextContent(
			'$110.00',
		)
		expect(screen.getByText('Revenue from guests reached')).toBeInTheDocument()
	})
})
