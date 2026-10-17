import fc from 'fast-check'
import {
	type AssignBlockRecord,
	type AssignBookingRecord,
	type AssignHoldRecord,
	type AssignRequestInput,
	assignTables,
	reflowDay,
} from '../engine/assign.ts'
import {
	type EngineDayConfig,
	searchAvailability,
} from '../engine/availability.ts'
import {
	type BookingChannel,
	isBookingHardLocked,
} from '../engine/day-state.ts'
import { evaluatePacing } from '../engine/pacing.ts'
import { localToInstant } from '../time.ts'
import {
	type VerifyDayInvariantsResult,
	bruteForceAssignExists,
	verifyDayInvariants,
} from './oracle.ts'

export type RandomDayScenario = {
	config: EngineDayConfig
	businessDate: string
	nowMs: number
	existingBookings: AssignBookingRecord[]
	existingHolds: AssignHoldRecord[]
	tableBlocks: AssignBlockRecord[]
	probeRequest: AssignRequestInput & {
		businessDate: string
		slotMin: number
		durationMin: number
	}
}

const BUSINESS_DATE = '2026-06-12'
const TIME_ZONE = 'America/New_York'
const NOW_MS = localToInstant('2026-06-10', 600, TIME_ZONE).instantMs

function slotMinToMs(slotMin: number): number {
	return localToInstant(BUSINESS_DATE, slotMin, TIME_ZONE).instantMs
}

/**
 * Generate a random small restaurant day scenario (4-6 tables across 2 areas,
 * 2 combinations, 1-6 valid existing bookings, optional holds/blocks, and a probe request)
 * for `fast-check` property testing against the brute-force oracle (`VAL-FND-009`).
 */
