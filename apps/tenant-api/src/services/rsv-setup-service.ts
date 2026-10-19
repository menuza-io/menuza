import { randomUUID } from 'node:crypto'
import {
	assignTables,
	currentBusinessDate,
	detectConflicts,
	isValidTimeZone,
	localToInstant,
	policyRequiresPayment,
	reflowDay,
	resolveServices,
	businessDateOf,
	validateConfig,
	validateLocationHoursSetup,
	type AssignBlockRecord,
	type AssignBookingRecord,
	type AssignHoldRecord,
	type ConflictItem,
	type ConfigValidationIssue,
	type EngineAreaInput,
	type EngineCombinationInput,
	type EnginePacingRuleInput,
	type EngineServiceAvailabilityInput,
	type EngineTableInput,
	type LocationHours,
	type LocationHoursIssueInfo,
	type TableSwap,
} from '@repo/reservations'
import {
	rsvAreas,
	rsvAuditLog,
	rsvBlocks,
	rsvDayVersions,
	rsvExperiences,
	rsvFloorElements,
	rsvHolds,
	rsvLocationSettings,
	rsvPacingRules,
	rsvPolicies,
	rsvReservationEvents,
	rsvReservations,
	rsvServiceAvailability,
	rsvServices,
	rsvSpecialDays,
	rsvTableComboMembers,
	rsvTableCombos,
	rsvTableOccupancies,
	rsvTables,
	rsvTurnTimes,
	type TenantDatabase,
} from '@repo/tenant-db'
import { addDays } from '@repo/zoned-time'
import { and, asc, eq, gte, inArray, isNull, sql } from 'drizzle-orm'
import { queryInChunks } from '../lib/chunked-in.ts'
import { withSetupWrite } from '../lib/reservations-write.ts'
import { badRequest, conflict, notFound } from '../lib/http.js'
import { getReservationsContext } from '../lib/reservations-context.js'
import { locationHoursFromContext } from './rsv-location-hours.ts'

export type ReflowMove = TableSwap & {
	reservationId?: string
	toComboId?: string | null
}

const ACTIVE_RESERVATION_STATUSES = [
	'pending_payment',
	'pending_approval',
	'booked',
	'confirmed',
	'arrived',
	'partially_seated',
	'seated',
] as const

const SOFT_REFLOWABLE_STATUSES = new Set([
	'pending_payment',
	'pending_approval',
	'booked',
	'confirmed',
])

export function serializeSettings(
	row: typeof rsvLocationSettings.$inferSelect,
	extra?: { contextTimeZone?: string | null; tzMismatch?: boolean },
) {
	const contextTimeZone = extra?.contextTimeZone ?? row.timeZone
	const tzMismatch =
		extra?.tzMismatch ??
		Boolean(contextTimeZone && row.timeZone && contextTimeZone !== row.timeZone)
	return {
		...row,
		location_id: row.locationId,
		online_enabled: row.onlineEnabled,
		time_zone: row.timeZone,
		tz_synced_at: row.tzSyncedAt,
		day_start_min: row.dayStartMin,
		interval_min: row.intervalMin,
		horizon_days: row.horizonDays,
		release_local_min: row.releaseLocalMin,
		min_notice_min: row.minNoticeMin,
		same_day_cutoff_min: row.sameDayCutoffMin,
		online_party_min: row.onlinePartyMin,
		online_party_max: row.onlinePartyMax,
		party_max: row.partyMax,
		large_party_mode: row.largePartyMode,
		large_party_note_i18n: row.largePartyNoteI18n ?? {},
		request_holds_capacity: row.requestHoldsCapacity,
		request_deadline_hours: row.requestDeadlineHours,
		seating_pref_mode: row.seatingPrefMode,
		hold_minutes: row.holdMinutes,
		payment_hold_minutes: row.paymentHoldMinutes,
		voice_hold_minutes: row.voiceHoldMinutes,
		voice_mode: row.voiceMode,
		freeze_min: row.freezeMin,
		late_grace_min: row.lateGraceMin,
		auto_no_show_after_min: row.autoNoShowAfterMin,
		max_active_per_phone: row.maxActivePerPhone,
		block_same_phone_overlap: row.blockSamePhoneOverlap,
		guest_modify_cutoff_min: row.guestModifyCutoffMin,
		contact_statuses_enabled: row.contactStatusesEnabled,
		course_statuses_enabled: row.courseStatusesEnabled,
		default_policy_id: row.defaultPolicyId,
		waitlist_enabled: row.waitlistEnabled,
		waitlist_online: row.waitlistOnline,
		notify_me_enabled: row.notifyMeEnabled,
		waitlist_response_min: row.waitlistResponseMin,
		waitlist_max_parties: row.waitlistMaxParties,
		public_note_i18n: row.publicNoteI18n ?? {},
		contact_phone: row.contactPhone,
		floor_plan_version: row.floorPlanVersion,
		updated_at: row.updatedAt,
		updated_by: row.updatedBy,
		contextTimeZone,
		context_time_zone: contextTimeZone,
		tzMismatch,
		tz_mismatch: tzMismatch,
	}
}

export function serializeArea(row: typeof rsvAreas.$inferSelect) {
	return {
		...row,
		location_id: row.locationId,
		name_i18n: row.nameI18n ?? {},
		online_bookable: row.onlineBookable,
		guest_selectable: row.guestSelectable,
		canvas_w: row.canvasW,
		canvas_h: row.canvasH,
		archived_at: row.archivedAt,
		created_at: row.createdAt,
		updated_at: row.updatedAt,
	}
}

export function serializeTable(row: typeof rsvTables.$inferSelect) {
	return {
		...row,
		location_id: row.locationId,
		area_id: row.areaId,
		min_covers: row.minCovers,
		max_covers: row.maxCovers,
		online_bookable: row.onlineBookable,
		reset_buffer_min: row.resetBufferMin,
		archived_at: row.archivedAt,
		created_at: row.createdAt,
		updated_at: row.updatedAt,
	}
}

export function serializeCombo(
	row: typeof rsvTableCombos.$inferSelect,
	tableIds: string[],
) {
	return {
		...row,
		location_id: row.locationId,
		min_covers: row.minCovers,
		max_covers: row.maxCovers,
		online_bookable: row.onlineBookable,
		archived_at: row.archivedAt,
		created_at: row.createdAt,
		updated_at: row.updatedAt,
		tableIds,
		table_ids: tableIds,
	}
}

export function serializeElement(row: typeof rsvFloorElements.$inferSelect) {
	return {
		...row,
		area_id: row.areaId,
	}
}

export function serializeService(row: typeof rsvServices.$inferSelect) {
	return {
		...row,
		location_id: row.locationId,
		name_i18n: row.nameI18n ?? {},
		days_mask: row.daysMask,
		first_seating_min: row.firstSeatingMin,
		last_seating_min: row.lastSeatingMin,
		end_min: row.endMin,
		interval_min: row.intervalMin,
		effective_from: row.effectiveFrom,
		effective_to: row.effectiveTo,
		special_day_id: row.specialDayId,
		online_enabled: row.onlineEnabled,
		online_from_min: row.onlineFromMin,
		online_to_min: row.onlineToMin,
		max_party: row.maxParty,
		online_party_max: row.onlinePartyMax,
		online_cap_per_interval: row.onlineCapPerInterval,
		concurrent_covers_cap: row.concurrentCoversCap,
		policy_id: row.policyId,
		section_layout_id: row.sectionLayoutId,
		allow_overrun_past_end: row.allowOverrunPastEnd,
		color_token: row.colorToken,
		archived_at: row.archivedAt,
	}
}

