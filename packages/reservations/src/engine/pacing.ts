import {
	type BookingChannel,
	type EngineServiceAvailabilityInput,
	isGuestChannel,
} from './day-state.ts'

export type EnginePacingRuleInput = {
	id?: string
	serviceId?: string
	service_id?: string
	areaId?: string | null
	area_id?: string | null
	windowStartMin?: number | null
	window_start_min?: number | null
	fromMin?: number | null
	from_min?: number | null
	windowEndMin?: number | null
	window_end_min?: number | null
	toMin?: number | null
	to_min?: number | null
	bucketMin?: number | null
	bucket_min?: number | null
	maxCoversPerSlot?: number | null
	max_covers_per_slot?: number | null
	maxCovers?: number | null
	max_covers?: number | null
	maxPartiesPerSlot?: number | null
	max_parties_per_slot?: number | null
	maxParties?: number | null
	max_parties?: number | null
	rollingMin?: number | null
	rolling_min?: number | null
	rollingMaxCovers?: number | null
	rolling_max_covers?: number | null
	maxOnlineCoversForService?: number | null
	max_online_covers_for_service?: number | null
	onlineCapPerInterval?: number | null
	online_cap_per_interval?: number | null
	concurrentCoversCap?: number | null
	concurrent_covers_cap?: number | null
	channel?: 'all' | 'online'
}

export type PacingBookingItem = {
	id: string
	serviceId?: string | null
	areaId?: string | null
	channel?: BookingChannel | string
	partySize: number
	localStartMin?: number
	startAt?: number
	endAt?: number
	status?: string
	kind?: 'reservation' | 'hold' | 'block'
}

export type PacingViolationReason =
	| 'slot_covers_exceeded'
	| 'slot_parties_exceeded'
	| 'rolling_covers_exceeded'
	| 'online_cap_per_interval_exceeded'
	| 'concurrent_covers_exceeded'
	| 'service_online_covers_exceeded'

export type PacingEvaluation = {
	allowed: boolean
	reason?: PacingViolationReason
	warnings: PacingViolationReason[]
	remainingCoversInSlot: number | null
	remainingPartiesInSlot: number | null
	remainingOnlineCoversForService: number | null
}

const INACTIVE_PACING_STATUSES = new Set([
	'requested',
	'cancelled',
	'no_show',
	'declined',
	'expired',
])

const CONCURRENT_INACTIVE_STATUSES = new Set([
	'requested',
	'cancelled',
	'no_show',
	'declined',
	'expired',
	'finished',
])

function sameBucket(
	bookingMin: number | undefined,
	slotMin: number,
	bucketMin: number | null | undefined,
): boolean {
	if (bookingMin === undefined) return false
	if (!bucketMin || bucketMin <= 1) {
		return bookingMin === slotMin
	}
	return Math.floor(bookingMin / bucketMin) === Math.floor(slotMin / bucketMin)
}

/**
 * Evaluate whether adding a party of `partySize` at `slotMin` in `serviceId`
 * (and optional `areaId`) respects all matching pacing rules, rolling windows,
 * per-interval online caps, and concurrent cover caps (`architecture.md` §6.3, `VAL-FND-006`).
 */
