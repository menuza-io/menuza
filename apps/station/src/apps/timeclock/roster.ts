import { type KioskIdentifyView } from '@repo/staffing/clock-flow'
import { db, type ClockPerson } from '~/lib/db.ts'
import { derivePinKey } from '~/lib/pin.ts'
import { CACHE_MAX_AGE_MS, deviceSalt } from '~/lib/signin.ts'

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
	who: Pick<KioskIdentifyView, 'firstName' | 'positions'>,
	now = Date.now(),
): Promise<void> {
	await db.clockPeople.put({
		key: await keyFor(pin),
		firstName: who.firstName,
		positions: who.positions,
		cachedAt: now,
	})
}

/** The remembered person for this PIN, or null when the till has not seen it lately. */
export async function findClockPerson(
	pin: string,
	now = Date.now(),
): Promise<ClockPerson | null> {
	const person = await db.clockPeople.get(await keyFor(pin))
	if (!person) return null
	if (now - person.cachedAt > CACHE_MAX_AGE_MS) {
		await db.clockPeople.delete(person.key)
		return null
	}
	return person
}

/** The server no longer knows this PIN: stop greeting anyone by it. */
export async function forgetClockPin(pin: string): Promise<void> {
	await db.clockPeople.delete(await keyFor(pin))
}
