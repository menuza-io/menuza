import { describe, expect, it } from 'vitest'
import {
	orderTimeline,
	orderTimings,
	resolveStepTime,
	standingSteps,
	stepActorFor,
	stepsForStatus,
	type OrderStepRow,
} from './order-steps.ts'

const MIN = 60_000

function row(
	step: OrderStepRow['step'],
	at: number,
	over: Partial<OrderStepRow> = {},
): OrderStepRow {
	return {
		step,
		event: 'done',
		at,
		recordedAt: at,
		actorKind: 'operator',
		actorId: 'usr_1',
		source: 'app',
		offline: false,
		...over,
	}
}

describe('order steps (#243)', () => {
	it('keeps the latest of a step done again and drops one taken back', () => {
		const rows = [
			row('ready', 10 * MIN),
			row('ready', 11 * MIN, { event: 'undone' }),
			row('ready', 15 * MIN),
			row('started', 5 * MIN),
			row('started', 6 * MIN, { event: 'undone' }),
		]
		const standing = standingSteps(rows)
		expect(standing.get('ready')?.at).toBe(15 * MIN)
		expect(standing.has('started')).toBe(false)
	})

	it('builds a timeline in order with who did each step and the minutes since placed', () => {
		const timeline = orderTimeline([
			row('placed', 0, { actorKind: 'guest', actorId: null, source: 'guest' }),
			row('accepted', 2 * MIN),
			row('ready', 18 * MIN, { actorKind: 'station', source: 'station_kitchen' }),
		])
		expect(timeline.map((t) => [t.step, t.minutesSincePlaced, t.source])).toEqual([
			['placed', 0, 'guest'],
			['accepted', 2, 'app'],
			['ready', 18, 'station_kitchen'],
		])
	})

	it('measures minutes to accept (only for a person), start, ready and lateness', () => {
		const people = orderTimings(
			[
				row('placed', 0),
				row('accepted', 3 * MIN),
				row('started', 5 * MIN),
				row('ready', 22 * MIN),
			],
			20 * MIN,
		)
		expect(people).toMatchObject({
			minutesToAccept: 3,
			minutesToStart: 5,
			minutesToReady: 22,
			minutesLate: 2,
			late: 1,
		})
		// An automatic accept is not a wait for a person: left out.
		const auto = orderTimings(
			[row('placed', 0), row('accepted', 0, { actorKind: 'system' }), row('ready', 10 * MIN)],
			15 * MIN,
		)
		expect(auto.minutesToAccept).toBeNull()
		expect(auto).toMatchObject({ minutesLate: -5, late: 0 })
		// No promised time, no ready time: nothing to be late against.
		expect(orderTimings([row('placed', 0)], null).late).toBeNull()
	})

	it('maps a status to the steps it reaches by fulfilment', () => {
		expect(stepsForStatus('preparing', 'pickup')).toEqual(['started'])
		expect(stepsForStatus('ready', 'pickup')).toEqual(['ready'])
		expect(stepsForStatus('ready', 'delivery')).toEqual(['ready', 'out_for_delivery'])
		expect(stepsForStatus('completed', 'dine_in')).toEqual(['handed_over'])
		expect(stepsForStatus('completed', 'delivery')).toEqual(['delivered'])
		expect(stepsForStatus('cancelled', 'pickup')).toEqual([])
	})

	it('uses the till time for a queued Station step and marks it, but never a wrong clock', () => {
		const now = Date.UTC(2026, 10, 25, 12, 0, 0)
		const tapped = new Date(now - 10 * MIN).toISOString()
		expect(resolveStepTime({ clientAt: tapped, now })).toEqual({
			at: now - 10 * MIN,
			offline: true,
		})
		// Went straight through: the server's time.
		expect(
			resolveStepTime({ clientAt: new Date(now - 5_000).toISOString(), now }),
		).toEqual({ at: now, offline: false })
		// In the future, a week old or not a time: the server's time.
		for (const clientAt of [
			new Date(now + 3_600_000).toISOString(),
			new Date(now - 7 * 86_400_000).toISOString(),
			'soon',
			null,
		]) {
			expect(resolveStepTime({ clientAt, now })).toEqual({ at: now, offline: false })
		}
	})

	it('derives the actor of a step from the origin and never carries a guest id', () => {
		expect(stepActorFor('operator', 'usr_9')).toEqual({
			actorKind: 'operator',
			actorId: 'usr_9',
			source: 'app',
		})
		expect(stepActorFor('station', 'staff:s1')).toMatchObject({
			actorKind: 'station',
			source: 'station_orders',
		})
		expect(stepActorFor('guest', 'guest')).toEqual({
			actorKind: 'guest',
			actorId: null,
			source: 'guest',
		})
		expect(stepActorFor('system', 'system').actorId).toBeNull()
	})
})
