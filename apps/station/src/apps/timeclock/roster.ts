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

/**
 * Remembers whoever an online check just named. Some of what it says depends
 * on where they are in their shift: roles come only while clocked out, and
 * whether they declare tips only while clocked in (for the job they are on).
 * The rest is kept from the last time it was said, so a clock-in does not
 * forget the tips and a clock-out does not forget the roles.
 */
export async function rememberClockPerson(
	pin: string,
	who: Pick<
		KioskIdentifyView,
		'firstName' | 'positions' | 'breakKinds' | 'staffId'
	> &
		Partial<Pick<KioskIdentifyView, 'promptTips' | 'state'>>,
	now = Date.now(),
): Promise<void> {
	const key = await keyFor(pin)
	const before = await db.clockPeople.get(key)
	// The same person as before (a PIN can change hands), seen lately enough to
	// trust: a lookup has already forgotten an older record, so must this.
	const known =
		before &&
		now - before.cachedAt <= CACHE_MAX_AGE_MS &&
		(!who.staffId || !before.staffId || before.staffId === who.staffId)
			? before
			: undefined
	const clockedIn = who.state === 'in' || who.state === 'on_break'
	const positions = clockedIn && known ? known.positions : who.positions
	const promptTips =
		who.state === 'out' ? known?.promptTips === true : who.promptTips === true
	await db.clockPeople.put({
		key,
		...(who.staffId ? { staffId: who.staffId } : {}),
		firstName: who.firstName,
		positions,
		breakKinds: who.breakKinds,
		...(promptTips ? { promptTips: true } : {}),
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