export function arbitraryDayScenario(): fc.Arbitrary<RandomDayScenario> {
	const rawSpecArb = fc.record({
		tableSpecs: fc.array(
			fc.record({
				maxSeats: fc.constantFrom(2, 4, 6),
				combinable: fc.boolean(),
				priority: fc.integer({ min: 0, max: 20 }),
				outdoor: fc.boolean(),
			}),
			{ minLength: 4, maxLength: 6 },
		),
		rawBookings: fc.array(
			fc.record({
				slotIndex: fc.integer({ min: 0, max: 12 }), // 17:00 (1020) .. 20:00 (1200) in 15m steps
				partySize: fc.integer({ min: 1, max: 6 }),
				locked: fc.boolean(),
			}),
			{ minLength: 1, maxLength: 7 },
		),
		hasBlock: fc.boolean(),
		blockSlotIndex: fc.integer({ min: 0, max: 10 }),
		probeSlotIndex: fc.integer({ min: 0, max: 12 }),
		probePartySize: fc.integer({ min: 1, max: 6 }),
		probePreference: fc.constantFrom(
			'any',
			'indoor',
			'outdoor',
		) as fc.Arbitrary<'any' | 'indoor' | 'outdoor'>,
	})

	return rawSpecArb.map((spec) => {
		const areas = [
			{
				id: 'area_main',
				name: 'Main Dining',
				color: '#2563EB',
				isOutdoor: false,
				sortOrder: 0,
				active: true,
			},
			{
				id: 'area_patio',
				name: 'Patio',
				color: '#10B981',
				isOutdoor: true,
				sortOrder: 1,
				active: true,
			},
		]

		const tables = spec.tableSpecs.map((t, idx) => ({
			id: `t_${idx + 1}`,
			areaId: t.outdoor ? 'area_patio' : 'area_main',
			label: `T${idx + 1}`,
			minSeats: 1,
			maxSeats: t.maxSeats,
			onlineBookable: true,
			combinable: t.combinable,
			priority: t.priority,
			isPatio: t.outdoor,
			active: true,
		}))

		// Build combinations from combinable tables in the same area
		const mainCombinable = tables.filter(
			(t) => t.areaId === 'area_main' && t.combinable,
		)
		const combinations = []
		if (mainCombinable.length >= 2) {
			const cTables = [mainCombinable[0]!, mainCombinable[1]!]
			combinations.push({
				id: 'combo_main_1',
				name: 'Main Combo 1',
				minSeats: 3,
				maxSeats: cTables[0]!.maxSeats + cTables[1]!.maxSeats,
				priority: 5,
				onlineBookable: true,
				active: true,
				tableIds: [cTables[0]!.id, cTables[1]!.id].sort(),
			})
		}

		const config: EngineDayConfig = {
			timeZone: TIME_ZONE,
			settings: {
				enabled: true,
				onlineEnabled: true,
				dayStartMin: 240,
				intervalMin: 15,
				horizonDays: 30,
				releaseLocalMin: 0,
				minNoticeMin: 30,
				sameDayCutoffMin: null,
				minParty: 1,
				maxOnlineParty: 8,
				maxParty: 12,
				largePartyMode: 'request',
				seatingPreferenceMode: 'any',
				defaultTurnMin: 90,
				bufferMin: 15,
				holdTtlSec: 300,
				assignmentFreezeMin: 60,
				graceMin: 15,
				autoNoShowMin: null,
				maxActivePerPhone: 3,
				modifyCutoffMin: 120,
				waitlistEnabled: true,
				notifyMeEnabled: true,
			},
			areas,
			tables,
			combinations,
			services: [
				{
					id: 'srv_dinner',
					name: 'Dinner',
					slug: 'dinner',
					color: '#2563EB',
					daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
					startMin: 1020,
					endMin: 1380,
					lastSeatingMin: 1290,
					onlineBookable: true,
					sortOrder: 0,
					active: true,
				},
			],
			turnTimeBuckets: [],
			pacingRules: [],
			serviceTableModes: [],
			specialDays: [],
		}

		const tableBlocks: AssignBlockRecord[] = []
		if (spec.hasBlock && tables.length > 0) {
			const blkStartMin = 1020 + spec.blockSlotIndex * 15
			tableBlocks.push({
				id: 'blk_1',
				tableIds: [tables[0]!.id],
				startAt: slotMinToMs(blkStartMin),
				endAt: slotMinToMs(blkStartMin + 60),
			})
		}

		// Place valid non-conflicting existing bookings sequentially
		const existingBookings: AssignBookingRecord[] = []
		for (let i = 0; i < spec.rawBookings.length; i++) {
			const rb = spec.rawBookings[i]!
			const slotMin = 1020 + rb.slotIndex * 15
			const startAt = slotMinToMs(slotMin)
			const endAt = slotMinToMs(slotMin + 105) // 90m turn + 15m buffer

			const res = assignTables({
				config,
				request: {
					partySize: rb.partySize,
					startAt,
					endAt,
					channel: 'online',
					serviceId: 'srv_dinner',
				},
				existingBookings,
				tableBlocks,
				nowMs: NOW_MS,
				allowRepair: false,
			})
			if (res.assigned) {
				existingBookings.push({
					id: `bk_${i + 1}`,
					kind: 'reservation',
					partySize: rb.partySize,
					localStartMin: slotMin,
					startAt,
					endAt,
					tableIds: res.tableIds,
					combinationId: res.combinationId,
					status: 'confirmed',
					tableLocked: rb.locked,
					channel: 'online',
					serviceId: 'srv_dinner',
				})
			}
		}

		const probeSlotMin = 1020 + spec.probeSlotIndex * 15
		const probeStartAt = slotMinToMs(probeSlotMin)
		const probeEndAt = slotMinToMs(probeSlotMin + 105)

		return {
			config,
			businessDate: BUSINESS_DATE,
			nowMs: NOW_MS,
			existingBookings,
			existingHolds: [],
			tableBlocks,
			probeRequest: {
				businessDate: BUSINESS_DATE,
				slotMin: probeSlotMin,
				durationMin: 90,
				partySize: spec.probePartySize,
				startAt: probeStartAt,
				endAt: probeEndAt,
				channel: 'online',
				serviceId: 'srv_dinner',
				seatingPreference: spec.probePreference,
			},
		}
	})
}

