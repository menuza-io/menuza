import { type BookingChannel } from './day-state.ts'

export type EnginePacingRuleInput = {
	id: string
	serviceId?: string
	service_id?: string
	areaId?: string | null
	area_id?: string | null
	windowStartMin?: number | null
	window_start_min?: number | null
	windowEndMin?: number | null
	window_end_min?: number | null
	maxCoversPerSlot?: number | null
	max_covers_per_slot?: number | null
	maxPartiesPerSlot?: number | null
	max_parties_per_slot?: number | null
	maxOnlineCoversForService?: number | null
	max_online_covers_for_service?: number | null
}

export type PacingBookingItem = {
	id: string
	serviceId?: string | null
	areaId?: string | null
	channel?: BookingChannel | string
	partySize: number
	localStartMin?: number
	status?: string
	kind?: 'reservation' | 'hold' | 'block'
}

export type PacingEvaluation = {
	allowed: boolean
	reason?:
		| 'slot_covers_exceeded'
		| 'slot_parties_exceeded'
		| 'service_online_covers_exceeded'
	remainingCoversInSlot: number | null
	remainingPartiesInSlot: number | null
	remainingOnlineCoversForService: number | null
}

const INACTIVE_PACING_STATUSES = new Set([
	'cancelled',
	'no_show',
	'declined',
	'expired',
])

/**
 * Evaluate whether adding a party of `partySize` at `slotMin` in `serviceId`
 * (and optional `areaId`) respects all matching pacing rules (`architecture.md` §6.6 Invariant I6).
 */
export function evaluatePacing(input: {
	serviceId: string
	slotMin: number
	partySize: number
	channel: BookingChannel
	areaId?: string | null
	rules: readonly EnginePacingRuleInput[]
	existing: readonly PacingBookingItem[]
	ignoreIds?: ReadonlySet<string>
}): PacingEvaluation {
	const matchingRules = input.rules.filter((r) => {
		const sId = r.serviceId ?? r.service_id
		if (sId !== input.serviceId) return false
		const rArea = r.areaId ?? r.area_id ?? null
		if (rArea !== null && input.areaId && rArea !== input.areaId) {
			return false
		}
		if (rArea !== null && !input.areaId) {
			// Area-specific rule only constrains that specific area
			return false
		}
		const wStart = r.windowStartMin ?? r.window_start_min ?? null
		const wEnd = r.windowEndMin ?? r.window_end_min ?? null
		if (wStart !== null && input.slotMin < wStart) return false
		if (wEnd !== null && input.slotMin >= wEnd) return false
		return true
	})

	if (matchingRules.length === 0) {
		return {
			allowed: true,
			remainingCoversInSlot: null,
			remainingPartiesInSlot: null,
			remainingOnlineCoversForService: null,
		}
	}

	const activeExisting = input.existing.filter((item) => {
		if (input.ignoreIds?.has(item.id)) return false
		if (item.kind === 'block') return false
		if (item.status && INACTIVE_PACING_STATUSES.has(item.status)) return false
		return true
	})

	let minRemCoversSlot: number | null = null
	let minRemPartiesSlot: number | null = null
	let minRemOnlineService: number | null = null

	for (const rule of matchingRules) {
		const rArea = rule.areaId ?? rule.area_id ?? null
		const maxCoversSlot =
			rule.maxCoversPerSlot ?? rule.max_covers_per_slot ?? null
		const maxPartiesSlot =
			rule.maxPartiesPerSlot ?? rule.max_parties_per_slot ?? null
		const maxOnlineService =
			rule.maxOnlineCoversForService ??
			rule.max_online_covers_for_service ??
			null

		const inSlot = activeExisting.filter((b) => {
			if (b.serviceId && b.serviceId !== input.serviceId) return false
			if (b.localStartMin !== input.slotMin) return false
			if (rArea !== null && b.areaId !== rArea) return false
			return true
		})

		const slotCovers = inSlot.reduce((sum, b) => sum + b.partySize, 0)
		const slotParties = inSlot.length

		if (maxCoversSlot !== null) {
			const rem = maxCoversSlot - slotCovers
			if (minRemCoversSlot === null || rem < minRemCoversSlot) {
				minRemCoversSlot = rem
			}
			if (slotCovers + input.partySize > maxCoversSlot) {
				return {
					allowed: false,
					reason: 'slot_covers_exceeded',
					remainingCoversInSlot: Math.max(0, rem),
					remainingPartiesInSlot: minRemPartiesSlot,
					remainingOnlineCoversForService: minRemOnlineService,
				}
			}
		}

		if (maxPartiesSlot !== null) {
			const rem = maxPartiesSlot - slotParties
			if (minRemPartiesSlot === null || rem < minRemPartiesSlot) {
				minRemPartiesSlot = rem
			}
			if (slotParties + 1 > maxPartiesSlot) {
				return {
					allowed: false,
					reason: 'slot_parties_exceeded',
					remainingCoversInSlot: minRemCoversSlot,
					remainingPartiesInSlot: Math.max(0, rem),
					remainingOnlineCoversForService: minRemOnlineService,
				}
			}
		}

		if (
			maxOnlineService !== null &&
			(input.channel === 'online' || input.channel === 'voice')
		) {
			const inServiceOnline = activeExisting.filter((b) => {
				if (b.serviceId && b.serviceId !== input.serviceId) return false
				if (rArea !== null && b.areaId !== rArea) return false
				const ch = b.channel ?? 'online'
				return ch === 'online' || ch === 'voice'
			})
			const onlineCovers = inServiceOnline.reduce(
				(sum, b) => sum + b.partySize,
				0,
			)
			const rem = maxOnlineService - onlineCovers
			if (minRemOnlineService === null || rem < minRemOnlineService) {
				minRemOnlineService = rem
			}
			if (onlineCovers + input.partySize > maxOnlineService) {
				return {
					allowed: false,
					reason: 'service_online_covers_exceeded',
					remainingCoversInSlot: minRemCoversSlot,
					remainingPartiesInSlot: minRemPartiesSlot,
					remainingOnlineCoversForService: Math.max(0, rem),
				}
			}
		}
	}

	return {
		allowed: true,
		remainingCoversInSlot: minRemCoversSlot,
		remainingPartiesInSlot: minRemPartiesSlot,
		remainingOnlineCoversForService: minRemOnlineService,
	}
}
