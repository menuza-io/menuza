// @vitest-environment jsdom
import { screen, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import {
	dailyLimitFormToJson,
	emptyDailyLimitForm,
	type DailyLimitFormState,
} from '#app/utils/menu/daily-limit-form.ts'
import { renderStaff } from '#tests/staff-render.tsx'
import { DailyLimitCard, DailyLimitFields } from './daily-limit-fields.tsx'

const ONE = [{ id: 'a', name: 'Main Street', slug: 'main', isDefault: true }]
const TWO = [
	...ONE,
	{ id: 'b', name: 'Airport', slug: 'airport', isDefault: false },
]

function Harness({
	initial = emptyDailyLimitForm(),
	locations = TWO,
	spy,
}: {
	initial?: DailyLimitFormState
	locations?: typeof TWO
	spy?: (state: DailyLimitFormState) => void
}) {
	const [state, setState] = useState(initial)
	return (
		<DailyLimitFields
			idPrefix="t"
			state={state}
			locations={locations}
			onChange={(next) => {
				setState(next)
				spy?.(next)
			}}
		/>
	)
}

describe('DailyLimitFields (#409)', () => {
	it('starts with no limit and shows only the limit field', () => {
		renderStaff(<Harness locations={ONE} />)
		expect(screen.getByLabelText('How many can be sold each day')).toHaveValue(
			null,
		)
		// No setting to show until there is a limit to show it for.
		expect(screen.queryByRole('switch')).toBeNull()
		// One location: nothing to choose per location.
		expect(screen.queryByText('Different limit at a location')).toBeNull()
	})

	it('shows "Only N left" once a limit is typed, off by default', async () => {
		renderStaff(<Harness locations={ONE} />)
		const user = userEvent.setup()
		await user.type(
			screen.getByLabelText('How many can be sold each day'),
			'20',
		)
		const toggle = screen.getByRole('switch', {
			name: /Show "Only N left" to guests/,
		})
		expect(toggle).not.toBeChecked()
		await user.click(toggle)
		expect(toggle).toBeChecked()
	})

	it('builds the JSON the form posts from what is typed', async () => {
		const spy = vi.fn()
		renderStaff(<Harness spy={spy} />)
		const user = userEvent.setup()
		await user.type(
			screen.getByLabelText('How many can be sold each day'),
			'20',
		)
		await user.type(screen.getByLabelText('Airport'), '5')
		const last = spy.mock.calls.at(-1)![0] as DailyLimitFormState
		expect(JSON.parse(dailyLimitFormToJson(last, ['a', 'b']))).toEqual({
			limit: 20,
			showRemaining: false,
			byLocation: { b: 5 },
		})
	})

	it('lets a location have no limit, and disables its own number then', async () => {
		const spy = vi.fn()
		renderStaff(
			<Harness initial={{ ...emptyDailyLimitForm(), limit: '20' }} spy={spy} />,
		)
		const user = userEvent.setup()
		const row = screen.getByLabelText('Airport').closest('div')!.parentElement!
		await user.click(within(row).getByRole('checkbox', { name: 'No limit' }))
		expect(screen.getByLabelText('Airport')).toBeDisabled()
		const last = spy.mock.calls.at(-1)![0] as DailyLimitFormState
		expect(
			(JSON.parse(dailyLimitFormToJson(last, ['a', 'b'])) as any).byLocation,
		).toEqual({
			b: null,
		})
		// Unticking goes back to the limit above.
		await user.click(within(row).getByRole('checkbox', { name: 'No limit' }))
		expect(screen.getByLabelText('Airport')).toBeEnabled()
		const back = spy.mock.calls.at(-1)![0] as DailyLimitFormState
		expect(back.byLocation.b).toBeUndefined()
	})

	it("goes back to the limit above when a location's own number is cleared", async () => {
		const spy = vi.fn()
		renderStaff(
			<Harness initial={{ ...emptyDailyLimitForm(), limit: '20' }} spy={spy} />,
		)
		const user = userEvent.setup()
		const input = screen.getByLabelText('Airport')
		await user.type(input, '3')
		await user.clear(input)
		const last = spy.mock.calls.at(-1)![0] as DailyLimitFormState
		expect(last.byLocation.b).toBeUndefined()
	})

	it('names a limit that is not a whole number, instead of dropping it', async () => {
		renderStaff(<Harness locations={ONE} />)
		const user = userEvent.setup()
		const input = screen.getByLabelText('How many can be sold each day')
		await user.type(input, '2.5')
		expect(screen.getByRole('alert')).toHaveTextContent(
			'Enter a whole number from 1 to 10,000, or leave it empty.',
		)
		expect(input).toHaveAttribute('aria-invalid', 'true')
	})

	it('shows a saved limit with its per-location choices', () => {
		renderStaff(
			<Harness
				initial={{
					limit: '20',
					showRemaining: true,
					byLocation: {
						a: { mode: 'limit', limit: '8' },
						b: { mode: 'none', limit: '' },
					},
				}}
			/>,
		)
		expect(screen.getByLabelText('How many can be sold each day')).toHaveValue(
			20,
		)
		expect(screen.getByLabelText('Main Street')).toHaveValue(8)
		expect(screen.getByLabelText('Airport')).toBeDisabled()
		expect(
			screen.getByRole('switch', { name: /Show "Only N left" to guests/ }),
		).toBeChecked()
	})
})

describe('DailyLimitCard for an option (#409)', () => {
	it('says option, not dish, in plain words', () => {
		renderStaff(
			<DailyLimitCard
				subject="option"
				idPrefix="o"
				state={emptyDailyLimitForm()}
				onChange={() => {}}
				locations={ONE}
			/>,
		)
		expect(
			screen.getByText(/Stop taking this option once this many are chosen/),
		).toBeInTheDocument()
		expect(screen.queryByText(/for this dish/)).toBeNull()
	})
})

describe('DailyLimitCard (#409)', () => {
	it('explains the limit in plain words', () => {
		renderStaff(
			<DailyLimitCard
				idPrefix="c"
				state={emptyDailyLimitForm()}
				onChange={() => {}}
				locations={ONE}
			/>,
		)
		expect(screen.getByText('Daily limit')).toBeInTheDocument()
		expect(
			screen.getByText(
				/Stop taking orders for this dish once this many are sold/,
			),
		).toBeInTheDocument()
	})
})