export type ScaleFixtureOptions = {
	tableCount?: number
	combinationCount?: number
	bookingCount?: number
	businessDate?: string
}

/**
 * Build a deterministic high-scale restaurant fixture (default: 120 tables,
 * 80 combinations, 900 bookings/day across Lunch & Dinner) for scale and latency verification (`VAL-FND-009`).
 */
export function buildScaleRestaurantFixture(
	options: ScaleFixtureOptions = {},
): {
	config: EngineDayConfig
	businessDate: string
	nowMs: number
	existingBookings: AssignBookingRecord[]
} {
	const tableCount = options.tableCount ?? 120
	const combinationCount = options.combinationCount ?? 80
	const bookingCount = options.bookingCount ?? 900
	const businessDate = options.businessDate ?? '2026-06-12'
	const timeZone = 'America/New_York'
	const nowMs = localToInstant('2026-06-10', 540, timeZone).instantMs

	const areas = [
		{
			id: 'area_1',
			name: 'Main Room',
			color: '#2563EB',
			isOutdoor: false,
			sortOrder: 0,
			active: true,
		},
		{
			id: 'area_2',
			name: 'Mezzanine',
			color: '#7C3AED',
			isOutdoor: false,
			sortOrder: 1,
			active: true,
		},
		{
			id: 'area_3',
			name: 'Garden Patio',
			color: '#10B981',
			isOutdoor: true,
			sortOrder: 2,
			active: true,
		},
		{
			id: 'area_4',
			name: 'Bar Lounge',
			color: '#F59E0B',
			isOutdoor: false,
			sortOrder: 3,
			active: true,
		},
		{
			id: 'area_5',
			name: 'Private Dining',
			color: '#EF4444',
			isOutdoor: false,
			sortOrder: 4,
			active: true,
		},
	]

	const tables = Array.from({ length: tableCount }, (_, i) => {
		const area = areas[i % areas.length]!
		const maxSeats = i % 5 === 0 ? 6 : i % 2 === 0 ? 4 : 2
		return {
			id: `tbl_${i + 1}`,
			areaId: area.id,
			label: `T${i + 1}`,
			minSeats: 1,
			maxSeats,
			onlineBookable: true,
			combinable: true,
			priority: i % 10,
			isOutdoor: area.isOutdoor,
			isPatio: area.isOutdoor,
			isBar: area.id === 'area_4',
			active: true,
		}
	})

	// Build 80 combinations within the same area
	const combinations = []
	for (let c = 0; c < combinationCount; c++) {
		const area = areas[c % areas.length]!
		const areaTables = tables.filter((t) => t.areaId === area.id)
		const idxA = Math.floor(c / areas.length) % (areaTables.length - 1)
		const tA = areaTables[idxA]!
		const tB = areaTables[idxA + 1]!
		const tC = c >= 50 ? areaTables[(idxA + 2) % areaTables.length]! : null
		const comboTables =
			tC && tC.id !== tA.id && tC.id !== tB.id
				? [tA.id, tB.id, tC.id].sort()
				: [tA.id, tB.id].sort()
		combinations.push({
			id: `combo_${c + 1}`,
			name: `Combo ${c + 1}`,
			minSeats: 4,
			maxSeats: 10,
			priority: c % 10,
			onlineBookable: true,
			active: true,
			tableIds: comboTables,
		})
	}

	const config: EngineDayConfig = {
		timeZone,
		settings: {
			enabled: true,
			onlineEnabled: true,
			dayStartMin: 240,
			intervalMin: 15,
			horizonDays: 60,
			releaseLocalMin: 0,
			minNoticeMin: 30,
			sameDayCutoffMin: null,
			minParty: 1,
			maxOnlineParty: 8,
			maxParty: 16,
			largePartyMode: 'request',
			seatingPreferenceMode: 'any',
			defaultTurnMin: 60,
			bufferMin: 15,
			holdTtlSec: 300,
			assignmentFreezeMin: 60,
			graceMin: 15,
			autoNoShowMin: null,
			maxActivePerPhone: 3,
			modifyCutoffMin: 120,
			waitlistEnabled: true,
			notifyMeEnabled: true,
		},
		areas,
		tables,
		combinations,
		services: [
			{
				id: 'srv_lunch',
				name: 'Lunch',
				slug: 'lunch',
				color: '#10B981',
				daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
				startMin: 660, // 11:00
				endMin: 960, // 16:00
				lastSeatingMin: 900,
				onlineBookable: true,
				sortOrder: 0,
				active: true,
			},
			{
				id: 'srv_dinner',
				name: 'Dinner',
				slug: 'dinner',
				color: '#2563EB',
				daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
				startMin: 990, // 16:30
				endMin: 1410, // 23:30
				lastSeatingMin: 1350,
				onlineBookable: true,
				sortOrder: 1,
				active: true,
			},
		],
		turnTimeBuckets: [],
		pacingRules: [],
		serviceTableModes: [],
		specialDays: [],
	}

	// Deterministically pack 900 non-overlapping bookings across 120 tables * 8 seatings (960 table-turn slots)
	// Seatings at 660, 750, 840 (Lunch) and 990, 1080, 1170, 1260, 1335 (Dinner)
	const seatingSlotMins = [660, 750, 840, 990, 1080, 1170, 1260, 1335]
	const existingBookings: AssignBookingRecord[] = []

	outer: for (const slotMin of seatingSlotMins) {
		const startAt = localToInstant(businessDate, slotMin, timeZone).instantMs
		const endAt = startAt + 75 * 60_000 // 60m turn + 15m buffer
		const serviceId = slotMin < 960 ? 'srv_lunch' : 'srv_dinner'

		for (let tIdx = 0; tIdx < tables.length; tIdx++) {
			if (existingBookings.length >= bookingCount) break outer
			// Leave a few tables free in Dinner (1080, 1170, 1260) so availability, swap repair, and block reflow have candidates
			if (
				(slotMin === 1080 || slotMin === 1170 || slotMin === 1260) &&
				tIdx >= 115
			) {
				continue
			}

			const tbl = tables[tIdx]!
			existingBookings.push({
				id: `scale_bk_${existingBookings.length + 1}`,
				kind: 'reservation',
				partySize: Math.min(tbl.maxSeats, 2),
				localStartMin: slotMin,
				startAt,
				endAt,
				tableIds: [tbl.id],
				combinationId: null,
				status: 'confirmed',
				tableLocked: tIdx > 0 && existingBookings.length % 7 === 0,
				channel: 'online',
				serviceId,
				areaId: tbl.areaId,
			})
		}
	}

	return {
		config,
		businessDate,
		nowMs,
		existingBookings,
	}
}