export function serializeTurnTime(row: typeof rsvTurnTimes.$inferSelect) {
	return {
		...row,
		location_id: row.locationId,
		service_id: row.serviceId,
		party_min: row.partyMin,
		party_max: row.partyMax,
		days_mask: row.daysMask,
	}
}

export function serializePacingRule(row: typeof rsvPacingRules.$inferSelect) {
	return {
		...row,
		service_id: row.serviceId,
		from_min: row.fromMin,
		to_min: row.toMin,
		bucket_min: row.bucketMin,
		max_covers: row.maxCovers,
		max_parties: row.maxParties,
		rolling_min: row.rollingMin,
		rolling_max_covers: row.rollingMaxCovers,
	}
}

export function serializeServiceAvailability(
	row: typeof rsvServiceAvailability.$inferSelect,
) {
	return {
		...row,
		service_id: row.serviceId,
		area_id: row.areaId,
		table_id: row.tableId,
		combo_id: row.comboId,
		from_min: row.fromMin,
		to_min: row.toMin,
	}
}

export function serializeSpecialDay(row: typeof rsvSpecialDays.$inferSelect) {
	return {
		...row,
		location_id: row.locationId,
		from_date: row.fromDate,
		to_date: row.toDate,
		service_id: row.serviceId,
		public_note_i18n: row.publicNoteI18n ?? {},
		created_by: row.createdBy,
		created_at: row.createdAt,
	}
}

export function serializeBlock(row: typeof rsvBlocks.$inferSelect) {
	return {
		...row,
		location_id: row.locationId,
		table_id: row.tableId,
		area_id: row.areaId,
		business_date: row.businessDate,
		start_at: row.startAt,
		end_at: row.endAt,
		created_by: row.createdBy,
		created_at: row.createdAt,
	}
}

export async function bumpDayVersion(
	db: TenantDatabase,
	locationId: string,
	businessDate: string,
) {
	const now = Date.now()
	await db
		.insert(rsvDayVersions)
		.values({
			locationId,
			businessDate,
			version: 1,
			updatedAt: now,
		})
		.onConflictDoUpdate({
			target: [rsvDayVersions.locationId, rsvDayVersions.businessDate],
			set: {
				version: sql`${rsvDayVersions.version} + 1`,
				updatedAt: now,
			},
		})
}

export async function writeSetupAuditLog(
	db: TenantDatabase,
	params: {
		actorId: string
		locationId: string
		action: string
		entityType: string
		entityId: string
		changes?: Record<string, unknown>
	},
) {
	await db.insert(rsvAuditLog).values({
		id: `aud_${randomUUID()}`,
		at: Date.now(),
		actorKind: 'operator',
		actorId: params.actorId,
		locationId: params.locationId,
		action: params.action,
		entityType: params.entityType,
		entityId: params.entityId,
		changes: params.changes ?? {},
	})
}

export async function resolveContextLocationTimeZone(
	orgId: string,
	locationId: string,
): Promise<string | null> {
	try {
		const ctx = await getReservationsContext(orgId)
		const loc = ctx?.locations.find((l) => l.id === locationId)
		if (loc?.timeZone && isValidTimeZone(loc.timeZone)) {
			return loc.timeZone
		}
	} catch {
		// Fall back if control plane is unreachable
	}
	return null
}

export async function ensureLocationSettingsRow(
	db: TenantDatabase,
	orgId: string,
	locationId: string,
) {
	const existing = await db
		.select()
		.from(rsvLocationSettings)
		.where(eq(rsvLocationSettings.locationId, locationId))
		.get()
	if (existing) return existing

	const ctxTz = await resolveContextLocationTimeZone(orgId, locationId)
	const now = Date.now()
	await db
		.insert(rsvLocationSettings)
		.values({
			locationId,
			enabled: true,
			onlineEnabled: false,
			timeZone: ctxTz ?? 'UTC',
			tzSyncedAt: now,
			currency: 'USD',
			version: 1,
			floorPlanVersion: 1,
			updatedAt: now,
		})
		.onConflictDoNothing()

	const created = await db
		.select()
		.from(rsvLocationSettings)
		.where(eq(rsvLocationSettings.locationId, locationId))
		.get()
	if (!created) throw notFound()
	return created
}

export async function getLocationSettingsWithContext(
	db: TenantDatabase,
	orgId: string,
	locationId: string,
) {
	const row = await ensureLocationSettingsRow(db, orgId, locationId)
	const contextTimeZone = await resolveContextLocationTimeZone(
		orgId,
		locationId,
	)
	const effectiveContextTz = contextTimeZone ?? row.timeZone
	const tzMismatch = Boolean(
		contextTimeZone && row.timeZone && contextTimeZone !== row.timeZone,
	)
	return serializeSettings(row, {
		contextTimeZone: effectiveContextTz,
		tzMismatch,
	})
}

type PolicyReader = Pick<TenantDatabase, 'select'>

/**
 * Whether any policy that applies at the location (its default, or one on a
 * service or experience) takes a deposit, a prepayment or a card guarantee.
 */
export async function locationUsesPaymentPolicy(
	tx: PolicyReader,
	locationId: string,
	defaultPolicyId: string | null,
): Promise<boolean> {
	const [serviceRows, experienceRows] = await Promise.all([
		tx
			.select({ policyId: rsvServices.policyId })
			.from(rsvServices)
			.where(eq(rsvServices.locationId, locationId))
			.all(),
		tx
			.select({ policyId: rsvExperiences.policyId })
			.from(rsvExperiences)
			.where(eq(rsvExperiences.locationId, locationId))
			.all(),
	])
	const ids = new Set<string>()
	if (defaultPolicyId) ids.add(defaultPolicyId)
	for (const row of [...serviceRows, ...experienceRows]) {
		if (row.policyId) ids.add(row.policyId)
	}
	if (ids.size === 0) return false
	const policies = await queryInChunks([...ids], (chunk) =>
		tx
			.select({ kind: rsvPolicies.kind })
			.from(rsvPolicies)
			.where(
				and(
					inArray(rsvPolicies.id, chunk),
					eq(rsvPolicies.locationId, locationId),
					isNull(rsvPolicies.archivedAt),
				),
			)
			.all(),
	)
	return policies.some((policy) => policyRequiresPayment(policy.kind))
}

export type UpdateLocationSettingsPatch = {
	expectedVersion?: number
	enabled?: boolean
	onlineEnabled?: boolean
	waitlistEnabled?: boolean
	waitlistOnline?: boolean
	notifyMeEnabled?: boolean
	timeZone?: string
	currency?: string
	dayStartMin?: number
	intervalMin?: 5 | 10 | 15 | 20 | 30 | 60
	horizonDays?: number
	releaseLocalMin?: number | null
	minNoticeMin?: number
	sameDayCutoffMin?: number | null
	onlinePartyMin?: number
	onlinePartyMax?: number
	partyMax?: number
	largePartyMode?: 'contact' | 'request' | 'disabled' | 'call_only'
	largePartyNoteI18n?: Record<string, string> | null
	requestHoldsCapacity?: boolean
	requestDeadlineHours?: number
	contactPhone?: string | null
	publicNoteI18n?: Record<string, string> | null
	seatingPrefMode?: 'off' | 'preferred' | 'strict' | 'preference'
	holdMinutes?: number
	paymentHoldMinutes?: number
	voiceHoldMinutes?: number
	voiceMode?: 'hold_link' | 'confirm_on_call'
	freezeMin?: number
	lateGraceMin?: number
	autoNoShowAfterMin?: number | null
	maxActivePerPhone?: number
	blockSamePhoneOverlap?: boolean
	guestModifyCutoffMin?: number
	contactStatusesEnabled?: boolean
	courseStatusesEnabled?: boolean
	defaultPolicyId?: string | null
	waitlistResponseMin?: number
	waitlistMaxParties?: number | null
}