export function evaluatePacing(input: {
	serviceId: string
	slotMin: number
	startAt?: number
	endAt?: number
	durationMin?: number
	intervalMin?: number
	partySize: number
	channel: BookingChannel
	areaId?: string | null
	rules: readonly EnginePacingRuleInput[]
	serviceAvailability?: readonly EngineServiceAvailabilityInput[]
	serviceOnlineCapPerInterval?: number | null
	serviceConcurrentCoversCap?: number | null
	existing: readonly PacingBookingItem[]
	ignoreIds?: ReadonlySet<string>
}): PacingEvaluation {
	const activeExisting = input.existing.filter((item) => {
		if (input.ignoreIds?.has(item.id)) return false
		if (item.kind === 'block') return false
		if (item.status && INACTIVE_PACING_STATUSES.has(item.status)) return false
		return true
	})

	const warnings: PacingViolationReason[] = []
	const addWarning = (r: PacingViolationReason) => {
		if (!warnings.includes(r)) warnings.push(r)
	}

	let minRemCoversSlot: number | null = null
	let minRemPartiesSlot: number | null = null
	let minRemOnlineService: number | null = null

	const intervalMin = input.intervalMin ?? 15

	// Synthesize service-level and serviceAvailability-level caps as virtual rules
	const syntheticRules: EnginePacingRuleInput[] = []
	if (
		(input.serviceOnlineCapPerInterval !== undefined &&
			input.serviceOnlineCapPerInterval !== null) ||
		(input.serviceConcurrentCoversCap !== undefined &&
			input.serviceConcurrentCoversCap !== null)
	) {
		syntheticRules.push({
			id: '__service_caps__',
			serviceId: input.serviceId,
			bucketMin: intervalMin,
			onlineCapPerInterval: input.serviceOnlineCapPerInterval ?? null,
			concurrentCoversCap: input.serviceConcurrentCoversCap ?? null,
		})
	}

	if (input.serviceAvailability) {
		for (const sa of input.serviceAvailability) {
			const sId = sa.serviceId ?? sa.service_id
			if (sId && sId !== input.serviceId) continue
			const oCap = sa.onlineCapPerInterval ?? sa.online_cap_per_interval ?? null
			const cCap = sa.concurrentCoversCap ?? sa.concurrent_covers_cap ?? null
			if (oCap === null && cCap === null) continue
			syntheticRules.push({
				id: sa.id ?? '__sa_caps__',
				serviceId: input.serviceId,
				areaId: sa.areaId ?? sa.area_id ?? null,
				fromMin: sa.fromMin ?? sa.from_min ?? null,
				toMin: sa.toMin ?? sa.to_min ?? null,
				bucketMin: intervalMin,
				onlineCapPerInterval: oCap,
				concurrentCoversCap: cCap,
			})
		}
	}

	const allRules = [...syntheticRules, ...input.rules]

	const matchingRules = allRules.filter((r) => {
		const sId = r.serviceId ?? r.service_id
		if (sId && sId !== input.serviceId) return false
		const rArea = r.areaId ?? r.area_id ?? null
		if (rArea !== null && input.areaId && rArea !== input.areaId) {
			return false
		}
		if (rArea !== null && !input.areaId) {
			// Area-specific rule only constrains that specific area
			return false
		}
		const wStart =
			r.windowStartMin ?? r.window_start_min ?? r.fromMin ?? r.from_min ?? null
		const wEnd =
			r.windowEndMin ?? r.window_end_min ?? r.toMin ?? r.to_min ?? null
		if (wStart !== null && input.slotMin < wStart) return false
		if (wEnd !== null && input.slotMin >= wEnd) return false
		return true
	})

	if (matchingRules.length === 0) {
		return {
			allowed: true,
			warnings: [],
			remainingCoversInSlot: null,
			remainingPartiesInSlot: null,
			remainingOnlineCoversForService: null,
		}
	}

	for (const rule of matchingRules) {
		if (rule.channel === 'online' && !isGuestChannel(input.channel)) {
			// Rule applies only to online channels; still evaluate to surface staff warnings if breached
		}
		const rArea = rule.areaId ?? rule.area_id ?? null
		const bucketMin = rule.bucketMin ?? rule.bucket_min ?? null
		const maxCoversSlot =
			rule.maxCoversPerSlot ??
			rule.max_covers_per_slot ??
			rule.maxCovers ??
			rule.max_covers ??
			null
		const maxPartiesSlot =
			rule.maxPartiesPerSlot ??
			rule.max_parties_per_slot ??
			rule.maxParties ??
			rule.max_parties ??
			null
		const rollingMin = rule.rollingMin ?? rule.rolling_min ?? null
		const rollingMaxCovers =
			rule.rollingMaxCovers ?? rule.rolling_max_covers ?? null
		const maxOnlineService =
			rule.maxOnlineCoversForService ??
			rule.max_online_covers_for_service ??
			null
		const onlineCapPerInterval =
			rule.onlineCapPerInterval ?? rule.online_cap_per_interval ?? null
		const concurrentCoversCap =
			rule.concurrentCoversCap ?? rule.concurrent_covers_cap ?? null

		const scopedBookings = activeExisting.filter((b) => {
			if (b.serviceId && b.serviceId !== input.serviceId) return false
			if (rArea !== null && b.areaId !== rArea) return false
			if (rule.channel === 'online') {
				const ch = (b.channel ?? 'online') as BookingChannel
				return isGuestChannel(ch)
			}
			return true
		})

		const inSlot = scopedBookings.filter((b) =>
			sameBucket(b.localStartMin, input.slotMin, bucketMin),
		)

		const slotCovers = inSlot.reduce((sum, b) => sum + b.partySize, 0)
		const slotParties = inSlot.length

		if (maxCoversSlot !== null) {
			const rem = maxCoversSlot - slotCovers
			if (minRemCoversSlot === null || rem < minRemCoversSlot) {
				minRemCoversSlot = rem
			}
			if (slotCovers + input.partySize > maxCoversSlot) {
				addWarning('slot_covers_exceeded')
			}
		}

		if (maxPartiesSlot !== null) {
			const rem = maxPartiesSlot - slotParties
			if (minRemPartiesSlot === null || rem < minRemPartiesSlot) {
				minRemPartiesSlot = rem
			}
			if (slotParties + 1 > maxPartiesSlot) {
				addWarning('slot_parties_exceeded')
			}
		}

		if (
			rollingMin !== null &&
			rollingMin > 0 &&
			rollingMaxCovers !== null &&
			rollingMaxCovers >= 0
		) {
			const candidateStarts = new Set<number>([input.slotMin])
			for (const b of scopedBookings) {
				if (
					b.localStartMin !== undefined &&
					b.localStartMin <= input.slotMin &&
					input.slotMin < b.localStartMin + rollingMin
				) {
					candidateStarts.add(b.localStartMin)
				}
			}
			for (const wStart of candidateStarts) {
				const wEnd = wStart + rollingMin
				const windowCovers = scopedBookings
					.filter(
						(b) =>
							b.localStartMin !== undefined &&
							b.localStartMin >= wStart &&
							b.localStartMin < wEnd,
					)
					.reduce((sum, b) => sum + b.partySize, 0)
				if (windowCovers + input.partySize > rollingMaxCovers) {
					addWarning('rolling_covers_exceeded')
					break
				}
			}
		}

		if (onlineCapPerInterval !== null) {
			const capBucket = bucketMin ?? intervalMin
			const onlineInInterval = activeExisting
				.filter((b) => {
					if (b.serviceId && b.serviceId !== input.serviceId) return false
					if (rArea !== null && b.areaId !== rArea) return false
					const ch = (b.channel ?? 'online') as BookingChannel
					if (!isGuestChannel(ch)) return false
					return sameBucket(b.localStartMin, input.slotMin, capBucket)
				})
				.reduce((sum, b) => sum + b.partySize, 0)
			if (onlineInInterval + input.partySize > onlineCapPerInterval) {
				addWarning('online_cap_per_interval_exceeded')
			}
		}

		if (concurrentCoversCap !== null) {
			const durationMin = input.durationMin ?? 90
			const propStart = input.startAt ?? input.slotMin * 60_000
			const propEnd =
				input.endAt !== undefined
					? input.endAt
					: (input.slotMin + durationMin) * 60_000

			const concurrentCandidates = activeExisting.filter((b) => {
				if (b.status && CONCURRENT_INACTIVE_STATUSES.has(b.status)) return false
				if (b.serviceId && b.serviceId !== input.serviceId) return false
				if (rArea !== null && b.areaId !== rArea) return false
				const bStart =
					b.startAt ??
					(b.localStartMin !== undefined ? b.localStartMin * 60_000 : 0)
				const bEnd = b.endAt ?? bStart + durationMin * 60_000
				return bStart < propEnd && propStart < bEnd
			})

			const checkPoints = new Set<number>([propStart])
			for (const b of concurrentCandidates) {
				const bStart =
					b.startAt ??
					(b.localStartMin !== undefined ? b.localStartMin * 60_000 : 0)
				if (bStart >= propStart && bStart < propEnd) {
					checkPoints.add(bStart)
				}
			}

			for (const t of checkPoints) {
				let coversAtT = 0
				for (const b of concurrentCandidates) {
					const bStart =
						b.startAt ??
						(b.localStartMin !== undefined ? b.localStartMin * 60_000 : 0)
					const bEnd = b.endAt ?? bStart + durationMin * 60_000
					if (bStart <= t && t < bEnd) {
						coversAtT += b.partySize
					}
				}
				if (coversAtT + input.partySize > concurrentCoversCap) {
					addWarning('concurrent_covers_exceeded')
					break
				}
			}
		}

		if (maxOnlineService !== null) {
			const inServiceOnline = activeExisting.filter((b) => {
				if (b.serviceId && b.serviceId !== input.serviceId) return false
				if (rArea !== null && b.areaId !== rArea) return false
				const ch = (b.channel ?? 'online') as BookingChannel
				return isGuestChannel(ch)
			})
			const onlineCovers = inServiceOnline.reduce(
				(sum, b) => sum + b.partySize,
				0,
			)
			const rem = maxOnlineService - onlineCovers
			if (minRemOnlineService === null || rem < minRemOnlineService) {
				minRemOnlineService = rem
			}
			if (
				isGuestChannel(input.channel) &&
				onlineCovers + input.partySize > maxOnlineService
			) {
				addWarning('service_online_covers_exceeded')
			}
		}
	}

	if (warnings.length > 0) {
		return {
			allowed: false,
			reason: warnings[0],
			warnings,
			remainingCoversInSlot:
				minRemCoversSlot !== null ? Math.max(0, minRemCoversSlot) : null,
			remainingPartiesInSlot:
				minRemPartiesSlot !== null ? Math.max(0, minRemPartiesSlot) : null,
			remainingOnlineCoversForService:
				minRemOnlineService !== null ? Math.max(0, minRemOnlineService) : null,
		}
	}

	return {
		allowed: true,
		warnings: [],
		remainingCoversInSlot: minRemCoversSlot,
		remainingPartiesInSlot: minRemPartiesSlot,
		remainingOnlineCoversForService: minRemOnlineService,
	}
}
