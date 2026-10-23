import { describe, expect, it } from 'vitest'
import {
	amountToMinor,
	flowReducer,
	IDLE_SECONDS,
	nextStepFor,
	startFlow,
	type Flow,
	type KioskIdentifyView,
} from './clock-flow.ts'

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

function typed(digits: string, flow: Flow = startFlow('pin')) {
	return [...digits].reduce(
		(state, digit) => flowReducer(state, { type: 'digit', digit }),
		flow,
	)
}

describe('kiosk flow', () => {
	it('starts on the PIN pad, or on the names in pick-name mode', () => {
		expect(startFlow('pin').screen).toBe('pin')
		expect(startFlow('pick_name').screen).toBe('people')
	})

	it('collects up to six digits and ignores everything else', () => {
		expect((typed('4821') as any).pin).toBe('4821')
		expect((typed('1234567') as any).pin).toBe('123456')
		expect((typed('4a8') as any).pin).toBe('48')
		const back = flowReducer(typed('482'), { type: 'backspace' }) as any
		expect(back.pin).toBe('48')
		expect((flowReducer(typed('482'), { type: 'clear' }) as any).pin).toBe('')
	})

	it('refuses digits while the pad is paused', () => {
		const rejected = flowReducer(typed('1111'), {
			type: 'rejected',
			notice: { code: 'invalid_pin', retryAfterSeconds: 30 },
			now: 1_000,
			mode: 'pin',
		}) as any
		expect(rejected.pin).toBe('')
		expect(rejected.pausedUntil).toBe(31_000)
		expect(
			(flowReducer(rejected, { type: 'digit', digit: '5' }) as any).pin,
		).toBe('')
	})

	it('a wrong PIN clears the digits and keeps the person in pick-name mode', () => {
		let flow = startFlow('pick_name')
		flow = flowReducer(flow, {
			type: 'pickPerson',
			person: { staffId: 's1', firstName: 'Rana' },
		})
		flow = typed('9999', flow)
		const rejected = flowReducer(flow, {
			type: 'rejected',
			notice: { code: 'invalid_pin' },
			now: 0,
			mode: 'pick_name',
		}) as any
		expect(rejected).toMatchObject({
			screen: 'pin',
			pin: '',
			person: { staffId: 's1' },
			notice: { code: 'invalid_pin' },
		})
	})

	it('a failure after the PIN step returns to a clean start with the message', () => {
		const actions = flowReducer(typed('4821'), {
			type: 'identified',
			who: who(),
		})
		expect(actions.screen).toBe('actions')
		const failed = flowReducer(actions, {
			type: 'rejected',
			notice: { code: 'already_clocked_in' },
			now: 0,
			mode: 'pin',
		}) as any
		expect(failed).toMatchObject({
			screen: 'pin',
			pin: '',
			notice: { code: 'already_clocked_in' },
		})
	})

	it('goes back to the start and forgets the PIN', () => {
		const actions = flowReducer(typed('4821'), {
			type: 'identified',
			who: who(),
		})
		const reset = flowReducer(actions, { type: 'reset', mode: 'pin' })
		expect(JSON.stringify(reset)).not.toContain('4821')
	})

	it('asks for a role only when clocking in with several to choose from', () => {
		const actions = flowReducer(typed('4821'), {
			type: 'identified',
			who: who({
				positions: [
					{ id: 'p1', name: 'Server', nameAr: null },
					{ id: 'p2', name: 'Host', nameAr: null },
				],
			}),
		}) as Extract<Flow, { screen: 'actions' }>
		expect(nextStepFor(actions, 'clock_in')).toBe('role')
		expect(nextStepFor(actions, 'clock_out')).toBe('submit')
		expect(nextStepFor(actions, 'break_start')).toBe('submit')
	})

	it('offers the tip prompt only at clock-out and only where it applies', () => {
		const tipped = flowReducer(typed('4821'), {
			type: 'identified',
			who: who({ state: 'in', promptTips: true }),
		}) as Extract<Flow, { screen: 'actions' }>
		expect(nextStepFor(tipped, 'clock_out')).toBe('tips')
		expect(nextStepFor(tipped, 'break_start')).toBe('submit')
		const plain = { ...tipped, who: who({ state: 'in' }) }
		expect(nextStepFor(plain, 'clock_out')).toBe('submit')
	})

	it('builds a tip amount with at most two decimals', () => {
		let flow: Flow = flowReducer(
			flowReducer(typed('4821'), {
				type: 'identified',
				who: who({ promptTips: true }),
			}),
			{ type: 'chooseTips', positionId: null },
		)
		for (const digit of ['1', '2', '.', '5', '0', '9']) {
			flow = flowReducer(flow, { type: 'amountDigit', digit })
		}
		expect((flow as any).amount).toBe('12.50')
		flow = flowReducer(flow, { type: 'amountDigit', digit: '.' })
		expect((flow as any).amount).toBe('12.50')
		flow = flowReducer(flow, { type: 'amountBackspace' })
		expect((flow as any).amount).toBe('12.5')
	})

	it('starts a bare decimal point as zero point and drops leading zeros', () => {
		let flow: Flow = flowReducer(
			flowReducer(typed('4821'), {
				type: 'identified',
				who: who({ promptTips: true }),
			}),
			{ type: 'chooseTips', positionId: null },
		)
		flow = flowReducer(flow, { type: 'amountDigit', digit: '.' })
		expect((flow as any).amount).toBe('0.')
		flow = flowReducer(flow, { type: 'amountBackspace' })
		flow = flowReducer(flow, { type: 'amountBackspace' })
		for (const digit of ['0', '0', '7']) {
			flow = flowReducer(flow, { type: 'amountDigit', digit })
		}
		expect((flow as any).amount).toBe('7')
	})

	it('converts an amount to minor units and refuses junk', () => {
		expect(amountToMinor('12.5')).toBe(1250)
		expect(amountToMinor('0.99')).toBe(99)
		expect(amountToMinor('100')).toBe(10_000)
		for (const bad of ['', '.', '1.234', 'abc', '1e3', '-1', '123456']) {
			expect(amountToMinor(bad)).toBeNull()
		}
	})

	it('ignores actions that do not belong to the current screen', () => {
		const people = startFlow('pick_name')
		expect(flowReducer(people, { type: 'digit', digit: '1' })).toBe(people)
		const pin = startFlow('pin')
		expect(flowReducer(pin, { type: 'amountDigit', digit: '1' })).toBe(pin)
		expect(
			flowReducer(pin, {
				type: 'pickPerson',
				person: { staffId: 'x', firstName: 'X' },
			}),
		).toBe(pin)
	})

	it('the confirmation closes by itself quickly; the PIN pad waits for people', () => {
		expect(IDLE_SECONDS.done).toBe(5)
		expect(IDLE_SECONDS.pin).toBeNull()
		expect(IDLE_SECONDS.actions).toBeLessThanOrEqual(30)
	})
})