export async function updateLocationSettings(
	db: TenantDatabase,
	orgId: string,
	locationId: string,
	actorId: string,
	patch: UpdateLocationSettingsPatch,
) {
	return withSetupWrite(
		db,
		async (db) => {
			if (
				patch.holdMinutes !== undefined &&
				(patch.holdMinutes < 3 || patch.holdMinutes > 20)
			) {
				throw badRequest('invalid', 'invalid', {
					fields: ['holdMinutes'],
					issues: [{ path: 'holdMinutes', code: 'out_of_range' }],
				})
			}
			if (
				patch.paymentHoldMinutes !== undefined &&
				(patch.paymentHoldMinutes < 10 || patch.paymentHoldMinutes > 60)
			) {
				throw badRequest('invalid', 'invalid', {
					fields: ['paymentHoldMinutes'],
					issues: [{ path: 'paymentHoldMinutes', code: 'out_of_range' }],
				})
			}
			if (
				patch.voiceHoldMinutes !== undefined &&
				(patch.voiceHoldMinutes < 5 || patch.voiceHoldMinutes > 30)
			) {
				throw badRequest('invalid', 'invalid', {
					fields: ['voiceHoldMinutes'],
					issues: [{ path: 'voiceHoldMinutes', code: 'out_of_range' }],
				})
			}

			const current = await ensureLocationSettingsRow(db, orgId, locationId)

			if (
				patch.expectedVersion !== undefined &&
				patch.expectedVersion !== current.version
			) {
				const serializedCurrent = await getLocationSettingsWithContext(
					db,
					orgId,
					locationId,
				)
				throw conflict('stale_version', 'stale_version', {
					current: serializedCurrent,
					settings: serializedCurrent,
					version: current.version,
				})
			}

			if (
				patch.voiceMode === 'confirm_on_call' &&
				(await locationUsesPaymentPolicy(
					db,
					locationId,
					patch.defaultPolicyId !== undefined
						? patch.defaultPolicyId
						: current.defaultPolicyId,
				))
			) {
				// Booking on the call cannot take a deposit or a card.
				throw badRequest('invalid', 'invalid', {
					fields: ['voiceMode'],
					issues: [{ path: 'voiceMode', code: 'payment_policy_active' }],
				})
			}

			if (patch.timeZone !== undefined && !isValidTimeZone(patch.timeZone)) {
				throw badRequest('invalid', 'invalid', {
					fields: ['timeZone'],
					issues: [{ path: 'timeZone', code: 'invalid_time_zone' }],
				})
			}

			const mergedOnlinePartyMin =
				patch.onlinePartyMin ?? current.onlinePartyMin
			const mergedOnlinePartyMax =
				patch.onlinePartyMax ?? current.onlinePartyMax
			const mergedPartyMax = patch.partyMax ?? current.partyMax

			if (
				mergedOnlinePartyMin > mergedOnlinePartyMax ||
				mergedOnlinePartyMax > mergedPartyMax
			) {
				throw badRequest('invalid', 'invalid', {
					fields: ['onlinePartyMin', 'onlinePartyMax', 'partyMax'],
					issues: [
						{
							path: 'onlinePartyMax',
							code: 'invalid_party_bounds',
						},
					],
				})
			}

			const now = Date.now()
			const nextVersion = current.version + 1

			await db
				.update(rsvLocationSettings)
				.set({
					...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
					...(patch.onlineEnabled !== undefined
						? { onlineEnabled: patch.onlineEnabled }
						: {}),
					...(patch.waitlistEnabled !== undefined
						? { waitlistEnabled: patch.waitlistEnabled }
						: {}),
					...(patch.waitlistOnline !== undefined
						? { waitlistOnline: patch.waitlistOnline }
						: {}),
					...(patch.notifyMeEnabled !== undefined
						? { notifyMeEnabled: patch.notifyMeEnabled }
						: {}),
					...(patch.timeZone !== undefined
						? { timeZone: patch.timeZone, tzSyncedAt: now }
						: {}),
					...(patch.currency !== undefined ? { currency: patch.currency } : {}),
					...(patch.dayStartMin !== undefined
						? { dayStartMin: patch.dayStartMin }
						: {}),
					...(patch.intervalMin !== undefined
						? { intervalMin: patch.intervalMin }
						: {}),
					...(patch.horizonDays !== undefined
						? { horizonDays: patch.horizonDays }
						: {}),
					...(patch.releaseLocalMin !== undefined
						? { releaseLocalMin: patch.releaseLocalMin }
						: {}),
					...(patch.minNoticeMin !== undefined
						? { minNoticeMin: patch.minNoticeMin }
						: {}),
					...(patch.sameDayCutoffMin !== undefined
						? { sameDayCutoffMin: patch.sameDayCutoffMin }
						: {}),
					...(patch.onlinePartyMin !== undefined
						? { onlinePartyMin: patch.onlinePartyMin }
						: {}),
					...(patch.onlinePartyMax !== undefined
						? { onlinePartyMax: patch.onlinePartyMax }
						: {}),
					...(patch.partyMax !== undefined ? { partyMax: patch.partyMax } : {}),
					...(patch.largePartyMode !== undefined
						? { largePartyMode: patch.largePartyMode }
						: {}),
					...(patch.largePartyNoteI18n !== undefined
						? { largePartyNoteI18n: patch.largePartyNoteI18n ?? {} }
						: {}),
					...(patch.requestHoldsCapacity !== undefined
						? { requestHoldsCapacity: patch.requestHoldsCapacity }
						: {}),
					...(patch.requestDeadlineHours !== undefined
						? { requestDeadlineHours: patch.requestDeadlineHours }
						: {}),
					...(patch.contactPhone !== undefined
						? { contactPhone: patch.contactPhone }
						: {}),
					...(patch.publicNoteI18n !== undefined
						? { publicNoteI18n: patch.publicNoteI18n ?? {} }
						: {}),
					...(patch.seatingPrefMode !== undefined
						? { seatingPrefMode: patch.seatingPrefMode }
						: {}),
					...(patch.holdMinutes !== undefined
						? { holdMinutes: patch.holdMinutes }
						: {}),
					...(patch.paymentHoldMinutes !== undefined
						? { paymentHoldMinutes: patch.paymentHoldMinutes }
						: {}),
					...(patch.voiceHoldMinutes !== undefined
						? { voiceHoldMinutes: patch.voiceHoldMinutes }
						: {}),
					...(patch.voiceMode !== undefined
						? { voiceMode: patch.voiceMode }
						: {}),
					...(patch.freezeMin !== undefined
						? { freezeMin: patch.freezeMin }
						: {}),
					...(patch.lateGraceMin !== undefined
						? { lateGraceMin: patch.lateGraceMin }
						: {}),
					...(patch.autoNoShowAfterMin !== undefined
						? { autoNoShowAfterMin: patch.autoNoShowAfterMin }
						: {}),
					...(patch.maxActivePerPhone !== undefined
						? { maxActivePerPhone: patch.maxActivePerPhone }
						: {}),
					...(patch.blockSamePhoneOverlap !== undefined
						? { blockSamePhoneOverlap: patch.blockSamePhoneOverlap }
						: {}),
					...(patch.guestModifyCutoffMin !== undefined
						? { guestModifyCutoffMin: patch.guestModifyCutoffMin }
						: {}),
					...(patch.contactStatusesEnabled !== undefined
						? { contactStatusesEnabled: patch.contactStatusesEnabled }
						: {}),
					...(patch.courseStatusesEnabled !== undefined
						? { courseStatusesEnabled: patch.courseStatusesEnabled }
						: {}),
					...(patch.defaultPolicyId !== undefined
						? { defaultPolicyId: patch.defaultPolicyId }
						: {}),
					...(patch.waitlistResponseMin !== undefined
						? { waitlistResponseMin: patch.waitlistResponseMin }
						: {}),
					...(patch.waitlistMaxParties !== undefined
						? { waitlistMaxParties: patch.waitlistMaxParties }
						: {}),
					version: nextVersion,
					updatedAt: now,
					updatedBy: actorId,
				})
				.where(eq(rsvLocationSettings.locationId, locationId))

			await writeSetupAuditLog(db, {
				actorId,
				locationId,
				action: 'settings.update',
				entityType: 'location_settings',
				entityId: locationId,
				changes: { version: nextVersion },
			})

			return getLocationSettingsWithContext(db, orgId, locationId)
		},
		orgId,
	)
}

