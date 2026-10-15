import { addDays, dayOfWeek } from '@repo/zoned-time'
import { formatHhmm, localToInstant } from '../time.ts'
import { assignTables } from './assign.ts'
import {
	type EngineDayConfig,
	type ExistingOccupancyInput,
} from './availability.ts'
import { type BookingChannel } from './day-state.ts'

export type ExperienceScheduleConfig = {
	daysOfWeek?: readonly number[]
	dates?: readonly string[]
	excludedDates?: readonly string[]
	seatings: readonly number[]
}

export type ExperienceDefinitionInput = {
	id: string
	title: string
	slug: string
	status: 'draft' | 'published' | 'archived'
	paymentMode: 'none' | 'card_hold' | 'deposit' | 'prepay'
	pricePerCoverMinor: number
	currency: string
	minParty: number
	maxParty: number
	durationMin: number
	usesTables: boolean | number
	areaId?: string | null
	coversCapPerSeating: number
	schedule: ExperienceScheduleConfig
}

export type ExperienceSeatingAvailability = {
	slotMin: number
	slotHhmm: string
	startAt: number
	endAt: number
	remainingCovers: number
	tableIds: string[]
	combinationId: string | null
}

export type ExperienceAvailabilityItem = {
	experienceId: string
	title: string
	slug: string
	paymentMode: 'none' | 'card_hold' | 'deposit' | 'prepay'
	pricePerCoverMinor: number
	currency: string
	durationMin: number
	seatings: ExperienceSeatingAvailability[]
}

export type SearchExperienceAvailabilityInput = {
	config: EngineDayConfig
	businessDate: string
	partySize: number
	nowMs: number
	channel?: BookingChannel
	experiences: readonly ExperienceDefinitionInput[]
	occupancies?: readonly ExistingOccupancyInput[]
}

const INACTIVE_STATUSES = new Set([
	'cancelled',
	'no_show',
	'declined',
	'expired',
])

/**
 * Evaluate experience seatings on `businessDate` (`architecture.md` §6.9, `VAL-FND-006`).
 */
export function searchExperienceAvailability(
	input: SearchExperienceAvailabilityInput,
): ExperienceAvailabilityItem[] {
	const channel = input.channel ?? 'online'
	const dow = dayOfWeek(input.businessDate)
	const bufferMin = input.config.settings.bufferMin ?? 0
	const minNoticeMin =
		channel === 'online' || channel === 'voice'
			? (input.config.settings.minNoticeMin ?? 0)
			: 0

	const results: ExperienceAvailabilityItem[] = []

	for (const exp of input.experiences) {
		if (
			(channel === 'online' || channel === 'voice') &&
			exp.status !== 'published'
		) {
			continue
		}
		if (exp.status === 'archived') continue
		if (input.partySize < exp.minParty || input.partySize > exp.maxParty) {
			continue
		}

		const sched = exp.schedule
		if (sched.excludedDates?.includes(input.businessDate)) {
			continue
		}
		const matchesDate = sched.dates?.includes(input.businessDate) ?? false
		const matchesDow = sched.daysOfWeek?.includes(dow) ?? false
		if (!matchesDate && !matchesDow) {
			continue
		}

		const usesTables = exp.usesTables === true || exp.usesTables === 1
		const seatings: ExperienceSeatingAvailability[] = []

		for (const rawSlotMin of sched.seatings) {
			const dayOffset = Math.floor(rawSlotMin / 1440)
			const clockMin = ((rawSlotMin % 1440) + 1440) % 1440
			const calendarDate =
				dayOffset === 0
					? input.businessDate
					: addDays(input.businessDate, dayOffset)
			const startAt = localToInstant(
				calendarDate,
				clockMin,
				input.config.timeZone,
			).instantMs
			const occupyDurationMin = exp.durationMin + bufferMin
			const endAt = startAt + occupyDurationMin * 60_000

			if (startAt < input.nowMs + minNoticeMin * 60_000) {
				continue
			}

			// Check coversCapPerSeating for this experience seating
			const existingForSeating = (input.occupancies ?? []).filter((occ) => {
				if (occ.status && INACTIVE_STATUSES.has(occ.status)) return false
				if (occ.experienceId !== exp.id) return false
				if (occ.localStartMin !== undefined) {
					return occ.localStartMin === rawSlotMin
				}
				return occ.startAt === startAt
			})

			const bookedCovers = existingForSeating.reduce(
				(sum, occ) => sum + (occ.partySize ?? 0),
				0,
			)
			const remainingCovers = exp.coversCapPerSeating - bookedCovers
			if (remainingCovers < input.partySize) {
				continue
			}

			let assignedTableIds: string[] = []
			let assignedComboId: string | null = null

			if (usesTables) {
				const assignRes = assignTables({
					partySize: input.partySize,
					startAt,
					endAt,
					channel,
					areaId: exp.areaId ?? null,
					tables: input.config.tables,
					areas: input.config.areas,
					combinations: input.config.combinations,
					serviceTableModes: input.config.serviceTableModes,
					bookings: (input.occupancies ?? []).map((o) => ({
						id: o.id,
						kind: o.kind ?? 'reservation',
						partySize: o.partySize ?? 1,
						localStartMin: o.localStartMin,
						startAt: o.startAt,
						endAt: o.endAt,
						tableIds: o.tableIds ?? [],
						combinationId: o.combinationId ?? null,
						status: o.status,
						tableLocked: o.tableLocked,
						overbook: o.overbook,
						channel: o.channel,
						serviceId: o.serviceId,
						areaId: o.areaId,
					})),
					nowMs: input.nowMs,
					assignmentFreezeMin: input.config.settings.assignmentFreezeMin,
					minTurnMin: exp.durationMin,
				})
				if (!assignRes.assigned) {
					continue
				}
				assignedTableIds = assignRes.tableIds
				assignedComboId = assignRes.combinationId
			}

			seatings.push({
				slotMin: rawSlotMin,
				slotHhmm: formatHhmm(rawSlotMin),
				startAt,
				endAt,
				remainingCovers,
				tableIds: assignedTableIds,
				combinationId: assignedComboId,
			})
		}

		if (seatings.length > 0) {
			results.push({
				experienceId: exp.id,
				title: exp.title,
				slug: exp.slug,
				paymentMode: exp.paymentMode,
				pricePerCoverMinor: exp.pricePerCoverMinor,
				currency: exp.currency,
				durationMin: exp.durationMin,
				seatings,
			})
		}
	}

	return results
}
