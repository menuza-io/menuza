// @vitest-environment jsdom

import { cleanup, fireEvent, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { type KioskIdentifyView } from '#app/utils/kiosk/kiosk-api.ts'
import { renderStaff } from '#tests/staff-render.tsx'
import {
	ActionsScreen,
	DoneScreen,
	OfflineScreen,
	PeopleScreen,
	PinScreen,
	RoleScreen,
	TipsScreen,
} from './kiosk-screens.tsx'
import { PinDots, PinPad } from './pin-pad.tsx'

const who = (
	overrides: Partial<KioskIdentifyView> = {},
): KioskIdentifyView => ({
	firstName: 'Rana',
	state: 'out',
	allowedEvents: ['clock_in'],
	positions: [],
	nextShifts: [],
	promptTips: false,
	breakKinds: [],
	serverNow: 1,
	...overrides,
})

describe('PinPad', () => {
	it('sends digits, delete and continue, and always shows Western numerals', () => {
		const onDigit = vi.fn()
		const onBackspace = vi.fn()
		const onSubmit = vi.fn()
		renderStaff(
			<PinPad
				onDigit={onDigit}
				onBackspace={onBackspace}
				onSubmit={onSubmit}
			/>,
		)
		for (const digit of ['4', '8', '2', '1', '0']) {
			fireEvent.click(screen.getByRole('button', { name: digit }))
		}
		expect(onDigit.mock.calls.map((call) => call[0])).toEqual([
			'4',
			'8',
			'2',
			'1',
			'0',
		])
		fireEvent.click(screen.getByRole('button', { name: 'Delete last digit' }))
		expect(onBackspace).toHaveBeenCalledTimes(1)
		fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
		expect(onSubmit).toHaveBeenCalledTimes(1)
		expect(screen.getByRole('group', { name: 'Number pad' })).toHaveAttribute(
			'dir',
			'ltr',
		)
	})

	it('works from a physical keyboard too', () => {
		const onDigit = vi.fn()
		const onBackspace = vi.fn()
		const onSubmit = vi.fn()
		renderStaff(
			<PinPad
				onDigit={onDigit}
				onBackspace={onBackspace}
				onSubmit={onSubmit}
			/>,
		)
		fireEvent.keyDown(window, { key: '7' })
		fireEvent.keyDown(window, { key: 'a' })
		fireEvent.keyDown(window, { key: 'Backspace' })
		fireEvent.keyDown(window, { key: 'Enter' })
		expect(onDigit).toHaveBeenCalledWith('7')
		expect(onDigit).toHaveBeenCalledTimes(1)
		expect(onBackspace).toHaveBeenCalledTimes(1)
		expect(onSubmit).toHaveBeenCalledTimes(1)
	})

	it('ignores everything while disabled', () => {
		const onDigit = vi.fn()
		renderStaff(
			<PinPad
				disabled
				onDigit={onDigit}
				onBackspace={() => {}}
				onSubmit={() => {}}
			/>,
		)
		fireEvent.keyDown(window, { key: '5' })
		fireEvent.click(screen.getByRole('button', { name: '5' }))
		expect(onDigit).not.toHaveBeenCalled()
	})

	it('only offers a decimal point on an amount pad', () => {
		renderStaff(<PinPad decimal onDigit={() => {}} onBackspace={() => {}} />)
		expect(screen.getByRole('button', { name: 'Decimal point' })).toBeTruthy()
		expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull()
	})

	it('speaks the count of digits typed, never the digits', () => {
		renderStaff(<PinDots length={3} />)
		expect(screen.getByRole('img', { name: '3 digits entered' })).toBeTruthy()
	})
})

describe('PinScreen', () => {
	const base = {
		pin: '',
		personName: null,
		notice: null,
		pausedUntil: null,
		busy: false,
		onDigit: () => {},
		onBackspace: () => {},
		onSubmit: () => {},
	}

	it('keeps Continue off until the shortest PIN is in', () => {
		renderStaff(<PinScreen {...base} pin="123" />)
		expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled()
		cleanup()
		renderStaff(<PinScreen {...base} pin="1234" />)
		expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled()
	})

	it('greets the person picked by name', () => {
		renderStaff(<PinScreen {...base} personName="Rana" onBack={() => {}} />)
		expect(
			screen.getByRole('heading', { name: 'Hi Rana, enter your PIN' }),
		).toBeTruthy()
		expect(screen.getByRole('button', { name: /Not me/ })).toBeTruthy()
	})

	it('says why the pad is paused and stops accepting digits', () => {
		renderStaff(
			<PinScreen
				{...base}
				notice={{ code: 'invalid_pin', retryAfterSeconds: 30 }}
				pausedUntil={Date.now() + 30_000}
			/>,
		)
		expect(screen.getByRole('alert').textContent).toMatch(
			/Try again in \d+ seconds/,
		)
		expect(screen.getByRole('button', { name: '5' })).toBeDisabled()
	})

	it('shows a plain message for a wrong PIN', () => {
		renderStaff(<PinScreen {...base} notice={{ code: 'invalid_pin' }} />)
		expect(screen.getByRole('alert').textContent).toContain(
			'That PIN did not match. Try again.',
		)
	})
})

describe('ActionsScreen', () => {
	const noop = () => {}
	it('offers only clock in to someone who is out, and calls it the main action', () => {
		renderStaff(
			<ActionsScreen
				who={who()}
				busy={false}
				notice={null}
				onChoose={noop}
				onCancel={noop}
			/>,
		)
		expect(screen.getByRole('heading', { name: 'Hi Rana' })).toBeTruthy()
		expect(screen.getByText('You are clocked out.')).toBeTruthy()
		expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual([
			'Clock in',
			'Not me',
		])
	})

	it('lists the persons next shifts in the workplace zone, and nothing when there are none', () => {
		const start = Date.UTC(2026, 2, 3, 15, 0, 0) // 9:00 in Chicago
		renderStaff(
			<ActionsScreen
				who={who({
					nextShifts: [{ startAt: start, endAt: start + 8 * 3_600_000 }],
				})}
				busy={false}
				notice={null}
				timeZone="America/Chicago"
				onChoose={noop}
				onCancel={noop}
			/>,
		)
		const region = screen.getByRole('region', { name: 'Your next shifts' })
		expect(region.textContent).toMatch(/Tue, Mar 3/)
		expect(region.textContent).toMatch(/9:00\sAM\s–\s5:00\sPM/)
		// Times only: the buttons are unchanged.
		expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual([
			'Clock in',
			'Not me',
		])
		cleanup()
		renderStaff(
			<ActionsScreen
				who={who()}
				busy={false}
				notice={null}
				onChoose={noop}
				onCancel={noop}
			/>,
		)
		expect(screen.queryByText('Your next shifts')).toBeNull()
	})

	it('offers break and clock out when clocked in, and end break when on a break', () => {
		renderStaff(
			<ActionsScreen
				who={who({ state: 'in', allowedEvents: ['break_start', 'clock_out'] })}
				busy={false}
				notice={null}
				onChoose={noop}
				onCancel={noop}
			/>,
		)
		expect(screen.getByRole('button', { name: 'Start break' })).toBeTruthy()
		expect(screen.getByRole('button', { name: 'Clock out' })).toBeTruthy()
		cleanup()
		renderStaff(
			<ActionsScreen
				who={who({
					state: 'on_break',
					allowedEvents: ['break_end', 'clock_out'],
				})}
				busy={false}
				notice={null}
				onChoose={noop}
				onCancel={noop}
			/>,
		)
		expect(screen.getByRole('button', { name: 'End break' })).toBeTruthy()
	})

	it('tells someone with nothing allowed to ask a manager', () => {
		renderStaff(
			<ActionsScreen
				who={who({ allowedEvents: [] })}
				busy={false}
				notice={null}
				onChoose={noop}
				onCancel={noop}
			/>,
		)
		expect(screen.getByRole('alert').textContent).toMatch(/Ask a manager/)
	})

	it('reports the chosen event', () => {
		const onChoose = vi.fn()
		renderStaff(
			<ActionsScreen
				who={who()}
				busy={false}
				notice={null}
				onChoose={onChoose}
				onCancel={() => {}}
			/>,
		)
		fireEvent.click(screen.getByRole('button', { name: 'Clock in' }))
		expect(onChoose).toHaveBeenCalledWith('clock_in')
	})
})

describe('RoleScreen', () => {
	it('lists the roles in the language shown and picks one', () => {
		const onPick = vi.fn()
		renderStaff(
			<RoleScreen
				who={who({
					positions: [
						{ id: 'p1', name: 'Server', nameAr: 'نادل' },
						{ id: 'p2', name: 'Host', nameAr: null },
					],
				})}
				locale="en"
				busy={false}
				onPick={onPick}
				onCancel={() => {}}
			/>,
		)
		fireEvent.click(screen.getByRole('button', { name: 'Host' }))
		expect(onPick).toHaveBeenCalledWith('p2')
	})

	it('shows Arabic role names, falling back to the English name', () => {
		renderStaff(
			<RoleScreen
				who={who({
					positions: [
						{ id: 'p1', name: 'Server', nameAr: 'نادل' },
						{ id: 'p2', name: 'Host', nameAr: null },
					],
				})}
				locale="ar"
				busy={false}
				onPick={() => {}}
				onCancel={() => {}}
			/>,
		)
		expect(screen.getByRole('button', { name: 'نادل' })).toBeTruthy()
		expect(screen.getByRole('button', { name: 'Host' })).toBeTruthy()
	})
})

describe('TipsScreen', () => {
	it('shows the amount and only lets a valid one through', () => {
		const onSubmit = vi.fn()
		const props = {
			busy: false,
			onDigit: () => {},
			onBackspace: () => {},
			onSkip: () => {},
			onCancel: () => {},
			onSubmit,
		}
		renderStaff(<TipsScreen {...props} amount="" />)
		expect(screen.getByRole('status').textContent).toBe('0')
		expect(
			screen.getAllByRole('button', { name: 'Clock out' })[0],
		).toBeDisabled()
		cleanup()
		renderStaff(<TipsScreen {...props} amount="12.5" />)
		expect(screen.getByRole('status').textContent).toBe('12.5')
		fireEvent.click(screen.getByRole('button', { name: 'Clock out' }))
		expect(onSubmit).toHaveBeenCalled()
	})

	it('lets the person skip without declaring anything', () => {
		const onSkip = vi.fn()
		renderStaff(
			<TipsScreen
				busy={false}
				amount=""
				onDigit={() => {}}
				onBackspace={() => {}}
				onSubmit={() => {}}
				onSkip={onSkip}
				onCancel={() => {}}
			/>,
		)
		fireEvent.click(screen.getByRole('button', { name: 'No tips' }))
		expect(onSkip).toHaveBeenCalled()
	})
})

describe('OfflineScreen', () => {
	it('explains that the punch is saved here and offers all four actions', () => {
		const onChoose = vi.fn()
		renderStaff(
			<OfflineScreen busy={false} onChoose={onChoose} onCancel={() => {}} />,
		)
		expect(screen.getByText(/saved on this tablet/)).toBeTruthy()
		fireEvent.click(screen.getByRole('button', { name: 'End break' }))
		expect(onChoose).toHaveBeenCalledWith('break_end')
		for (const name of ['Clock in', 'Start break', 'Clock out']) {
			expect(screen.getByRole('button', { name })).toBeTruthy()
		}
	})
})

describe('DoneScreen', () => {
	it('confirms by first name and time, and offers an early Done', () => {
		const onDone = vi.fn()
		renderStaff(
			<DoneScreen
				done={{
					kind: 'clock_in',
					firstName: 'Rana',
					at: Date.UTC(2026, 2, 2, 15, 3),
					queued: false,
				}}
				timeZone="America/Chicago"
				seconds={5}
				onDone={onDone}
			/>,
		)
		expect(
			screen.getByRole('heading', { name: 'Clocked in, Rana' }),
		).toBeTruthy()
		expect(screen.getByText(/9:03/)).toBeTruthy()
		fireEvent.click(screen.getByRole('button', { name: 'Done' }))
		expect(onDone).toHaveBeenCalled()
	})

	it('says a queued punch is only saved on the tablet so far', () => {
		renderStaff(
			<DoneScreen
				done={{ kind: 'clock_out', firstName: 'Rana', at: null, queued: true }}
				timeZone={null}
				seconds={3}
				onDone={() => {}}
			/>,
		)
		expect(screen.getByText(/Saved on this tablet/)).toBeTruthy()
		expect(screen.getByRole('timer')).toHaveAccessibleName(
			'Closing in 3 seconds',
		)
	})
})

describe('PeopleScreen', () => {
	const people = Array.from({ length: 11 }, (_unused, index) => ({
		staffId: `s${index}`,
		firstName: `${String.fromCharCode(65 + index)}name`,
		lastInitial: 'K',
	}))

	it('pages long lists and filters by first letter', () => {
		const onPick = vi.fn()
		renderStaff(
			<PeopleScreen
				people={people}
				loading={false}
				notice={null}
				onPick={onPick}
			/>,
		)
		// Eight a page, then the rest.
		expect(screen.getAllByRole('listitem')).toHaveLength(8)
		fireEvent.click(screen.getByRole('button', { name: 'Next' }))
		expect(screen.getAllByRole('listitem')).toHaveLength(3)
		fireEvent.click(screen.getByRole('button', { name: 'C' }))
		expect(screen.getAllByRole('listitem')).toHaveLength(1)
		fireEvent.click(screen.getByRole('button', { name: /Cname/ }))
		expect(onPick).toHaveBeenCalledWith(
			expect.objectContaining({ staffId: 's2' }),
		)
	})

	it('shows only a first name and a last initial', () => {
		renderStaff(
			<PeopleScreen
				people={people.slice(0, 2)}
				loading={false}
				notice={null}
				onPick={() => {}}
			/>,
		)
		expect(screen.getByRole('button', { name: /Aname/ }).textContent).toBe(
			'AnameK.',
		)
	})

	it('says when there is nobody to pick', () => {
		renderStaff(
			<PeopleScreen
				people={[]}
				loading={false}
				notice={null}
				onPick={() => {}}
			/>,
		)
		expect(screen.getByText(/Ask a manager to set up your PIN/)).toBeTruthy()
	})
})