export async function listCombosForLocation(
	db: TenantDatabase,
	locationId: string,
	includeArchived = false,
) {
	const combos = await db
		.select()
		.from(rsvTableCombos)
		.where(
			includeArchived
				? eq(rsvTableCombos.locationId, locationId)
				: and(
						eq(rsvTableCombos.locationId, locationId),
						isNull(rsvTableCombos.archivedAt),
					),
		)
		.orderBy(asc(rsvTableCombos.label))
		.all()

	if (combos.length === 0) return []

	const members = await queryInChunks(
		combos.map((c) => c.id),
		(chunk) =>
			db
				.select()
				.from(rsvTableComboMembers)
				.where(inArray(rsvTableComboMembers.comboId, chunk))
				.all(),
	)

	const membersByCombo = new Map<string, string[]>()
	for (const m of members) {
		const list = membersByCombo.get(m.comboId) ?? []
		list.push(m.tableId)
		membersByCombo.set(m.comboId, list)
	}

	return combos.map((combo) =>
		serializeCombo(combo, (membersByCombo.get(combo.id) ?? []).slice().sort()),
	)
}

/**
 * Unassigns and reflows soft future reservations affected by table archive,
 * capacity shrink, or block creation, and computes `detectConflicts` across
 * upcoming business dates.
 */
