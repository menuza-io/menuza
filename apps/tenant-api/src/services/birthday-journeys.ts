import {
	birthdayDue,
	candidateBirthMonthDays,
	DEFAULT_BIRTHDAY_DAYS_BEFORE,
} from '@repo/common/birthday'
import {
	customers,
	getTenantDb,
	marketingJourneys,
	restaurantOrders,
	rsvLocationSettings,
	type TenantDatabase,
} from '@repo/tenant-db'
import { isValidTimeZone, localParts } from '@repo/zoned-time'
import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm'
import { errorLogFields } from '../lib/error-log.ts'
import {
	claimEmission,
	ORDER_JOURNEY_BATCH,
	settleEmission,
	spawnJourneys,
} from './order-journeys.ts'

/**
 * Birthday journeys (#151): the trigger `birthday_coming_up` starts a journey
 * N days before a guest's birthday (default 7), at 10:00 local time. Local time
 * is the zone of the guest's most recent order's location, else the journey's
 * own `timeZone` setting (the App puts the organization's zone there), else the
 * zone of a reservations location, else UTC.
 *
 * Once per guest per year per journey: the emission ref is `<year>:<journey>`,
 * so changing the birthday after it fired never fires it again that year. 29
 * February is celebrated on 28 February in a non-leap year. A birthday is not
 * consent: the journey's steps check marketing consent like any other.
 *
 * The birthday itself never leaves this module: not in the run context, not in
 * the log. Only the year and ids do.
 */

type BirthdayJourney = { id: string; daysBefore: number; timeZone: string | null }

function readConfig(raw: unknown): { daysBefore?: unknown; timeZone?: unknown } {
	try {
		const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
		return parsed && typeof parsed === 'object' ? parsed : {}
	} catch {
		return {}
	}
}

async function activeBirthdayJourneys(
	db: TenantDatabase,
): Promise<BirthdayJourney[]> {
	const rows = await db
		.select({
			id: marketingJourneys.id,
			triggerConfig: marketingJourneys.triggerConfig,
		})
		.from(marketingJourneys)
		.where(
			and(
				eq(marketingJourneys.status, 'active'),
				eq(marketingJourneys.triggerType, 'birthday_coming_up'),
			),
		)
		.all()
	return rows.map((row) => {
		const config = readConfig(row.triggerConfig)
		const days =
			typeof config.daysBefore === 'number'
				? Math.min(Math.max(Math.floor(config.daysBefore), 0), 60)
				: DEFAULT_BIRTHDAY_DAYS_BEFORE
		const zone =
			typeof config.timeZone === 'string' && isValidTimeZone(config.timeZone)
				? config.timeZone
				: null
		return { id: row.id, daysBefore: days, timeZone: zone }
	})
}

/** The guest's local zone for "10:00 local time". */
async function guestTimeZone(
	db: TenantDatabase,
	customerId: string,
	fallback: string | null,
	locationZone: () => Promise<string | null>,
): Promise<string> {
	const latest = await db
		.select({ zone: restaurantOrders.locationTimezone })
		.from(restaurantOrders)
		.where(
			and(
				eq(restaurantOrders.customerId, customerId),
				isNotNull(restaurantOrders.locationTimezone),
			),
		)
		.orderBy(desc(restaurantOrders.createdAt))
		.limit(1)
		.get()
	if (latest?.zone && isValidTimeZone(latest.zone)) return latest.zone
	return fallback ?? (await locationZone()) ?? 'UTC'
}

export async function runBirthdayJourneys(
	orgId: string,
	options: { now?: number } = {},
): Promise<{ started: number }> {
	const now = options.now ?? Date.now()
	let started = 0
	try {
		const db = await getTenantDb(orgId)
		const journeys = await activeBirthdayJourneys(db)
		if (journeys.length === 0) return { started: 0 }
		const utc = new Date(now)
		const utcDay = {
			year: utc.getUTCFullYear(),
			month: utc.getUTCMonth() + 1,
			day: utc.getUTCDate(),
		}
		let reservationZone: string | null | undefined
		const locationZone = async () => {
			if (reservationZone === undefined) {
				const row = await db
					.select({ zone: rsvLocationSettings.timeZone })
					.from(rsvLocationSettings)
					.limit(1)
					.get()
				reservationZone = row?.zone && isValidTimeZone(row.zone) ? row.zone : null
			}
			return reservationZone
		}

		for (const journey of journeys) {
			const candidates = await db
				.select({
					id: customers.id,
					birthMonthDay: customers.birthMonthDay,
				})
				.from(customers)
				.where(
					// bounded: at most 8 month-day values (`candidateBirthMonthDays`)
					inArray(
						customers.birthMonthDay,
						candidateBirthMonthDays(utcDay, journey.daysBefore),
					),
				)
				.limit(ORDER_JOURNEY_BATCH * 10)
				.all()
			let startedHere = 0
			for (const guest of candidates) {
				if (startedHere >= ORDER_JOURNEY_BATCH) break
				if (!guest.birthMonthDay) continue
				const zone = await guestTimeZone(
					db,
					guest.id,
					journey.timeZone,
					locationZone,
				)
				const local = localParts(now, zone)
				const decision = birthdayDue({
					birthMonthDay: guest.birthMonthDay,
					daysBefore: journey.daysBefore,
					today: { year: local.year, month: local.month, day: local.day },
					hour: local.hour,
				})
				if (!decision.due) continue
				const emission = {
					customerId: guest.id,
					trigger: 'birthday_coming_up',
					ref: `${decision.year}:${journey.id}`,
				}
				if (!(await claimEmission(db, emission, now))) continue
				try {
					await spawnJourneys(
						orgId,
						'birthday_coming_up',
						guest.id,
						undefined,
						{ birthdayYear: decision.year },
						{ journeyId: journey.id },
					)
				} catch (error) {
					console.error('Birthday journey could not start', {
						orgId,
						...errorLogFields(error),
					})
					await settleEmission(db, emission, false, now).catch(() => {})
					continue
				}
				await settleEmission(db, emission, true, now)
				startedHere += 1
				started += 1
			}
		}
	} catch (error) {
		console.error('Birthday journeys could not run', {
			orgId,
			...errorLogFields(error),
		})
	}
	return { started }
}
