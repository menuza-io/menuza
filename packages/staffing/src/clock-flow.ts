import { z } from 'zod'
import { CLOCK_EVENTS, CLOCK_STATES, type ClockEvent } from './clock-state.ts'
import { BREAK_KINDS } from './labor-policy.ts'
import { PIN_MAX_LENGTH } from './pin.ts'

/**
 * A time clock's screen flow as a pure reducer, shared by the kiosk (App
 * `/kiosk`) and the Station till, so every transition is testable without a
 * browser. The component runs the effects (network, queue, timers) and sends
 * the results back as actions. The PIN lives only in this state and is dropped
 * on every path back to the start.
 */

const positionSchema = z.object({
	id: z.string(),
	name: z.string(),
	nameAr: z.string().nullable(),
})

/** What `/kiosk/identify` and `/pos/timeclock/identify` answer, as a client reads it. */
export const clockIdentifyResponseSchema = z.object({
	firstName: z.string(),
	state: z.enum(CLOCK_STATES),
	allowedEvents: z.array(z.enum(CLOCK_EVENTS)),
	positions: z.array(positionSchema),
	nextShifts: z.array(z.object({ startAt: z.number(), endAt: z.number() })),
	promptTips: z.boolean().default(false),
	/** An older node sends none: every break is the default one. */
	breakKinds: z.array(z.enum(BREAK_KINDS)).default([]),
	staffId: z.string().optional(),
	serverNow: z.number(),
})
export type KioskIdentifyView = z.infer<typeof clockIdentifyResponseSchema>

/** What an accepted punch answers, as a client reads it. */
export const clockPunchResponseSchema = z.object({
	outcome: z.literal('accepted'),
	duplicate: z.boolean(),
	kind: z.enum(CLOCK_EVENTS),
	state: z.enum(CLOCK_STATES),
	firstName: z.string(),
	at: z.number(),
	serverNow: z.number(),
})
export type KioskPunchView = z.infer<typeof clockPunchResponseSchema>

export type Person = { staffId: string; firstName: string }

export type Notice = {
	code: string
	retryAfterSeconds?: number
}

export type DoneInfo = {
	kind: ClockEvent
	firstName: string
	/** Epoch ms the punch counts at; null while it only waits on the tablet. */
	at: number | null
	/** True when the punch is saved on the tablet and not yet on the server. */
	queued: boolean
}

export type Flow =
	| {
			screen: 'pin'
			pin: string
			person: Person | null
			notice: Notice | null
			pausedUntil: number | null
	  }
	| { screen: 'people'; notice: Notice | null }
	| {
			screen: 'actions'
			pin: string
			person: Person | null
			who: KioskIdentifyView
	  }
	| {
			screen: 'role'
			pin: string
			person: Person | null
			who: KioskIdentifyView
	  }
	| {
			screen: 'tips'
			pin: string
			person: Person | null
			who: KioskIdentifyView
			positionId: string | null
			amount: string
	  }
	| { screen: 'offline'; pin: string; person: Person | null }
	| { screen: 'done'; done: DoneInfo }

export type Mode = 'pin' | 'pick_name'

export function startFlow(mode: Mode): Flow {
	return mode === 'pick_name'
		? { screen: 'people', notice: null }
		: { screen: 'pin', pin: '', person: null, notice: null, pausedUntil: null }
}

export type FlowAction =
	| { type: 'digit'; digit: string }
	| { type: 'backspace' }
	| { type: 'clear' }
	| { type: 'pickPerson'; person: Person }
	| { type: 'reset'; mode: Mode }
	| { type: 'identified'; who: KioskIdentifyView }
	| { type: 'rejected'; notice: Notice; now: number; mode: Mode }
	| { type: 'offline' }
	| { type: 'chooseRole' }
	| { type: 'chooseTips'; positionId: string | null }
	| { type: 'amountDigit'; digit: string }
	| { type: 'amountBackspace' }
	| { type: 'done'; done: DoneInfo }

const AMOUNT_PATTERN = /^\d{0,5}(\.\d{0,2})?$/