export async function reflowFutureBookingsForLocation(
	db: TenantDatabase,
	locationId: string,
	opts?: {
		affectedDates?: string[]
		invalidatedTableIds?: string[]
		preDeactivatedOriginalTables?: Map<string, string[]>
		skipExplicitDayVersionBump?: boolean
		/** Compute moves and conflicts against an in-memory copy; nothing is written. */
		dryRun?: boolean
	},
): Promise<{ conflicts: ConflictItem[]; reflowedMoves: ReflowMove[] }> {
	const settings = await db
		.select()
		.from(rsvLocationSettings)
		.where(eq(rsvLocationSettings.locationId, locationId))
		.get()
	const timeZone = settings?.timeZone ?? 'UTC'
	const nowMs = Date.now()
	const dryRun = opts?.dryRun === true
	const today = currentBusinessDate(
		nowMs,
		isValidTimeZone(timeZone) ? timeZone : 'UTC',
		settings?.dayStartMin ?? 240,
	)

	const allAreas = await db
		.select()
		.from(rsvAreas)
		.where(eq(rsvAreas.locationId, locationId))
		.all()
	const allTables = await db
		.select()
		.from(rsvTables)
		.where(eq(rsvTables.locationId, locationId))
		.all()
	const activeCombos = await listCombosForLocation(db, locationId, false)
	const allServices = await db
		.select()
		.from(rsvServices)
		.where(
			and(
				eq(rsvServices.locationId, locationId),
				isNull(rsvServices.archivedAt),
			),
		)
		.all()
	const serviceIds = allServices.map((s) => s.id)
	const allPacing = await queryInChunks(serviceIds, (chunk) =>
		db
			.select()
			.from(rsvPacingRules)
			.where(inArray(rsvPacingRules.serviceId, chunk))
			.all(),
	)
	const allServiceAvail = await queryInChunks(serviceIds, (chunk) =>
		db
			.select()
			.from(rsvServiceAvailability)
			.where(inArray(rsvServiceAvailability.serviceId, chunk))
			.all(),
	)
	const allSpecialDays = await db
		.select()
		.from(rsvSpecialDays)
		.where(eq(rsvSpecialDays.locationId, locationId))
		.all()

	const areaById = new Map(allAreas.map((a) => [a.id, a]))
	const tableById = new Map(allTables.map((t) => [t.id, t]))
	const comboById = new Map(activeCombos.map((c) => [c.id, c]))

	const upcomingReservations = await db
		.select()
		.from(rsvReservations)
		.where(
			and(
				eq(rsvReservations.locationId, locationId),
				gte(rsvReservations.businessDate, today),
				inArray(rsvReservations.status, [...ACTIVE_RESERVATION_STATUSES]),
			),
		)
		.all()

	const explicitDatesSet = new Set<string>(opts?.affectedDates ?? [])
	const datesSet = new Set<string>(explicitDatesSet)
	for (const r of upcomingReservations) {
		datesSet.add(r.businessDate)
	}

	const invalidatedSet = new Set<string>(opts?.invalidatedTableIds ?? [])
	const reflowedMoves: ReflowMove[] = []
	const allConflicts: ConflictItem[] = []

	const engineAreas: EngineAreaInput[] = allAreas.map((a) => ({
		id: a.id,
		name: a.name,
		sortOrder: a.sort,
		active: a.archivedAt === null,
	}))

	const engineTables: EngineTableInput[] = allTables.map((t) => {
		const area = areaById.get(t.areaId)
		const areaActive = area ? area.archivedAt === null : true
		const areaOnline = area ? area.onlineBookable : true
		return {
			id: t.id,
			areaId: t.areaId,
			label: t.label,
			minSeats: t.minCovers,
			maxSeats: t.maxCovers,
			minCovers: t.minCovers,
			maxCovers: t.maxCovers,
			onlineBookable: t.onlineBookable && areaOnline,
			combinable: t.combinable,
			priority: t.priority,
			resetBufferMin: t.resetBufferMin,
			active: t.archivedAt === null && areaActive,
		}
	})

	const engineCombos: EngineCombinationInput[] = activeCombos.map((c) => ({
		id: c.id,
		name: c.label,
		label: c.label,
		minSeats: c.minCovers,
		maxSeats: c.maxCovers,
		minCovers: c.minCovers,
		maxCovers: c.maxCovers,
		onlineBookable: c.onlineBookable,
		priority: c.priority,
		active: c.archivedAt === null,
		tableIds: c.tableIds,
	}))

	const engineServiceAvail: EngineServiceAvailabilityInput[] =
		allServiceAvail.map((sa) => ({
			id: sa.id,
			serviceId: sa.serviceId,
			areaId: sa.areaId,
			tableId: sa.tableId,
			combinationId: sa.comboId,
			fromMin: sa.fromMin,
			toMin: sa.toMin,
			mode: sa.mode as 'online' | 'staff_only' | 'walk_in_only' | 'unavailable',
		}))

	const enginePacingRules: EnginePacingRuleInput[] = allPacing.map((p) => ({
		id: p.id,
		serviceId: p.serviceId,
		windowMinutes: p.bucketMin,
		fromMin: p.fromMin,
		toMin: p.toMin,
		maxCoversPerSlot: p.maxCovers,
		maxPartiesPerSlot: p.maxParties,
		rollingMin: p.rollingMin,
		rollingMaxCovers: p.rollingMaxCovers,
		channelScope: p.channel as 'all' | 'online',
	}))

	for (const businessDate of [...datesSet].sort()) {
		const dayResRows = upcomingReservations.filter(
			(r) => r.businessDate === businessDate,
		)
		const dayBlocks = await db
			.select()
			.from(rsvBlocks)
			.where(
				and(
					eq(rsvBlocks.locationId, locationId),
					eq(rsvBlocks.businessDate, businessDate),
				),
			)
			.all()
		const dayHolds = await db
			.select()
			.from(rsvHolds)
			.where(
				and(
					eq(rsvHolds.locationId, locationId),
					eq(rsvHolds.businessDate, businessDate),
					eq(rsvHolds.status, 'active'),
				),
			)
			.all()

		const resIds = dayResRows.map((r) => r.id)
		const activeOccRows = await db
			.select()
			.from(rsvTableOccupancies)
			.where(
				and(
					eq(rsvTableOccupancies.locationId, locationId),
					eq(rsvTableOccupancies.active, true),
				),
			)
			.all()

		let liveOccRows = activeOccRows
		const loadActiveOccs = async () =>
			dryRun
				? liveOccRows
				: db
						.select()
						.from(rsvTableOccupancies)
						.where(
							and(
								eq(rsvTableOccupancies.locationId, locationId),
								eq(rsvTableOccupancies.active, true),
							),
						)
						.all()
		const deactivateReservationOccs = async (reservationId: string) => {
			if (dryRun) {
				liveOccRows = liveOccRows.filter(
					(o) => o.reservationId !== reservationId,
				)
				return
			}
			await db
				.update(rsvTableOccupancies)
				.set({ active: false })
				.where(
					and(
						eq(rsvTableOccupancies.reservationId, reservationId),
						eq(rsvTableOccupancies.active, true),
					),
				)
		}
		const assignReservationOcc = async (
			r: { id: string; startAt: number; endAt: number },
			tableId: string,
		) => {
			const resetMs = (tableById.get(tableId)?.resetBufferMin ?? 0) * 60_000
			const row = {
				id: `occ_${randomUUID()}`,
				locationId,
				tableId,
				kind: 'reservation' as const,
				reservationId: r.id,
				startAt: r.startAt,
				endAt: r.endAt + resetMs,
				active: true,
				overbook: false,
				createdAt: nowMs,
			}
			if (dryRun) {
				liveOccRows = [...liveOccRows, { ...row, holdId: null, blockId: null }]
				return
			}
			await db.insert(rsvTableOccupancies).values(row)
		}
		const setReservationCombo = async (
			reservationId: string,
			comboId: string | null,
			bumpVersions: boolean,
		) => {
			if (dryRun) return
			await db
				.update(rsvReservations)
				.set(
					bumpVersions
						? {
								comboId,
								scheduleVersion: sql`${rsvReservations.scheduleVersion} + 1`,
								version: sql`${rsvReservations.version} + 1`,
								updatedAt: nowMs,
							}
						: { comboId, updatedAt: nowMs },
				)
				.where(eq(rsvReservations.id, reservationId))
		}

		const occsByResId = new Map<
			string,
			Array<typeof rsvTableOccupancies.$inferSelect>
		>()
		const occsByHoldId = new Map<
			string,
			Array<typeof rsvTableOccupancies.$inferSelect>
		>()
		for (const occ of activeOccRows) {
			if (occ.kind === 'reservation' && occ.reservationId) {
				const list = occsByResId.get(occ.reservationId) ?? []
				list.push(occ)
				occsByResId.set(occ.reservationId, list)
			} else if (occ.kind === 'hold' && occ.holdId) {
				const list = occsByHoldId.get(occ.holdId) ?? []
				list.push(occ)
				occsByHoldId.set(occ.holdId, list)
			}
		}

		// Record original table IDs before Step 1 deactivates invalidated soft assignments
		const originalTableIdsByResId = new Map<string, string[]>()
		for (const r of dayResRows) {
			const pre = opts?.preDeactivatedOriginalTables?.get(r.id)
			originalTableIdsByResId.set(
				r.id,
				pre ?? (occsByResId.get(r.id) ?? []).map((o) => o.tableId),
			)
		}

		// Step 1: Check if any soft reservation on this date has an invalid table assignment
		// (table archived, area archived, shrunk below partySize, in invalidatedSet, or overlapping a block).
		const dayBlockRowsForCheck = dayBlocks
		let needsReflow = false
		for (const r of dayResRows) {
			const resOccs = occsByResId.get(r.id) ?? []
			const tableIds = resOccs.map((o) => o.tableId)
			const isSoft =
				r.assignment === 'soft' && SOFT_REFLOWABLE_STATUSES.has(r.status)

			let assignmentInvalid = false
			if (tableIds.length === 0) {
				assignmentInvalid = true
			} else {
				for (const tid of tableIds) {
					const tbl = tableById.get(tid)
					const area = tbl ? areaById.get(tbl.areaId) : undefined
					if (
						!tbl ||
						tbl.archivedAt !== null ||
						(area && area.archivedAt !== null) ||
						invalidatedSet.has(tid)
					) {
						assignmentInvalid = true
						break
					}
					for (const blk of dayBlockRowsForCheck) {
						const matchesTable =
							blk.tableId === tid || (blk.areaId && blk.areaId === tbl.areaId)
						if (
							matchesTable &&
							r.startAt < blk.endAt &&
							r.endAt > blk.startAt
						) {
							assignmentInvalid = true
							break
						}
					}
					if (assignmentInvalid) break
				}
				if (!assignmentInvalid) {
					if (r.comboId) {
						const cmb = comboById.get(r.comboId)
						if (
							!cmb ||
							cmb.maxCovers < r.partySize ||
							cmb.minCovers > r.partySize
						) {
							assignmentInvalid = true
						}
					} else if (tableIds.length === 1) {
						const tbl = tableById.get(tableIds[0]!)
						if (
							tbl &&
							(tbl.maxCovers < r.partySize || tbl.minCovers > r.partySize)
						) {
							assignmentInvalid = true
						}
					}
				}
			}

			if (assignmentInvalid && isSoft) {
				needsReflow = true
				if (resOccs.length > 0) {
					await deactivateReservationOccs(r.id)
					occsByResId.set(r.id, [])
				}
				if (r.comboId) {
					await setReservationCombo(r.id, null, false)
					r.comboId = null
				}
			}
		}

		// Reload active occupancies after deactivating invalid soft assignments
		const refreshedOccRows = needsReflow
			? await loadActiveOccs()
			: activeOccRows

		const refreshedOccsByResId = new Map<
			string,
			Array<typeof rsvTableOccupancies.$inferSelect>
		>()
		for (const occ of refreshedOccRows) {
			if (occ.kind === 'reservation' && occ.reservationId) {
				const list = refreshedOccsByResId.get(occ.reservationId) ?? []
				list.push(occ)
				refreshedOccsByResId.set(occ.reservationId, list)
			}
		}

		const buildEngineBookings = (
			occMap: Map<string, Array<typeof rsvTableOccupancies.$inferSelect>>,
		): AssignBookingRecord[] =>
			dayResRows.map((r) => ({
				id: r.id,
				partySize: r.partySize,
				localStartMin: r.localStartMin,
				businessDate: r.businessDate,
				startAt: r.startAt,
				endAt: r.endAt,
				tableIds: (occMap.get(r.id) ?? []).map((o) => o.tableId),
				combinationId: r.comboId,
				status: r.status,
				tableLocked:
					r.assignment === 'locked' || !SOFT_REFLOWABLE_STATUSES.has(r.status),
				overbook: r.overbooked,
				channel: r.channel === 'online' ? 'online' : 'host',
				serviceId: r.serviceId,
				areaId: r.areaPrefStrict ? r.areaPrefId : null,
			}))

		const engineHolds: AssignHoldRecord[] = dayHolds
			.filter((h) => h.expiresAt > nowMs)
			.map((h) => ({
				id: h.id,
				partySize: h.partySize,
				startAt: h.startAt,
				endAt: h.endAt,
				tableIds: (occsByHoldId.get(h.id) ?? []).map((o) => o.tableId),
				combinationId: h.comboId,
				expiresAt: h.expiresAt,
			}))

		const engineBlocks: AssignBlockRecord[] = dayBlocks.map((b) => ({
			id: b.id,
			tableIds: b.tableId ? [b.tableId] : [],
			areaId: b.areaId,
			startAt: b.startAt,
			endAt: b.endAt,
		}))

		if (needsReflow && resIds.length > 0) {
			const reflowRes = reflowDay({
				tables: engineTables,
				areas: engineAreas,
				combinations: engineCombos,
				serviceAvailability: engineServiceAvail,
				pacingRules: enginePacingRules,
				bookings: buildEngineBookings(refreshedOccsByResId),
				holds: engineHolds,
				blocks: engineBlocks,
				nowMs,
				assignmentFreezeMin: settings?.freezeMin ?? 30,
			})

			if (reflowRes.status === 'assigned') {
				for (const [bookingId, nextAssign] of reflowRes.assignments.entries()) {
					const r = dayResRows.find((row) => row.id === bookingId)
					if (!r) continue
					const prevIds = (refreshedOccsByResId.get(r.id) ?? [])
						.map((o) => o.tableId)
						.slice()
						.sort()
						.join(',')
					const nextIds = [...nextAssign.tableIds].sort().join(',')
					const origIds = originalTableIdsByResId.get(r.id) ?? []
					const origSorted = [...origIds].sort().join(',')

					if (prevIds !== nextIds || r.comboId !== nextAssign.combinationId) {
						await deactivateReservationOccs(r.id)
						for (const tid of nextAssign.tableIds) {
							await assignReservationOcc(r, tid)
						}
						await setReservationCombo(r.id, nextAssign.combinationId, true)
						r.comboId = nextAssign.combinationId
					}

					if (origSorted !== nextIds) {
						reflowedMoves.push({
							bookingId: r.id,
							reservationId: r.id,
							fromTableIds: origIds,
							toTableIds: [...nextAssign.tableIds],
							toCombinationId: nextAssign.combinationId,
							toComboId: nextAssign.combinationId,
						})
					}
				}
			} else {
				// Even if full day reflow had one booking that couldn't fit, try assignTables
				// for each unassigned soft reservation individually so fitting reservations still move!
				for (const r of dayResRows) {
					const existingOccs = refreshedOccsByResId.get(r.id) ?? []
					if (
						existingOccs.length === 0 &&
						r.assignment === 'soft' &&
						SOFT_REFLOWABLE_STATUSES.has(r.status)
					) {
						const currentOccs = await loadActiveOccs()
						const currentOccsByResId = new Map<
							string,
							Array<typeof rsvTableOccupancies.$inferSelect>
						>()
						for (const occ of currentOccs) {
							if (occ.kind === 'reservation' && occ.reservationId) {
								const list = currentOccsByResId.get(occ.reservationId) ?? []
								list.push(occ)
								currentOccsByResId.set(occ.reservationId, list)
							}
						}
						const otherBookings = buildEngineBookings(
							currentOccsByResId,
						).filter((b) => b.id !== r.id && b.tableIds.length > 0)
						const assignRes = assignTables({
							partySize: r.partySize,
							startAt: r.startAt,
							endAt: r.endAt,
							localStartMin: r.localStartMin,
							channel: r.channel === 'online' ? 'online' : 'host',
							serviceId: r.serviceId,
							areaId: r.areaPrefStrict ? r.areaPrefId : null,
							tables: engineTables,
							areas: engineAreas,
							combinations: engineCombos,
							serviceAvailability: engineServiceAvail,
							pacingRules: enginePacingRules,
							bookings: otherBookings,
							holds: engineHolds,
							blocks: engineBlocks,
							nowMs,
							assignmentFreezeMin: settings?.freezeMin ?? 30,
						})
						if (assignRes.assigned && assignRes.tableIds.length > 0) {
							// Apply any repair swaps first
							for (const swap of assignRes.swaps) {
								const swappedRes = dayResRows.find(
									(row) => row.id === swap.bookingId,
								)
								if (!swappedRes) continue
								await deactivateReservationOccs(swappedRes.id)
								for (const tid of swap.toTableIds) {
									await assignReservationOcc(swappedRes, tid)
								}
								await setReservationCombo(
									swappedRes.id,
									swap.toCombinationId,
									true,
								)
								reflowedMoves.push({
									...swap,
									reservationId: swappedRes.id,
									toComboId: swap.toCombinationId,
								})
							}

							for (const tid of assignRes.tableIds) {
								await assignReservationOcc(r, tid)
							}
							await setReservationCombo(r.id, assignRes.combinationId, true)
							r.comboId = assignRes.combinationId
							reflowedMoves.push({
								bookingId: r.id,
								reservationId: r.id,
								fromTableIds: originalTableIdsByResId.get(r.id) ?? [],
								toTableIds: [...assignRes.tableIds],
								toCombinationId: assignRes.combinationId,
								toComboId: assignRes.combinationId,
							})
						}
					}
				}
			}
			if (!dryRun) await bumpDayVersion(db, locationId, businessDate)
		} else if (
			!dryRun &&
			!opts?.skipExplicitDayVersionBump &&
			explicitDatesSet.has(businessDate)
		) {
			await bumpDayVersion(db, locationId, businessDate)
		}

		// Step 2: Detect conflicts on this businessDate after reflow
		const finalOccRows = await loadActiveOccs()
		const finalOccsByResId = new Map<
			string,
			Array<typeof rsvTableOccupancies.$inferSelect>
		>()
		for (const occ of finalOccRows) {
			if (occ.kind === 'reservation' && occ.reservationId) {
				const list = finalOccsByResId.get(occ.reservationId) ?? []
				list.push(occ)
				finalOccsByResId.set(occ.reservationId, list)
			}
		}

		const matchingSpecialDays = allSpecialDays
			.filter((sd) => sd.fromDate <= businessDate && businessDate <= sd.toDate)
			.map((sd) => ({
				id: sd.id,
				businessDate,
				type: sd.kind as 'closed' | 'online_closed' | 'modified' | 'replace',
				name: sd.name,
			}))

		const resolvedServices = resolveServices(
			businessDate,
			allServices.map((s) => ({
				id: s.id,
				name: s.name,
				slug: s.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
				daysMask: s.daysMask,
				effectiveFrom: s.effectiveFrom,
				effectiveTo: s.effectiveTo,
				specialDayId: s.specialDayId,
				firstSeatingMin: s.firstSeatingMin,
				startMin: s.firstSeatingMin,
				lastSeatingMin: s.lastSeatingMin,
				endMin: s.endMin,
				intervalMin: s.intervalMin,
				onlineEnabled: s.onlineEnabled,
				active: s.archivedAt === null,
			})),
			matchingSpecialDays,
		)

		const dayConflicts = detectConflicts({
			tables: engineTables,
			areas: engineAreas,
			combinations: engineCombos,
			bookings: buildEngineBookings(finalOccsByResId),
			blocks: engineBlocks,
			services: resolvedServices.services,
			pacingRules: enginePacingRules,
			businessDate,
			dayClosed: resolvedServices.closed,
		})
		for (const c of dayConflicts) {
			allConflicts.push({
				...c,
				details: { ...c.details, businessDate },
			})
		}
	}

	for (const move of dryRun ? [] : reflowedMoves) {
		const reservationId = move.reservationId ?? move.bookingId
		if (!reservationId) continue
		await db.insert(rsvReservationEvents).values({
			id: `rve_${randomUUID()}`,
			reservationId,
			at: nowMs,
			actorKind: 'system',
			actorId: null,
			type: 'auto_reassigned',
			data: {
				fromTableIds: move.fromTableIds,
				toTableIds: move.toTableIds,
				toCombinationId: move.toCombinationId ?? null,
			},
		})
	}

	return { conflicts: allConflicts, reflowedMoves }
}

