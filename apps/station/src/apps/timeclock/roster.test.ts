import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import {
	findClockPerson,
	forgetClockPin,
	rememberClockPerson,
} from './roster.ts'
import { db } from '~/lib/db.ts'
import { CACHE_MAX_AGE_MS, resetMonotonicWait } from '~/lib/signin.ts'

const rana = {
	firstName: 'Rana',
	positions: [{ id: 'p1', name: 'Server', nameAr: null }],
	breakKinds: [] as Array<'meal' | 'rest'>,
}

beforeEach(async () => {
	await db.clockPeople.clear()
	await db.meta.clear()
	resetMonotonicWait()
})

describe('offline clock roster', () => {
	it('greets a PIN seen online, and forgets it when the server does', async () => {
		const now = Date.UTC(2026, 9, 23, 12)
		await rememberClockPerson('4321', rana, now)
		expect(await findClockPerson('4321', now)).toEqual({
			person: expect.objectContaining({ firstName: 'Rana' }),
		})
		expect(await findClockPerson('9999', now)).toEqual({ person: null })
		await forgetClockPin('4321')
		expect(await findClockPerson('4321', now)).toEqual({ person: null })
	})

	it('remembers who declares cash tips, so an offline clock-out asks too', async () => {
		const now = Date.UTC(2026, 9, 23, 12)
		// Clocked in: tips are known, roles are not sent.
		await rememberClockPerson(
			'4321',
			{ ...rana, positions: [], state: 'in', promptTips: true },
			now,
		)
		await rememberClockPerson('8765', { ...rana, state: 'in' }, now)
		expect(await findClockPerson('4321', now)).toEqual({
			person: expect.objectContaining({ promptTips: true }),
		})
		const other = await findClockPerson('8765', now)
		expect('person' in other && other.person?.promptTips).toBeFalsy()
		// Clocked out next time: the roles come back, the tips are kept.
		await rememberClockPerson('4321', { ...rana, state: 'out' }, now)
		expect(await findClockPerson('4321', now)).toEqual({
			person: expect.objectContaining({
				promptTips: true,
				positions: rana.positions,
			}),
		})
		// Clocked in again: the roles are kept.
		await rememberClockPerson(
			'4321',
			{ ...rana, positions: [], state: 'in', promptTips: true },
			now,
		)
		expect(await findClockPerson('4321', now)).toEqual({
			person: expect.objectContaining({ positions: rana.positions }),
		})
	})

	it('forgets people it has not seen for a while', async () => {
		const now = Date.UTC(2026, 9, 23, 12)
		await rememberClockPerson('4321', rana, now - CACHE_MAX_AGE_MS - 1)
		expect(await findClockPerson('4321', now)).toEqual({ person: null })
		expect(await db.clockPeople.count()).toBe(0)
	})

	it('never brings back, as new, what it had forgotten', async () => {
		const now = Date.UTC(2026, 9, 23, 12)
		const tenDaysAgo = now - 10 * 24 * 60 * 60 * 1000
		// Ten days ago both had a role on file and declared cash tips.
		for (const pin of ['4321', '8765']) {
			await rememberClockPerson(pin, { ...rana, state: 'out' }, tenDaysAgo)
			await rememberClockPerson(
				pin,
				{ ...rana, positions: [], state: 'in', promptTips: true },
				tenDaysAgo,
			)
		}
		// Now one is clocked out (the tips setting comes only while clocked in)
		// and the other clocked in (roles come only while clocked out): neither
		// old answer is kept.
		await rememberClockPerson('4321', { ...rana, state: 'out' }, now)
		await rememberClockPerson(
			'8765',
			{ ...rana, positions: [], state: 'in' },
			now,
		)
		const out = await findClockPerson('4321', now)
		expect(out).toEqual({
			person: expect.objectContaining({ positions: rana.positions }),
		})
		expect('person' in out && out.person?.promptTips).toBeFalsy()
		expect(await findClockPerson('8765', now)).toEqual({
			person: expect.objectContaining({ positions: [] }),
		})
	})

	it('unknown PINs count like wrong ones at sign-in: after a few, a wait', async () => {
		const now = Date.UTC(2026, 9, 23, 12)
		await rememberClockPerson('4321', rana, now)
		const answers = []
		for (const pin of ['1111', '2222', '3333', '4444', '5555'])
			answers.push(await findClockPerson(pin, now))
		expect(answers.slice(0, 4)).toEqual(Array(4).fill({ person: null }))
		expect(answers[4]).toEqual({ wait: 30 })
		// Even the right PIN waits.
		expect(await findClockPerson('4321', now + 1000)).toMatchObject({
			wait: expect.any(Number),
		})
	})
})