/** `"12.5"` -> 1250 minor units; empty or invalid is `null`. */
export function amountToMinor(amount: string): number | null {
	if (!/^\d{1,5}(\.\d{1,2})?$/.test(amount)) return null
	return Math.round(Number(amount) * 100)
}

/** What a chosen action needs before it can be sent. */
export function nextStepFor(
	flow: Extract<Flow, { screen: 'actions' }>,
	event: ClockEvent,
): 'role' | 'tips' | 'submit' {
	if (event === 'clock_in' && flow.who.positions.length > 1) return 'role'
	if (event === 'clock_out' && flow.who.promptTips) return 'tips'
	return 'submit'
}

export function flowReducer(flow: Flow, action: FlowAction): Flow {
	switch (action.type) {
		case 'digit':
			if (flow.screen !== 'pin') return flow
			if (!/^[0-9]$/.test(action.digit)) return flow
			if (flow.pausedUntil !== null) return flow
			if (flow.pin.length >= PIN_MAX_LENGTH) return flow
			return { ...flow, pin: flow.pin + action.digit, notice: null }
		case 'backspace':
			if (flow.screen !== 'pin') return flow
			return { ...flow, pin: flow.pin.slice(0, -1), notice: null }
		case 'clear':
			if (flow.screen !== 'pin') return flow
			return { ...flow, pin: '' }
		case 'pickPerson':
			if (flow.screen !== 'people') return flow
			return {
				screen: 'pin',
				pin: '',
				person: action.person,
				notice: null,
				pausedUntil: null,
			}
		case 'reset':
			return startFlow(action.mode)
		case 'identified':
			if (flow.screen !== 'pin') return flow
			return {
				screen: 'actions',
				pin: flow.pin,
				person: flow.person,
				who: action.who,
			}
		case 'rejected': {
			const pausedUntil =
				action.notice.retryAfterSeconds && action.notice.retryAfterSeconds > 0
					? action.now + action.notice.retryAfterSeconds * 1000
					: null
			if (flow.screen === 'pin') {
				return {
					...flow,
					pin: '',
					notice: action.notice,
					pausedUntil,
				}
			}
			// A failure on a later screen sends the person back to a clean start
			// carrying the message, so a stale PIN never lingers.
			return action.mode === 'pick_name'
				? { screen: 'people', notice: action.notice }
				: {
						screen: 'pin',
						pin: '',
						person: null,
						notice: action.notice,
						pausedUntil,
					}
		}
		case 'offline':
			if (flow.screen !== 'pin') return flow
			return { screen: 'offline', pin: flow.pin, person: flow.person }
		case 'chooseRole':
			if (flow.screen !== 'actions') return flow
			return {
				screen: 'role',
				pin: flow.pin,
				person: flow.person,
				who: flow.who,
			}
		case 'chooseTips':
			if (flow.screen !== 'actions' && flow.screen !== 'role') return flow
			return {
				screen: 'tips',
				pin: flow.pin,
				person: flow.person,
				who: flow.who,
				positionId: action.positionId,
				amount: '',
			}
		case 'amountDigit': {
			if (flow.screen !== 'tips') return flow
			const next = flow.amount + action.digit
			if (action.digit === '.' && flow.amount.includes('.')) return flow
			if (action.digit === '.' && flow.amount === '') {
				return { ...flow, amount: '0.' }
			}
			if (!/^[0-9.]$/.test(action.digit) || !AMOUNT_PATTERN.test(next)) {
				return flow
			}
			// No leading zeros before more digits ("007").
			if (/^0\d/.test(next)) return { ...flow, amount: next.replace(/^0+/, '') }
			return { ...flow, amount: next }
		}
		case 'amountBackspace':
			if (flow.screen !== 'tips') return flow
			return { ...flow, amount: flow.amount.slice(0, -1) }
		case 'done':
			return { screen: 'done', done: action.done }
	}
}

/** Screens that go back to the start by themselves when nobody touches them. */
export const IDLE_SECONDS: Record<Flow['screen'], number | null> = {
	pin: null,
	people: 60,
	actions: 20,
	role: 20,
	tips: 30,
	offline: 20,
	done: 5,
}