export async function validateLocationSetup(
	db: TenantDatabase,
	orgId: string,
	locationId: string,
): Promise<{
	valid: boolean
	issues: ConfigValidationIssue[]
	errors: ConfigValidationIssue[]
	warnings: ConfigValidationIssue[]
	/** Informational notes (for example a redundant special-day closure); never block. */
	infos: LocationHoursIssueInfo[]
}> {
	const settings = await ensureLocationSettingsRow(db, orgId, locationId)
	const areas = await db
		.select()
		.from(rsvAreas)
		.where(
			and(eq(rsvAreas.locationId, locationId), isNull(rsvAreas.archivedAt)),
		)
		.all()
	const tables = await db
		.select()
		.from(rsvTables)
		.where(
			and(eq(rsvTables.locationId, locationId), isNull(rsvTables.archivedAt)),
		)
		.all()
	const combos = await listCombosForLocation(db, locationId, false)
	const services = await db
		.select()
		.from(rsvServices)
		.where(
			and(
				eq(rsvServices.locationId, locationId),
				isNull(rsvServices.archivedAt),
			),
		)
		.all()
	const turnTimes = await db
		.select()
		.from(rsvTurnTimes)
		.where(eq(rsvTurnTimes.locationId, locationId))
		.all()
	const serviceIds = services.map((s) => s.id)
	const pacing =
		serviceIds.length > 0
			? await queryInChunks(serviceIds, (chunk) =>
					db
						.select()
						.from(rsvPacingRules)
						.where(inArray(rsvPacingRules.serviceId, chunk))
						.all(),
				)
			: []
	const policies = await db
		.select()
		.from(rsvPolicies)
		.where(eq(rsvPolicies.locationId, locationId))
		.all()
	const blocks = await db
		.select()
		.from(rsvBlocks)
		.where(eq(rsvBlocks.locationId, locationId))
		.all()

	const areaById = new Map(areas.map((a) => [a.id, a]))

	const issues = validateConfig({
		settings: {
			minParty: settings.onlinePartyMin,
			maxOnlineParty: settings.onlinePartyMax,
			maxParty: settings.partyMax,
			intervalMin: settings.intervalMin,
			horizonDays: settings.horizonDays,
		},
		areas: areas.map((a) => ({
			id: a.id,
			name: a.name,
			active: a.archivedAt === null,
		})),
		tables: tables.map((t) => {
			const area = areaById.get(t.areaId)
			return {
				id: t.id,
				areaId: t.areaId,
				label: t.label,
				minSeats: t.minCovers,
				maxSeats: t.maxCovers,
				onlineBookable: t.onlineBookable && (area ? area.onlineBookable : true),
				combinable: t.combinable,
				active: t.archivedAt === null,
			}
		}),
		combinations: combos.map((c) => ({
			id: c.id,
			name: c.label,
			minSeats: c.minCovers,
			maxSeats: c.maxCovers,
			onlineBookable: c.onlineBookable,
			tableIds: c.tableIds,
			active: c.archivedAt === null,
		})),
		services: services.map((s) => ({
			id: s.id,
			name: s.name,
			startMin: s.firstSeatingMin,
			firstSeatingMin: s.firstSeatingMin,
			lastSeatingMin: s.lastSeatingMin,
			endMin: s.endMin,
			onlineBookable: s.onlineEnabled,
			active: s.archivedAt === null,
		})),
		turnTimeBuckets: turnTimes.map((tt) => ({
			id: tt.id,
			serviceId: tt.serviceId,
			minParty: tt.partyMin,
			maxParty: tt.partyMax,
			durationMin: tt.minutes,
		})),
		pacingRules: pacing.map((p) => ({
			id: p.id,
			serviceId: p.serviceId,
			maxCoversPerSlot: p.maxCovers,
			maxPartiesPerSlot: p.maxParties,
		})),
		policies: policies.map((pol) => ({
			id: pol.id,
			mode: pol.kind,
			amountPerCoverMinor: pol.amountMinor,
			currency: pol.currency,
			cancelCutoffMin: pol.freeCancelUntilMin,
			minParty: pol.appliesPartyMin ?? 1,
			active: pol.archivedAt === null,
		})),
		blocks: blocks.map((b) => ({
			id: b.id,
			businessDate: b.businessDate,
			tableId: b.tableId,
			areaId: b.areaId,
			startAtMs: b.startAt,
			endAtMs: b.endAt,
			reason: b.reason,
		})),
	})

	// Services only operate inside the location hours (control-plane context,
	// best effort: no context means no hours checks, never an error).
	const locationHoursIssues = await validateAgainstLocationHours(
		db,
		orgId,
		locationId,
		settings.dayStartMin,
		services,
	)
	const allIssues = [...issues, ...locationHoursIssues.issues]
	const errors = allIssues.filter((i) => i.severity === 'error')
	const warnings = allIssues.filter((i) => i.severity === 'warning')
	const valid = errors.length === 0
	return {
		valid,
		issues: allIssues,
		errors,
		warnings,
		infos: locationHoursIssues.infos,
	}
}