export type OperationStepKind =
	| 'search'
	| 'hold'
	| 'book'
	| 'modify'
	| 'cancel'
	| 'seat'
	| 'finish'
	| 'no_show'
	| 'block'
	| 'settings'
	| 'clock'

export type RandomOperationStep = {
	kind: OperationStepKind
	slotIndex: number
	partySize: number
	channel: BookingChannel
	targetIndex: number
	clockDeltaMin: number
	bufferMin: 0 | 15
}

export type RandomOperationSequenceScenario = {
	initialScenario: RandomDayScenario
	steps: RandomOperationStep[]
}

export type OperationStepOracleCheck = {
	probes: number
	/** Probe requests where `assignTables` and the brute-force oracle disagree. */
	mismatches: string[]
}

export type OperationStepVerification = {
	stepIndex: number
	opKind: OperationStepKind
	invariants: VerifyDayInvariantsResult
	oracle: OperationStepOracleCheck
}

export type OperationSequenceTrace = {
	stepsExecuted: number
	stepVerifications: OperationStepVerification[]
}

export function arbitraryOperationSequence(): fc.Arbitrary<RandomOperationSequenceScenario> {
	const stepArb: fc.Arbitrary<RandomOperationStep> = fc.record({
		kind: fc.constantFrom<OperationStepKind>(
			'search',
			'hold',
			'book',
			'modify',
			'cancel',
			'seat',
			'finish',
			'no_show',
			'block',
			'settings',
			'clock',
		),
		slotIndex: fc.integer({ min: 0, max: 12 }),
		partySize: fc.integer({ min: 1, max: 6 }),
		channel: fc.constantFrom<BookingChannel>(
			'online',
			'native',
			'voice_agent',
			'phone',
			'host',
			'walk_in',
		),
		targetIndex: fc.integer({ min: 0, max: 15 }),
		clockDeltaMin: fc.integer({ min: 5, max: 30 }),
		bufferMin: fc.constantFrom<0 | 15>(0, 15),
	})

	return fc.record({
		initialScenario: arbitraryDayScenario(),
		steps: fc.array(stepArb, { minLength: 8, maxLength: 16 }),
	})
}

