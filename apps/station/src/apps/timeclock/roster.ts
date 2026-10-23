import { type KioskIdentifyView } from '@repo/staffing/clock-flow'
import { db, type ClockPerson } from '~/lib/db.ts'
import { derivePinKey } from '~/lib/pin.ts'
import {
	CACHE_MAX_AGE_MS,
	deviceSalt,
	guardedOfflineLookup,
} from '~/lib/signin.ts'

/**
 * The people this till has seen at its time clock, so an offline punch can say
 * whose it is and offer their roles. Only a first name and the roles are kept,
 * against a slow hash of the PIN (as for offline sign-in). It never decides a
 * punch: the server checks the PIN and the order when the punch goes out.
 */

const keyFor = async (pin: string) => derivePinKey(pin, await deviceSalt())

/** Remembers whoever an online check just named. */
export async function rememberClockPerson(
	pin: string,
	who: Pick<KioskIdentifyView, 'firstName' | 'positions' | 'breakKinds'>,
	now = Date.now(),
): Promise<void> {
	await db.clockPeople.put({
		key: await keyFor(pin),
		firstName: who.firstName,
		positions: who.positions,
		breakKinds: who.breakKinds,
		cachedAt: now,
	})
}

/**
 * The remembered person for this PIN (null when the till has not seen it
 * lately), or how long to wait: offline, each lookup goes through the same
 * attempt guard as signing in, and an unknown PIN counts against it.
 */
export async function findClockPerson(
	pin: string,
	now = Date.now(),
): Promise<{ wait: number } | { person: ClockPerson | null }> {
	const result = await guardedOfflineLookup(
		pin,
		async (key) => {
			const person = await db.clockPeople.get(key)
			if (!person) return null
			if (now - person.cachedAt > CACHE_MAX_AGE_MS) {
				await db.clockPeople.delete(person.key)
				return null
			}
			return person
		},
		now,
	)
	return 'wait' in result ? result : { person: result.found }
}

/** The server no longer knows this PIN: stop greeting anyone by it. */
export async function forgetClockPin(pin: string): Promise<void> {
	await db.clockPeople.delete(await keyFor(pin))
}