async function validateAgainstLocationHours(
	db: TenantDatabase,
	orgId: string,
	locationId: string,
	dayStartMin: number,
	services: Array<typeof rsvServices.$inferSelect>,
) {
	const empty = {
		issues: [] as ConfigValidationIssue[],
		infos: [] as LocationHoursIssueInfo[],
	}
	let hours: LocationHours | null = null
	try {
		hours = locationHoursFromContext(
			await getReservationsContext(orgId),
			locationId,
		)
	} catch {
		hours = null
	}
	if (!hours) return empty
	const specialDays = await db
		.select()
		.from(rsvSpecialDays)
		.where(eq(rsvSpecialDays.locationId, locationId))
		.all()
	return validateLocationHoursSetup({
		hours,
		dayStartMin,
		today: businessDateOf(Date.now(), hours.timeZone, dayStartMin),
		services: services.map((s) => ({
			id: s.id,
			name: s.name,
			daysMask: s.daysMask,
			firstSeatingMin: s.firstSeatingMin,
			lastSeatingMin: s.lastSeatingMin,
			active: s.archivedAt === null,
		})),
		specialDays: specialDays.map((sd) => ({
			id: sd.id,
			kind: sd.kind,
			fromDate: sd.fromDate,
			toDate: sd.toDate,
			name: sd.name,
		})),
	})
}