export function executeOperationSequence(
	seqScenario: RandomOperationSequenceScenario,
): OperationSequenceTrace {
	let config: EngineDayConfig = {
		...seqScenario.initialScenario.config,
		settings: { ...seqScenario.initialScenario.config.settings },
		tables: seqScenario.initialScenario.config.tables.map((t) => ({ ...t })),
		combinations: seqScenario.initialScenario.config.combinations.map((c) => ({
			...c,
			tableIds: [...(c.tableIds ?? [])],
		})),
	}
	let bookings: AssignBookingRecord[] =
		seqScenario.initialScenario.existingBookings.map((b) => ({
			...b,
			tableIds: [...b.tableIds],
		}))
	let holds: AssignHoldRecord[] = seqScenario.initialScenario.existingHolds.map(
		(h) => ({
			...h,
			tableIds: [...h.tableIds],
		}),
	)
	const blocks: AssignBlockRecord[] =
		seqScenario.initialScenario.tableBlocks.map((blk) => ({
			...blk,
			tableIds: blk.tableIds ? [...blk.tableIds] : undefined,
		}))
	let nowMs = seqScenario.initialScenario.nowMs
	const stepVerifications: OperationStepVerification[] = []

	const applySwaps = (
		list: AssignBookingRecord[],
		swaps: ReadonlyArray<{
			bookingId: string
			toTableIds: string[]
			toCombinationId: string | null
		}>,
	): AssignBookingRecord[] => {
		if (swaps.length === 0) return list
		const map = new Map(swaps.map((s) => [s.bookingId, s] as const))
		return list.map((b) => {
			const sw = map.get(b.id)
			if (!sw) return b
			return {
				...b,
				tableIds: [...sw.toTableIds],
				combinationId: sw.toCombinationId,
			}
		})
	}

	for (let stepIndex = 0; stepIndex < seqScenario.steps.length; stepIndex++) {
		const step = seqScenario.steps[stepIndex]!
		const previousBookings = bookings.map((b) => ({
			...b,
			tableIds: [...b.tableIds],
		}))

		// Expire holds before running the step
		holds = holds.filter(
			(h) => h.expiresAt === undefined || h.expiresAt > nowMs,
		)

		const slotMin = 1020 + step.slotIndex * 15
		const startAt = slotMinToMs(slotMin)
		const turnMin = config.settings.defaultTurnMin + config.settings.bufferMin
		const endAt = slotMinToMs(slotMin + turnMin)

		let searchedSlots:
			| ReadonlyArray<{
					slotMin: number
					startAt: number
					endAt: number
					serviceId: string
					areaId: string | null
					tableIds: readonly string[]
					combinationId: string | null
			  }>
			| undefined
		let searchHoldCheck: { failedSlots: readonly number[] } | undefined
		let failedModifyCheck:
			| {
					before: readonly AssignBookingRecord[]
					after: readonly AssignBookingRecord[]
			  }
			| undefined
		let releaseMonotonicityCheck:
			| {
					slotsBefore: readonly number[]
					slotsAfter: readonly number[]
			  }
			| undefined

		const getAvailableSlotMins = (
			currBookings: readonly AssignBookingRecord[],
			currHolds: readonly AssignHoldRecord[],
		): number[] =>
			searchAvailability({
				config,
				businessDate: seqScenario.initialScenario.businessDate,
				partySize: 2,
				channel: 'online',
				existingBookings: currBookings,
				existingHolds: currHolds,
				tableBlocks: blocks,
				nowMs,
			}).slots.map((s) => s.slotMin)

		switch (step.kind) {
			case 'search': {
				const searchRes = searchAvailability({
					config,
					businessDate: seqScenario.initialScenario.businessDate,
					partySize: step.partySize,
					preferredSlotMin: slotMin,
					channel: step.channel,
					existingBookings: bookings,
					existingHolds: holds,
					tableBlocks: blocks,
					nowMs,
				})
				searchedSlots = searchRes.slots
				const failedSlots: number[] = []
				for (const s of searchRes.slots) {
					const holdAttempt = assignTables({
						config,
						request: {
							partySize: step.partySize,
							startAt: s.startAt,
							endAt: s.endAt,
							channel: step.channel,
							serviceId: s.serviceId,
						},
						existingBookings: bookings,
						existingHolds: holds,
						tableBlocks: blocks,
						nowMs,
					})
					if (!holdAttempt.assigned) {
						failedSlots.push(s.slotMin)
					}
				}
				searchHoldCheck = { failedSlots }
				break
			}
			case 'hold': {
				const res = assignTables({
					config,
					request: {
						partySize: step.partySize,
						startAt,
						endAt,
						channel: step.channel,
						serviceId: 'srv_dinner',
					},
					existingBookings: bookings,
					existingHolds: holds,
					tableBlocks: blocks,
					nowMs,
				})
				if (res.assigned) {
					bookings = applySwaps(bookings, res.swaps)
					holds.push({
						id: `hold_step_${stepIndex}`,
						partySize: step.partySize,
						startAt,
						endAt,
						tableIds: [...res.tableIds],
						combinationId: res.combinationId,
						expiresAt: nowMs + config.settings.holdTtlSec * 1_000,
					})
				}
				break
			}
			case 'book': {
				const pace = evaluatePacing({
					serviceId: 'srv_dinner',
					slotMin,
					startAt,
					endAt,
					partySize: step.partySize,
					channel: step.channel,
					areaId: null,
					rules: config.pacingRules,
					existing: bookings.map((b) => ({
						id: b.id,
						serviceId: b.serviceId,
						areaId: b.areaId,
						channel: b.channel ?? 'online',
						partySize: b.partySize,
						localStartMin: b.localStartMin,
						startAt: b.startAt,
						endAt: b.endAt,
						status: b.status,
					})),
				})
				if (!pace.allowed) break
				const res = assignTables({
					config,
					request: {
						partySize: step.partySize,
						startAt,
						endAt,
						channel: step.channel,
						serviceId: 'srv_dinner',
					},
					existingBookings: bookings,
					existingHolds: holds,
					tableBlocks: blocks,
					nowMs,
				})
				if (res.assigned) {
					bookings = applySwaps(bookings, res.swaps)
					bookings.push({
						id: `bk_step_${stepIndex}`,
						kind: 'reservation',
						partySize: step.partySize,
						localStartMin: slotMin,
						startAt,
						endAt,
						tableIds: [...res.tableIds],
						combinationId: res.combinationId,
						status: 'confirmed',
						tableLocked: false,
						channel: step.channel,
						serviceId: 'srv_dinner',
						areaId: res.areaId,
					})
				}
				break
			}
			case 'modify': {
				const modifiable = bookings.filter(
					(b) =>
						(b.status === 'booked' || b.status === 'confirmed') &&
						!isBookingHardLocked({
							status: b.status,
							tableLocked: b.tableLocked,
							startAt: b.startAt,
							nowMs,
							assignmentFreezeMin: config.settings.assignmentFreezeMin,
						}),
				)
				if (modifiable.length > 0) {
					const target = modifiable[step.targetIndex % modifiable.length]!
					const remaining = bookings.filter((b) => b.id !== target.id)
					const res = assignTables({
						config,
						request: {
							partySize: step.partySize,
							startAt,
							endAt,
							channel: target.channel ?? 'online',
							serviceId: target.serviceId ?? 'srv_dinner',
						},
						existingBookings: remaining,
						existingHolds: holds,
						tableBlocks: blocks,
						nowMs,
					})
					if (res.assigned) {
						const swapped = applySwaps(remaining, res.swaps)
						swapped.push({
							...target,
							partySize: step.partySize,
							localStartMin: slotMin,
							startAt,
							endAt,
							tableIds: [...res.tableIds],
							combinationId: res.combinationId,
							areaId: res.areaId,
						})
						bookings = swapped
					} else {
						failedModifyCheck = {
							before: previousBookings,
							after: bookings,
						}
					}
				}
				break
			}
			case 'cancel': {
				const cancellable = bookings.filter(
					(b) => b.status === 'booked' || b.status === 'confirmed',
				)
				if (cancellable.length > 0) {
					const slotsBefore = getAvailableSlotMins(bookings, holds)
					const target = cancellable[step.targetIndex % cancellable.length]!
					bookings = bookings.map((b) =>
						b.id === target.id ? { ...b, status: 'cancelled' } : b,
					)
					const slotsAfter = getAvailableSlotMins(bookings, holds)
					releaseMonotonicityCheck = { slotsBefore, slotsAfter }
				}
				break
			}
			case 'seat': {
				const seatable = bookings.filter(
					(b) =>
						b.status === 'booked' ||
						b.status === 'confirmed' ||
						b.status === 'arrived' ||
						b.status === 'partially_arrived',
				)
				if (seatable.length > 0) {
					const target = seatable[step.targetIndex % seatable.length]!
					const nextStatus =
						target.status === 'booked' || target.status === 'confirmed'
							? 'arrived'
							: 'seated'
					bookings = bookings.map((b) =>
						b.id === target.id ? { ...b, status: nextStatus } : b,
					)
				}
				break
			}
			case 'finish': {
				const finishable = bookings.filter(
					(b) => b.status === 'seated' || b.status === 'partially_seated',
				)
				if (finishable.length > 0) {
					const slotsBefore = getAvailableSlotMins(bookings, holds)
					const target = finishable[step.targetIndex % finishable.length]!
					bookings = bookings.map((b) =>
						b.id === target.id ? { ...b, status: 'finished' } : b,
					)
					const slotsAfter = getAvailableSlotMins(bookings, holds)
					releaseMonotonicityCheck = { slotsBefore, slotsAfter }
				}
				break
			}
			case 'no_show': {
				const candidates = bookings.filter(
					(b) => b.status === 'booked' || b.status === 'confirmed',
				)
				if (candidates.length > 0) {
					const slotsBefore = getAvailableSlotMins(bookings, holds)
					const target = candidates[step.targetIndex % candidates.length]!
					bookings = bookings.map((b) =>
						b.id === target.id ? { ...b, status: 'no_show' } : b,
					)
					const slotsAfter = getAvailableSlotMins(bookings, holds)
					releaseMonotonicityCheck = { slotsBefore, slotsAfter }
				}
				break
			}
			case 'block': {
				if (config.tables.length > 0) {
					const tbl = config.tables[step.targetIndex % config.tables.length]!
					const blkStart = slotMinToMs(slotMin)
					const blkEnd = slotMinToMs(slotMin + 60)
					const hasHardConflict =
						bookings.some(
							(b) =>
								b.status !== 'cancelled' &&
								b.status !== 'no_show' &&
								b.status !== 'finished' &&
								b.tableIds.includes(tbl.id) &&
								b.startAt < blkEnd &&
								blkStart < b.endAt &&
								isBookingHardLocked({
									status: b.status,
									tableLocked: b.tableLocked,
									startAt: b.startAt,
									nowMs,
									assignmentFreezeMin: config.settings.assignmentFreezeMin,
								}),
						) ||
						holds.some(
							(h) =>
								h.tableIds.includes(tbl.id) &&
								h.startAt < blkEnd &&
								blkStart < h.endAt,
						)
					if (!hasHardConflict) {
						const candidateBlocks: AssignBlockRecord[] = [
							...blocks,
							{
								id: `blk_step_${stepIndex}`,
								tableIds: [tbl.id],
								startAt: blkStart,
								endAt: blkEnd,
							},
						]
						const reflowed = reflowDay({
							config,
							existingBookings: bookings,
							existingHolds: holds,
							tableBlocks: candidateBlocks,
							nowMs,
						})
						if (
							!reflowed.budgetExhausted &&
							reflowed.unresolvable.length === 0 &&
							reflowed.conflicts.length === 0
						) {
							blocks.push({
								id: `blk_step_${stepIndex}`,
								tableIds: [tbl.id],
								startAt: blkStart,
								endAt: blkEnd,
							})
							bookings = bookings.map((b) => {
								const assigned = reflowed.assignments.get(b.id)
								if (!assigned) return b
								return {
									...b,
									tableIds: [...assigned.tableIds],
									combinationId: assigned.combinationId,
								}
							})
						}
					}
				}
				break
			}
			case 'settings': {
				config = {
					...config,
					settings: {
						...config.settings,
						bufferMin: step.bufferMin,
					},
				}
				const reflowed = reflowDay({
					config,
					existingBookings: bookings,
					existingHolds: holds,
					tableBlocks: blocks,
					nowMs,
				})
				if (
					!reflowed.budgetExhausted &&
					reflowed.unresolvable.length === 0 &&
					reflowed.conflicts.length === 0
				) {
					bookings = bookings.map((b) => {
						const assigned = reflowed.assignments.get(b.id)
						if (!assigned) return b
						return {
							...b,
							tableIds: [...assigned.tableIds],
							combinationId: assigned.combinationId,
						}
					})
				}
				break
			}
			case 'clock': {
				nowMs += step.clockDeltaMin * 60_000
				holds = holds.filter(
					(h) => h.expiresAt === undefined || h.expiresAt > nowMs,
				)
				break
			}
		}

		const invariants = verifyDayInvariants({
			config,
			existingBookings: bookings,
			previousBookings,
			existingHolds: holds,
			tableBlocks: blocks,
			nowMs,
			searchedSlots,
			searchHoldCheck,
			failedModifyCheck,
			releaseMonotonicityCheck,
		})

		const oracle: OperationStepOracleCheck = { probes: 0, mismatches: [] }
		const probePartySizes = [step.partySize, (step.partySize % 6) + 1]
		for (const partySize of new Set(probePartySizes)) {
			const request: AssignRequestInput = {
				partySize,
				startAt,
				endAt,
				channel: step.channel,
				serviceId: 'srv_dinner',
			}
			const assigned = assignTables({
				config,
				request,
				existingBookings: bookings,
				existingHolds: holds,
				tableBlocks: blocks,
				nowMs,
			}).assigned
			const oracleHasSolution = bruteForceAssignExists({
				config,
				request,
				existingBookings: bookings,
				existingHolds: holds,
				tableBlocks: blocks,
				nowMs,
			})
			oracle.probes++
			if (assigned !== oracleHasSolution) {
				oracle.mismatches.push(
					`party ${partySize} at slot ${slotMin}: engine assigned=${assigned}, oracle=${oracleHasSolution}`,
				)
			}
		}
		stepVerifications.push({
			stepIndex,
			opKind: step.kind,
			invariants,
			oracle,
		})
	}

	return {
		stepsExecuted: seqScenario.steps.length,
		stepVerifications,
	}
}