export async function detectLocationConflicts(
	db: TenantDatabase,
	locationId: string,
	filter?: { from?: string; to?: string; date?: string },
): Promise<{ conflicts: ConflictItem[] }> {
	const settings = await db
		.select()
		.from(rsvLocationSettings)
		.where(eq(rsvLocationSettings.locationId, locationId))
		.get()
	const timeZone = settings?.timeZone ?? 'UTC'
	const today = currentBusinessDate(
		Date.now(),
		isValidTimeZone(timeZone) ? timeZone : 'UTC',
		settings?.dayStartMin ?? 240,
	)
	const fromDate = filter?.date ?? filter?.from ?? today
	const toDate = filter?.date ?? filter?.to ?? addDays(fromDate, 60)

	const resRows = await db
		.select()
		.from(rsvReservations)
		.where(
			and(
				eq(rsvReservations.locationId, locationId),
				gte(rsvReservations.businessDate, fromDate),
				inArray(rsvReservations.status, [...ACTIVE_RESERVATION_STATUSES]),
			),
		)
		.all()
	const dates = [
		...new Set(
			resRows
				.map((r) => r.businessDate)
				.filter((d) => d >= fromDate && d <= toDate),
		),
	].sort()

	if (dates.length === 0) {
		return { conflicts: [] }
	}

	const { conflicts } = await reflowFutureBookingsForLocation(db, locationId, {
		affectedDates: dates,
		skipExplicitDayVersionBump: true,
		dryRun: true,
	})
	return { conflicts }
}

export async function getFloorPlan(
	db: TenantDatabase,
	orgId: string,
	locationId: string,
) {
	const settings = await ensureLocationSettingsRow(db, orgId, locationId)
	const areas = await db
		.select()
		.from(rsvAreas)
		.where(
			and(eq(rsvAreas.locationId, locationId), isNull(rsvAreas.archivedAt)),
		)
		.orderBy(asc(rsvAreas.sort), asc(rsvAreas.name))
		.all()
	const tables = await db
		.select()
		.from(rsvTables)
		.where(
			and(eq(rsvTables.locationId, locationId), isNull(rsvTables.archivedAt)),
		)
		.orderBy(asc(rsvTables.label))
		.all()
	const combos = await listCombosForLocation(db, locationId, false)
	const areaIds = areas.map((a) => a.id)
	const elements =
		areaIds.length > 0
			? await queryInChunks(areaIds, (chunk) =>
					db
						.select()
						.from(rsvFloorElements)
						.where(inArray(rsvFloorElements.areaId, chunk))
						.all(),
				)
			: []

	return {
		locationId,
		location_id: locationId,
		floorPlanVersion: settings.floorPlanVersion,
		floor_plan_version: settings.floorPlanVersion,
		areas: areas.map(serializeArea),
		tables: tables.map(serializeTable),
		combos,
		combinations: combos,
		elements: elements.map(serializeElement),
	}
}

export async function rederiveLocationTimes(
	db: TenantDatabase,
	orgId: string,
	locationId: string,
	actorId: string,
	overrideTimeZone?: string,
) {
	return withSetupWrite(
		db,
		async (db) => {
			const settings = await ensureLocationSettingsRow(db, orgId, locationId)
			const contextTz = await resolveContextLocationTimeZone(orgId, locationId)
			const targetTimeZone = overrideTimeZone ?? contextTz ?? settings.timeZone
			if (!isValidTimeZone(targetTimeZone)) {
				throw badRequest('invalid', 'invalid', {
					fields: ['timeZone'],
					issues: [{ path: 'timeZone', code: 'invalid_time_zone' }],
				})
			}

			const now = Date.now()
			const today = currentBusinessDate(
				now,
				targetTimeZone,
				settings.dayStartMin ?? 240,
			)

			await db
				.update(rsvLocationSettings)
				.set({
					timeZone: targetTimeZone,
					tzSyncedAt: now,
					version: settings.version + 1,
					updatedAt: now,
					updatedBy: actorId,
				})
				.where(eq(rsvLocationSettings.locationId, locationId))

			const futureReservations = await db
				.select()
				.from(rsvReservations)
				.where(
					and(
						eq(rsvReservations.locationId, locationId),
						gte(rsvReservations.businessDate, today),
						inArray(rsvReservations.status, [...ACTIVE_RESERVATION_STATUSES]),
					),
				)
				.all()

			const allTables = await db
				.select()
				.from(rsvTables)
				.where(eq(rsvTables.locationId, locationId))
				.all()
			const tableById = new Map(allTables.map((t) => [t.id, t]))

			const affectedDates = new Set<string>()
			const occIdsToReactivate: string[] = []
			let updatedReservations = 0

			for (const r of futureReservations) {
				const resolved = localToInstant(
					r.businessDate,
					r.localStartMin,
					targetTimeZone,
				)
				if (!resolved) continue
				const newStartAt = resolved.instantMs
				const newEndAt = newStartAt + r.durationMin * 60_000

				await db
					.update(rsvReservations)
					.set({
						startAt: newStartAt,
						endAt: newEndAt,
						timeZone: targetTimeZone,
						scheduleVersion: r.scheduleVersion + 1,
						version: r.version + 1,
						updatedAt: now,
					})
					.where(eq(rsvReservations.id, r.id))

				const occs = await db
					.select()
					.from(rsvTableOccupancies)
					.where(
						and(
							eq(rsvTableOccupancies.reservationId, r.id),
							eq(rsvTableOccupancies.active, true),
						),
					)
					.all()

				for (const occ of occs) {
					const tbl = tableById.get(occ.tableId)
					const resetMs = (tbl?.resetBufferMin ?? 0) * 60_000
					await db
						.update(rsvTableOccupancies)
						.set({
							active: false,
							startAt: newStartAt,
							endAt: newEndAt + resetMs,
						})
						.where(eq(rsvTableOccupancies.id, occ.id))
					occIdsToReactivate.push(occ.id)
				}

				affectedDates.add(r.businessDate)
				updatedReservations += 1
			}

			for (const occId of occIdsToReactivate) {
				await db
					.update(rsvTableOccupancies)
					.set({ active: true })
					.where(eq(rsvTableOccupancies.id, occId))
			}

			for (const d of affectedDates) {
				await bumpDayVersion(db, locationId, d)
			}

			await writeSetupAuditLog(db, {
				actorId,
				locationId,
				action: 'settings.rederive_times',
				entityType: 'location_settings',
				entityId: locationId,
				changes: {
					previousTimeZone: settings.timeZone,
					newTimeZone: targetTimeZone,
					updatedReservations,
				},
			})

			const updatedSettings = await getLocationSettingsWithContext(
				db,
				orgId,
				locationId,
			)

			return {
				timeZone: targetTimeZone,
				time_zone: targetTimeZone,
				tzSyncedAt: now,
				tz_synced_at: now,
				updatedReservations,
				updated_reservations: updatedReservations,
				settings: updatedSettings,
			}
		},
		orgId,
	)
}

export * from './rsv-setup-crud.js'
