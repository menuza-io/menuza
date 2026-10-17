import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { type ReservationsScopedClient } from '#app/utils/reservations/reservations-client.ts'

export type LocalizedCopy = {
	en?: string
	ar?: string
	[locale: string]: string | undefined
}

export type LocationSettingsDto = {
	locationId: string
	organizationId?: string
	enabled: boolean
	onlineBookingEnabled: boolean
	waitlistEnabled: boolean
	slotIntervalMin: number
	defaultTurnTimeMin: number
	minAdvanceMinutes: number
	maxAdvanceDays: number
	onlinePartyMin: number
	onlinePartyMax: number
	partyMax: number
	holdTtlSeconds: number
	gracePeriodMinutes: number
	lateCancelHours: number
	cancellationCutoffMin?: number
	modificationCutoffMin?: number
	pacingMaxCoversPerSlot: number | null
	pacingMaxPartiesPerSlot: number | null
	autoConfirmOnline: boolean
	autoAssignTables: boolean
	ConfirmationCopyI18n?: LocalizedCopy
	confirmationCopyI18n: LocalizedCopy
	policyCopyI18n: LocalizedCopy
	timeZone: string
	contextTimeZone?: string
	tzSyncedAt: number | null
	tzMismatch: boolean
	floorPlanVersion: number
	version: number
	updatedAt?: number | null
}

export type DiningAreaDto = {
	id: string
	locationId: string
	name: string
	nameI18n: LocalizedCopy
	floorLabel: string | null
	sortOrder: number
	isOutdoor: boolean
	isBookableOnline: boolean
	onlinePriority: number
	isActive: boolean
	archivedAt: number | null
	version: number
}

export type TableShape =
	'round' | 'square' | 'rect' | 'booth' | 'bar' | 'high_top'

export type TableDto = {
	id: string
	locationId: string
	areaId: string
	label: string
	name?: string
	minCovers: number
	maxCovers: number
	shape: TableShape
	x: number
	y: number
	width: number
	height: number
	rotation: number
	combinable: boolean
	isCombable?: boolean
	isBookableOnline: boolean
	isAccessible: boolean
	isHighTop: boolean
	isPatio: boolean
	resetBufferMin: number
	turnBufferMin?: number
	priority: number
	sortOrder?: number
	notes: string | null
	isActive: boolean
	archivedAt: number | null
	version: number
}

export type TableCombinationDto = {
	id: string
	locationId: string
	areaId: string | null
	name: string
	minCovers: number
	maxCovers: number
	priority: number
	isBookableOnline: boolean
	isActive: boolean
	tableIds: string[]
	version: number
}

export type FloorElementKind =
	'wall' | 'bar' | 'door' | 'window' | 'label' | 'plant' | 'zone'

export type FloorElementDto = {
	id: string
	locationId?: string
	areaId: string | null
	kind: FloorElementKind
	label: string | null
	x: number
	y: number
	width: number
	height: number
	rotation: number
	style: Record<string, unknown>
	version?: number
}

export type SetupConflictReason =
	| 'table_overlap'
	| 'table_blocked'
	| 'table_archived'
	| 'capacity_reduced'
	| 'unassigned'
	| 'pacing_exceeded'
	| 'outside_service_hours'
	| 'other'

export type SetupConflictDto = {
	kind: string
	/** Empty for conflicts that are not tied to one booking (pacing). */
	reservationId: string
	confirmationCode: string | null
	businessDate: string | null
	partySize: number | null
	reason: SetupConflictReason
	tableId: string | null
	serviceId: string | null
	detail?: string
}

export const SETUP_CONFLICT_REASON_LABELS: Record<
	SetupConflictReason,
	MessageDescriptor
> = {
	table_overlap: msg`Two bookings share a table at the same time`,
	table_blocked: msg`The table is blocked during this booking`,
	table_archived: msg`The assigned table is no longer in use`,
	capacity_reduced: msg`The party no longer fits the assigned table`,
	unassigned: msg`No table is assigned`,
	pacing_exceeded: msg`Pacing limit exceeded`,
	outside_service_hours: msg`Outside service hours`,
	other: msg`Needs review`,
}

const CONFLICT_KIND_TO_REASON: Record<string, SetupConflictReason> = {
	table_overlap: 'table_overlap',
	blocked_table: 'table_blocked',
	table_blocked: 'table_blocked',
	archived_table: 'table_archived',
	shrunk_capacity: 'capacity_reduced',
	unassigned: 'unassigned',
	pacing_exceeded: 'pacing_exceeded',
	outside_service_hours: 'outside_service_hours',
}

/**
 * Maps one `/conflicts` item (`kind`, `bookingId`, `tableId`/`serviceId`,
 * `details`) to what the conflicts panel renders. Confirmation code and party
 * size are not part of the item; `fetchSetupConflicts` fills them in.
 */
export function normalizeSetupConflict(rawInput: unknown): SetupConflictDto {
	const raw =
		rawInput && typeof rawInput === 'object'
			? (rawInput as Record<string, unknown>)
			: {}
	const details =
		raw.details && typeof raw.details === 'object'
			? (raw.details as Record<string, unknown>)
			: {}
	const kind = String(raw.kind ?? raw.reason ?? 'other')
	const partySize =
		typeof raw.partySize === 'number'
			? raw.partySize
			: typeof details.partySize === 'number'
				? details.partySize
				: null
	const businessDate =
		typeof raw.businessDate === 'string'
			? raw.businessDate
			: typeof details.businessDate === 'string'
				? details.businessDate
				: null
	return {
		kind,
		reservationId: String(raw.bookingId ?? raw.reservationId ?? ''),
		confirmationCode:
			typeof raw.confirmationCode === 'string' ? raw.confirmationCode : null,
		businessDate,
		partySize,
		reason: CONFLICT_KIND_TO_REASON[kind] ?? 'other',
		tableId: typeof raw.tableId === 'string' ? raw.tableId : null,
		serviceId: typeof raw.serviceId === 'string' ? raw.serviceId : null,
		detail: typeof raw.detail === 'string' ? raw.detail : undefined,
	}
}

export type ReflowedMoveDto = {
	reservationId: string
	fromTableIds: string[]
	toTableIds: string[]
	comboId: string | null
}

export type FloorPlanPayload = {
	locationId: string
	floorPlanVersion: number
	version: number
	areas: DiningAreaDto[]
	tables: TableDto[]
	combos: TableCombinationDto[]
	combinations?: TableCombinationDto[]
	elements: FloorElementDto[]
	conflicts?: SetupConflictDto[]
	reflowedMoves?: ReflowedMoveDto[]
}

export type ServiceDto = {
	id: string
	locationId: string
	name: string
	nameI18n: LocalizedCopy
	code: string
	slug?: string
	daysOfWeek: number[]
	firstSeatingMin: number
	lastSeatingMin: number
	endMin: number
	slotIntervalMin: number | null
	defaultTurnTimeMin: number | null
	onlineBookable: boolean
	isBookableOnline?: boolean
	sortOrder: number
	color: string | null
	isActive: boolean
	archivedAt: number | null
	version: number
}

export type TurnTimeRuleDto = {
	id: string
	locationId: string
	serviceId: string | null
	partyMin: number
	partyMax: number
	minutes: number
	turnTimeMin?: number
	bufferMinutes: number
	bufferMin?: number
	version: number
}

export type PacingChannel = 'all' | 'online'

export type PacingRuleDto = {
	id: string
	locationId: string
	serviceId: string | null
	bucketMin: number
	windowMinutes?: number
	fromMin: number | null
	toMin: number | null
	maxCovers: number | null
	maxCoversPerSlot?: number | null
	maxParties: number | null
	maxPartiesPerSlot?: number | null
	rollingMin: number | null
	rollingMaxCovers: number | null
	channel: PacingChannel
	version: number
}

export type ServiceAvailabilityMode =
	'online' | 'staff_only' | 'walk_in_only' | 'unavailable'

export type ServiceAvailabilityDto = {
	id: string
	locationId: string
	serviceId: string
	areaId: string | null
	tableId: string | null
	comboId: string | null
	mode: ServiceAvailabilityMode
	fromMin: number | null
	toMin: number | null
	version: number
}

export type SpecialDayKind = 'closed' | 'online_closed' | 'modified' | 'replace'

export type SpecialDayDto = {
	id: string
	locationId: string
	date: string
	fromDate: string
	toDate: string
	kind: SpecialDayKind
	name: string | null
	reason?: string | null
	publicNoteI18n: LocalizedCopy
	serviceId: string | null
	patch: {
		firstSeatingMin?: number
		lastSeatingMin?: number
		endMin?: number
		onlineBookable?: boolean
		pacingMaxCovers?: number | null
	} | null
	services: Array<{
		id?: string
		name: string
		nameI18n?: LocalizedCopy
		code?: string
		daysOfWeek?: number[]
		firstSeatingMin: number
		lastSeatingMin: number
		endMin: number
		slotIntervalMin?: number | null
		defaultTurnTimeMin?: number | null
		onlineBookable?: boolean
		sortOrder?: number
	}> | null
	version: number
}

export type BlockReason =
	| 'maintenance'
	| 'vip_hold'
	| 'private_event'
	| 'weather'
	| 'staffing'
	| 'other'

export type BlockDto = {
	id: string
	locationId: string
	areaId: string | null
	tableId: string | null
	businessDate: string
	startAt: number
	endAt: number
	startMin: number | null
	endMin: number | null
	reason: BlockReason
	note: string | null
	createdByUserId?: string | null
	version: number
}

export type SetupValidationIssueDto = {
	code: string
	severity: 'error' | 'warning'
	message: string
	entityId?: string
	field?: string
}

export type SetupValidationResponse = {
	valid: boolean
	issues: SetupValidationIssueDto[]
	errors: SetupValidationIssueDto[]
	warnings: SetupValidationIssueDto[]
}

export type RsvAreaRecord = DiningAreaDto
export type RsvTableRecord = TableDto & {
	posX?: number
	posY?: number
	w?: number
	h?: number
	rotDeg?: number
}
export type RsvCombinationRecord = TableCombinationDto
export type RsvFloorElementRecord = FloorElementDto & {
	posX?: number
	posY?: number
	w?: number
	h?: number
	rotDeg?: number
	styleJson?: Record<string, unknown>
}
export type RsvServiceRecord = ServiceDto & {
	startMin?: number
}
export type ServicePeriodDto = RsvServiceRecord
export type RsvScheduleBlockRecord = BlockDto
export type RsvSettingsData = LocationSettingsDto

export const FLOOR_CANVAS_MIN = 0
export const FLOOR_CANVAS_MAX = 1200
export const FLOOR_ITEM_MIN_SIZE = 20
export const FLOOR_ITEM_MAX_SIZE = 600
export const FLOOR_GRID_STEP = 10

export const WEEKDAY_OPTIONS: ReadonlyArray<{
	value: number
	/** Stable English code for test ids; never render it. */
	code: string
	shortLabel: MessageDescriptor
	fullLabel: MessageDescriptor
}> = [
	{
		value: 0,
		code: 'Sun',
		shortLabel: msg`Sun`,
		fullLabel: msg`Sunday`,
	},
	{
		value: 1,
		code: 'Mon',
		shortLabel: msg`Mon`,
		fullLabel: msg`Monday`,
	},
	{
		value: 2,
		code: 'Tue',
		shortLabel: msg`Tue`,
		fullLabel: msg`Tuesday`,
	},
	{
		value: 3,
		code: 'Wed',
		shortLabel: msg`Wed`,
		fullLabel: msg`Wednesday`,
	},
	{
		value: 4,
		code: 'Thu',
		shortLabel: msg`Thu`,
		fullLabel: msg`Thursday`,
	},
	{
		value: 5,
		code: 'Fri',
		shortLabel: msg`Fri`,
		fullLabel: msg`Friday`,
	},
	{
		value: 6,
		code: 'Sat',
		shortLabel: msg`Sat`,
		fullLabel: msg`Saturday`,
	},
]

export function snapToGrid(value: number, grid = FLOOR_GRID_STEP): number {
	if (!Number.isFinite(value)) return 0
	const snapped = Math.round(value / grid) * grid
	return clampCanvasCoord(snapped)
}

export function clampCanvasCoord(value: number): number {
	if (!Number.isFinite(value)) return FLOOR_CANVAS_MIN
	return Math.max(
		FLOOR_CANVAS_MIN,
		Math.min(FLOOR_CANVAS_MAX, Math.round(value)),
	)
}

export function clampCanvasDimension(value: number): number {
	if (!Number.isFinite(value)) return 60
	return Math.max(
		FLOOR_ITEM_MIN_SIZE,
		Math.min(FLOOR_ITEM_MAX_SIZE, Math.round(value)),
	)
}

export function normalizeRotation(deg: number): number {
	if (!Number.isFinite(deg)) return 0
	return ((Math.round(deg) % 360) + 360) % 360
}

/**
 * Converts minutes from midnight (`0..1680`) into an `HH:MM` string.
 * Supports next-day spillover minutes (`>= 1440`) by wrapping modulo 24h for `<input type="time">`
 * or formatting with `+1d` when displaying.
 */
export function minutesToTimeString(minutes: number): string {
	const safe = Math.max(0, Math.round(Number.isFinite(minutes) ? minutes : 0))
	const wrapped = safe % 1440
	const h = Math.floor(wrapped / 60)
	const m = wrapped % 60
	return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

export function formatMinutesLabel(minutes: number): string {
	const safe = Math.max(0, Math.round(Number.isFinite(minutes) ? minutes : 0))
	const nextDay = safe >= 1440
	const timeStr = minutesToTimeString(safe)
	return nextDay ? `${timeStr} (+1d)` : timeStr
}

export function timeStringToMinutes(
	timeStr: string,
	options?: { nextDay?: boolean },
): number {
	const match = /^(\d{1,2}):(\d{2})$/.exec(timeStr.trim())
	if (!match) return 0
	const h = Math.min(23, Math.max(0, Number(match[1])))
	const m = Math.min(59, Math.max(0, Number(match[2])))
	const base = h * 60 + m
	return options?.nextDay ? Math.min(1680, base + 1440) : base
}

export type TurnTimeCoverageSummary = {
	covered: boolean
	gaps: Array<{ from: number; to: number }>
	overlaps: Array<{ from: number; to: number }>
}

/**
 * Checks whether a list of turn-time buckets covers `[1 .. onlinePartyMax]`
 * contiguously without gaps or overlaps.
 */
export function checkTurnTimeContiguity(
	rules: ReadonlyArray<
		Pick<TurnTimeRuleDto, 'partyMin' | 'partyMax' | 'serviceId'>
	>,
	onlinePartyMax: number,
	serviceId: string | null = null,
): TurnTimeCoverageSummary {
	const targetMax = Math.max(1, Math.round(onlinePartyMax || 1))
	const scoped = rules
		.filter((r) => (r.serviceId ?? null) === serviceId)
		.slice()
		.sort((a, b) => a.partyMin - b.partyMin || a.partyMax - b.partyMax)

	if (scoped.length === 0) {
		return {
			covered: false,
			gaps: [{ from: 1, to: targetMax }],
			overlaps: [],
		}
	}

	const gaps: Array<{ from: number; to: number }> = []
	const overlaps: Array<{ from: number; to: number }> = []

	let cursor = 1
	for (const rule of scoped) {
		if (rule.partyMin > cursor) {
			gaps.push({
				from: cursor,
				to: Math.min(targetMax, rule.partyMin - 1),
			})
		} else if (rule.partyMin < cursor) {
			overlaps.push({
				from: rule.partyMin,
				to: Math.min(cursor - 1, rule.partyMax),
			})
		}
		cursor = Math.max(cursor, rule.partyMax + 1)
	}

	if (cursor <= targetMax) {
		gaps.push({ from: cursor, to: targetMax })
	}

	const validGaps = gaps.filter((g) => g.from <= g.to && g.from <= targetMax)
	return {
		covered: validGaps.length === 0 && overlaps.length === 0,
		gaps: validGaps,
		overlaps,
	}
}

export function isVersionConflictError(err: unknown): boolean {
	if (!err || typeof err !== 'object') return false
	const status = (err as { status?: number }).status
	const body = (err as { body?: { error?: string; code?: string } }).body
	if (status === 409) {
		const code = body?.error ?? body?.code ?? ''
		if (
			code === 'stale_version' ||
			code === 'RSV_VERSION_CONFLICT' ||
			code === ''
		) {
			return true
		}
	}
	return false
}

export function extractApiErrorCode(err: unknown): string | null {
	if (!err || typeof err !== 'object') return null
	const body = (err as { body?: { error?: string; code?: string } }).body
	return body?.error ?? body?.code ?? null
}

export function extractApiErrorMessage(err: unknown, fallback: string): string {
	if (!err || typeof err !== 'object') return fallback
	const body = (
		err as {
			body?: {
				message?: string
				error?: string
				fields?: string[]
				issues?: Array<{ message?: string; path?: string; code?: string }>
			}
		}
	).body
	if (body?.issues && Array.isArray(body.issues) && body.issues[0]?.message) {
		return body.issues[0].message
	}
	if (typeof body?.message === 'string' && body.message.trim().length > 0) {
		if (
			body.message === 'Invalid request' &&
			Array.isArray(body.fields) &&
			body.fields.length > 0
		) {
			return `${body.message} (${body.fields.slice(0, 4).join(', ')})`
		}
		return body.message
	}
	const message = (err as { message?: string }).message
	if (typeof message === 'string' && message.trim().length > 0) {
		return message
	}
	return fallback
}

// --- Normalization helpers (bridge tenant-api and UI DTO field aliases) ---

function daysMaskToDaysOfWeek(mask: number): number[] {
	const days: number[] = []
	for (let d = 0; d <= 6; d++) {
		if ((mask & (1 << d)) !== 0) {
			days.push(d)
		}
	}
	return days
}

function daysOfWeekToDaysMask(days: number[]): number {
	let mask = 0
	for (const d of days) {
		if (d >= 0 && d <= 6) {
			mask |= 1 << d
		}
	}
	return mask || 127
}

export function normalizeLocationSettings(
	rawInput: unknown,
): LocationSettingsDto {
	const raw =
		rawInput && typeof rawInput === 'object'
			? (rawInput as Record<string, unknown>)
			: {}
	const holdMinutes =
		typeof raw.holdMinutes === 'number'
			? raw.holdMinutes
			: typeof raw.hold_minutes === 'number'
				? raw.hold_minutes
				: null
	const holdTtlSeconds =
		typeof raw.holdTtlSeconds === 'number'
			? raw.holdTtlSeconds
			: holdMinutes !== null
				? holdMinutes * 60
				: 600
	const guestCutoffMin =
		typeof raw.guestModifyCutoffMin === 'number'
			? raw.guestModifyCutoffMin
			: typeof raw.guest_modify_cutoff_min === 'number'
				? raw.guest_modify_cutoff_min
				: null
	const lateCancelHours =
		typeof raw.lateCancelHours === 'number'
			? raw.lateCancelHours
			: guestCutoffMin !== null
				? Math.max(0, Math.round(guestCutoffMin / 60))
				: 24

	return {
		...(raw as Partial<LocationSettingsDto>),
		locationId: String(raw.locationId ?? raw.location_id ?? ''),
		enabled: typeof raw.enabled === 'boolean' ? raw.enabled : true,
		onlineBookingEnabled:
			typeof raw.onlineBookingEnabled === 'boolean'
				? raw.onlineBookingEnabled
				: typeof raw.onlineEnabled === 'boolean'
					? raw.onlineEnabled
					: typeof raw.online_enabled === 'boolean'
						? raw.online_enabled
						: true,
		waitlistEnabled:
			typeof raw.waitlistEnabled === 'boolean'
				? raw.waitlistEnabled
				: typeof raw.waitlist_enabled === 'boolean'
					? raw.waitlist_enabled
					: true,
		slotIntervalMin: Number(
			raw.slotIntervalMin ?? raw.intervalMin ?? raw.interval_min ?? 15,
		),
		defaultTurnTimeMin: Number(
			raw.defaultTurnTimeMin ??
				raw.defaultTurnMin ??
				raw.default_turn_min ??
				90,
		),
		minAdvanceMinutes: Number(
			raw.minAdvanceMinutes ?? raw.minNoticeMin ?? raw.min_notice_min ?? 30,
		),
		maxAdvanceDays: Number(
			raw.maxAdvanceDays ?? raw.horizonDays ?? raw.horizon_days ?? 60,
		),
		onlinePartyMin: Number(raw.onlinePartyMin ?? raw.online_party_min ?? 1),
		onlinePartyMax: Number(raw.onlinePartyMax ?? raw.online_party_max ?? 8),
		partyMax: Number(raw.partyMax ?? raw.party_max ?? 12),
		holdTtlSeconds,
		gracePeriodMinutes: Number(
			raw.gracePeriodMinutes ?? raw.lateGraceMin ?? raw.late_grace_min ?? 15,
		),
		lateCancelHours,
		cancellationCutoffMin: Number(
			raw.cancellationCutoffMin ?? guestCutoffMin ?? lateCancelHours * 60,
		),
		modificationCutoffMin: Number(
			raw.modificationCutoffMin ?? guestCutoffMin ?? lateCancelHours * 60,
		),
		pacingMaxCoversPerSlot:
			typeof raw.pacingMaxCoversPerSlot === 'number'
				? raw.pacingMaxCoversPerSlot
				: null,
		pacingMaxPartiesPerSlot:
			typeof raw.pacingMaxPartiesPerSlot === 'number'
				? raw.pacingMaxPartiesPerSlot
				: null,
		autoConfirmOnline:
			typeof raw.autoConfirmOnline === 'boolean' ? raw.autoConfirmOnline : true,
		autoAssignTables:
			typeof raw.autoAssignTables === 'boolean' ? raw.autoAssignTables : true,
		confirmationCopyI18n: (raw.confirmationCopyI18n ??
			raw.publicNoteI18n ??
			raw.public_note_i18n ??
			{}) as LocalizedCopy,
		policyCopyI18n: (raw.policyCopyI18n ??
			raw.largePartyNoteI18n ??
			raw.large_party_note_i18n ??
			{}) as LocalizedCopy,
		timeZone: String(raw.timeZone ?? raw.time_zone ?? 'UTC'),
		contextTimeZone: String(
			raw.contextTimeZone ??
				raw.context_time_zone ??
				raw.timeZone ??
				raw.time_zone ??
				'UTC',
		),
		tzSyncedAt:
			typeof raw.tzSyncedAt === 'number'
				? raw.tzSyncedAt
				: typeof raw.tz_synced_at === 'number'
					? raw.tz_synced_at
					: null,
		tzMismatch: Boolean(raw.tzMismatch ?? raw.tz_mismatch ?? false),
		floorPlanVersion: Number(
			raw.floorPlanVersion ?? raw.floor_plan_version ?? 1,
		),
		version: Number(raw.version ?? 1),
	}
}

export function normalizeArea(rawInput: unknown): DiningAreaDto {
	const raw =
		rawInput && typeof rawInput === 'object'
			? (rawInput as Record<string, unknown>)
			: {}
	const archivedAt =
		typeof raw.archivedAt === 'number'
			? raw.archivedAt
			: typeof raw.archived_at === 'number'
				? raw.archived_at
				: null
	return {
		...(raw as Partial<DiningAreaDto>),
		id: String(raw.id ?? ''),
		locationId: String(raw.locationId ?? raw.location_id ?? ''),
		name: String(raw.name ?? ''),
		nameI18n: (raw.nameI18n ?? raw.name_i18n ?? {}) as LocalizedCopy,
		floorLabel: typeof raw.floorLabel === 'string' ? raw.floorLabel : null,
		sortOrder: Number(raw.sortOrder ?? raw.sort ?? 0),
		isOutdoor: Boolean(raw.isOutdoor ?? raw.is_outdoor ?? false),
		isBookableOnline:
			typeof raw.isBookableOnline === 'boolean'
				? raw.isBookableOnline
				: typeof raw.onlineBookable === 'boolean'
					? raw.onlineBookable
					: typeof raw.online_bookable === 'boolean'
						? raw.online_bookable
						: true,
		onlinePriority: Number(raw.onlinePriority ?? raw.priority ?? 0),
		isActive:
			typeof raw.isActive === 'boolean'
				? raw.isActive
				: typeof raw.active === 'boolean'
					? raw.active
					: archivedAt === null,
		archivedAt,
		version: Number(raw.version ?? 1),
	}
}

export function normalizeTable(rawInput: unknown): TableDto {
	const raw =
		rawInput && typeof rawInput === 'object'
			? (rawInput as Record<string, unknown>)
			: {}
	const archivedAt =
		typeof raw.archivedAt === 'number'
			? raw.archivedAt
			: typeof raw.archived_at === 'number'
				? raw.archived_at
				: null
	const rawShape = String(raw.shape ?? 'square')
	const validShapes = new Set([
		'round',
		'square',
		'rect',
		'booth',
		'bar',
		'high_top',
	])
	const normalizedShape: TableShape =
		rawShape === 'counter'
			? 'bar'
			: validShapes.has(rawShape)
				? (rawShape as TableShape)
				: 'square'
	return {
		...(raw as Partial<TableDto>),
		id: String(raw.id ?? ''),
		locationId: String(raw.locationId ?? raw.location_id ?? ''),
		areaId: String(raw.areaId ?? raw.area_id ?? ''),
		label: String(raw.label ?? raw.name ?? ''),
		minCovers: Number(raw.minCovers ?? raw.min_covers ?? raw.minSeats ?? 1),
		maxCovers: Number(raw.maxCovers ?? raw.max_covers ?? raw.maxSeats ?? 2),
		shape: normalizedShape,
		x: Number(raw.x ?? 0),
		y: Number(raw.y ?? 0),
		width: Number(raw.width ?? raw.w ?? 70),
		height: Number(raw.height ?? raw.h ?? 70),
		rotation: Number(raw.rotation ?? 0),
		combinable:
			typeof raw.combinable === 'boolean'
				? raw.combinable
				: Boolean(raw.isCombable ?? true),
		isBookableOnline:
			typeof raw.isBookableOnline === 'boolean'
				? raw.isBookableOnline
				: typeof raw.onlineBookable === 'boolean'
					? raw.onlineBookable
					: typeof raw.online_bookable === 'boolean'
						? raw.online_bookable
						: true,
		isAccessible: Boolean(raw.isAccessible ?? false),
		isHighTop: Boolean(raw.isHighTop ?? raw.shape === 'high_top'),
		isPatio: Boolean(raw.isPatio ?? false),
		resetBufferMin: Number(
			raw.resetBufferMin ?? raw.reset_buffer_min ?? raw.turnBufferMin ?? 0,
		),
		priority: Number(raw.priority ?? 0),
		notes: typeof raw.notes === 'string' ? raw.notes : null,
		isActive:
			typeof raw.isActive === 'boolean'
				? raw.isActive
				: typeof raw.active === 'boolean'
					? raw.active
					: archivedAt === null,
		archivedAt,
		version: Number(raw.version ?? 1),
	}
}

export function normalizeCombo(rawInput: unknown): TableCombinationDto {
	const raw =
		rawInput && typeof rawInput === 'object'
			? (rawInput as Record<string, unknown>)
			: {}
	const archivedAt =
		typeof raw.archivedAt === 'number'
			? raw.archivedAt
			: typeof raw.archived_at === 'number'
				? raw.archived_at
				: null
	return {
		...(raw as Partial<TableCombinationDto>),
		id: String(raw.id ?? ''),
		locationId: String(raw.locationId ?? raw.location_id ?? ''),
		areaId:
			typeof raw.areaId === 'string'
				? raw.areaId
				: typeof raw.area_id === 'string'
					? raw.area_id
					: null,
		name: String(raw.name ?? raw.label ?? 'Combo'),
		minCovers: Number(raw.minCovers ?? raw.min_covers ?? raw.minSeats ?? 2),
		maxCovers: Number(raw.maxCovers ?? raw.max_covers ?? raw.maxSeats ?? 6),
		priority: Number(raw.priority ?? 0),
		isBookableOnline:
			typeof raw.isBookableOnline === 'boolean'
				? raw.isBookableOnline
				: typeof raw.onlineBookable === 'boolean'
					? raw.onlineBookable
					: typeof raw.online_bookable === 'boolean'
						? raw.online_bookable
						: true,
		isActive:
			typeof raw.isActive === 'boolean'
				? raw.isActive
				: typeof raw.active === 'boolean'
					? raw.active
					: archivedAt === null,
		tableIds: Array.isArray(raw.tableIds)
			? (raw.tableIds as string[])
			: Array.isArray(raw.table_ids)
				? (raw.table_ids as string[])
				: [],
		version: Number(raw.version ?? 1),
	}
}

export function normalizeElement(rawInput: unknown): FloorElementDto {
	const raw =
		rawInput && typeof rawInput === 'object'
			? (rawInput as Record<string, unknown>)
			: {}
	return {
		...(raw as Partial<FloorElementDto>),
		id: String(raw.id ?? ''),
		areaId:
			typeof raw.areaId === 'string'
				? raw.areaId
				: typeof raw.area_id === 'string'
					? raw.area_id
					: null,
		kind: (raw.kind ?? 'wall') as FloorElementKind,
		label: typeof raw.label === 'string' ? raw.label : null,
		x: Number(raw.x ?? 0),
		y: Number(raw.y ?? 0),
		width: Number(raw.width ?? raw.w ?? 100),
		height: Number(raw.height ?? raw.h ?? 20),
		rotation: Number(raw.rotation ?? 0),
		style:
			raw.style && typeof raw.style === 'object'
				? (raw.style as Record<string, unknown>)
				: {},
	}
}

export function normalizeService(rawInput: unknown): ServiceDto {
	const raw =
		rawInput && typeof rawInput === 'object'
			? (rawInput as Record<string, unknown>)
			: {}
	const archivedAt =
		typeof raw.archivedAt === 'number'
			? raw.archivedAt
			: typeof raw.archived_at === 'number'
				? raw.archived_at
				: null
	const daysOfWeek = Array.isArray(raw.daysOfWeek)
		? (raw.daysOfWeek as number[])
		: daysMaskToDaysOfWeek(Number(raw.daysMask ?? raw.days_mask ?? 127))
	const nameStr = String(raw.name ?? 'Service')
	const onlineBookable =
		typeof raw.onlineBookable === 'boolean'
			? raw.onlineBookable
			: typeof raw.onlineEnabled === 'boolean'
				? raw.onlineEnabled
				: typeof raw.online_enabled === 'boolean'
					? raw.online_enabled
					: typeof raw.isBookableOnline === 'boolean'
						? raw.isBookableOnline
						: true
	return {
		...(raw as Partial<ServiceDto>),
		id: String(raw.id ?? ''),
		locationId: String(raw.locationId ?? raw.location_id ?? ''),
		name: nameStr,
		nameI18n: (raw.nameI18n ?? raw.name_i18n ?? {}) as LocalizedCopy,
		code: String(
			raw.code ?? raw.slug ?? nameStr.toLowerCase().replace(/[^a-z0-9]+/g, '_'),
		),
		daysOfWeek,
		firstSeatingMin: Number(
			raw.firstSeatingMin ?? raw.first_seating_min ?? raw.startMin ?? 1020,
		),
		lastSeatingMin: Number(raw.lastSeatingMin ?? raw.last_seating_min ?? 1290),
		endMin: Number(raw.endMin ?? raw.end_min ?? 1380),
		slotIntervalMin:
			raw.slotIntervalMin !== undefined
				? (raw.slotIntervalMin as number | null)
				: typeof raw.intervalMin === 'number'
					? raw.intervalMin
					: typeof raw.interval_min === 'number'
						? raw.interval_min
						: null,
		defaultTurnTimeMin:
			typeof raw.defaultTurnTimeMin === 'number'
				? raw.defaultTurnTimeMin
				: null,
		onlineBookable,
		isBookableOnline: onlineBookable,
		sortOrder: Number(raw.sortOrder ?? raw.sort ?? 0),
		color:
			typeof raw.color === 'string'
				? raw.color
				: typeof raw.colorToken === 'string'
					? raw.colorToken
					: typeof raw.color_token === 'string'
						? raw.color_token
						: null,
		isActive:
			typeof raw.isActive === 'boolean'
				? raw.isActive
				: typeof raw.active === 'boolean'
					? raw.active
					: archivedAt === null,
		archivedAt,
		version: Number(raw.version ?? 1),
	}
}

export function normalizeTurnTime(rawInput: unknown): TurnTimeRuleDto {
	const raw =
		rawInput && typeof rawInput === 'object'
			? (rawInput as Record<string, unknown>)
			: {}
	const minutes = Number(
		raw.minutes ?? raw.turnTimeMin ?? raw.turnMin ?? raw.durationMin ?? 90,
	)
	return {
		...(raw as Partial<TurnTimeRuleDto>),
		id: String(raw.id ?? ''),
		locationId: String(raw.locationId ?? raw.location_id ?? ''),
		serviceId:
			typeof raw.serviceId === 'string'
				? raw.serviceId
				: typeof raw.service_id === 'string'
					? raw.service_id
					: null,
		partyMin: Number(raw.partyMin ?? raw.party_min ?? raw.minParty ?? 1),
		partyMax: Number(raw.partyMax ?? raw.party_max ?? raw.maxParty ?? 2),
		minutes,
		turnTimeMin: minutes,
		bufferMinutes: Number(raw.bufferMinutes ?? raw.bufferMin ?? 0),
		version: Number(raw.version ?? 1),
	}
}

export function normalizePacingRule(rawInput: unknown): PacingRuleDto {
	const raw =
		rawInput && typeof rawInput === 'object'
			? (rawInput as Record<string, unknown>)
			: {}
	const bucketMin = Number(
		raw.bucketMin ?? raw.bucket_min ?? raw.windowMinutes ?? 15,
	)
	const maxCovers =
		typeof raw.maxCovers === 'number'
			? raw.maxCovers
			: typeof raw.max_covers === 'number'
				? raw.max_covers
				: typeof raw.maxCoversPerSlot === 'number'
					? raw.maxCoversPerSlot
					: null
	const maxParties =
		typeof raw.maxParties === 'number'
			? raw.maxParties
			: typeof raw.max_parties === 'number'
				? raw.max_parties
				: typeof raw.maxPartiesPerSlot === 'number'
					? raw.maxPartiesPerSlot
					: null
	return {
		...(raw as Partial<PacingRuleDto>),
		id: String(raw.id ?? ''),
		locationId: String(raw.locationId ?? raw.location_id ?? ''),
		serviceId:
			typeof raw.serviceId === 'string'
				? raw.serviceId
				: typeof raw.service_id === 'string'
					? raw.service_id
					: null,
		bucketMin,
		windowMinutes: bucketMin,
		fromMin:
			typeof raw.fromMin === 'number'
				? raw.fromMin
				: typeof raw.from_min === 'number'
					? raw.from_min
					: null,
		toMin:
			typeof raw.toMin === 'number'
				? raw.toMin
				: typeof raw.to_min === 'number'
					? raw.to_min
					: null,
		maxCovers,
		maxCoversPerSlot: maxCovers,
		maxParties,
		maxPartiesPerSlot: maxParties,
		rollingMin:
			typeof raw.rollingMin === 'number'
				? raw.rollingMin
				: typeof raw.rolling_min === 'number'
					? raw.rolling_min
					: null,
		rollingMaxCovers:
			typeof raw.rollingMaxCovers === 'number'
				? raw.rollingMaxCovers
				: typeof raw.rolling_max_covers === 'number'
					? raw.rolling_max_covers
					: null,
		channel: raw.channel === 'online' ? 'online' : 'all',
		version: Number(raw.version ?? 1),
	}
}

export function normalizeServiceAvailability(
	rawInput: unknown,
): ServiceAvailabilityDto {
	const raw =
		rawInput && typeof rawInput === 'object'
			? (rawInput as Record<string, unknown>)
			: {}
	return {
		...(raw as Partial<ServiceAvailabilityDto>),
		id: String(raw.id ?? ''),
		locationId: String(raw.locationId ?? raw.location_id ?? ''),
		serviceId: String(raw.serviceId ?? raw.service_id ?? ''),
		areaId:
			typeof raw.areaId === 'string'
				? raw.areaId
				: typeof raw.area_id === 'string'
					? raw.area_id
					: null,
		tableId:
			typeof raw.tableId === 'string'
				? raw.tableId
				: typeof raw.table_id === 'string'
					? raw.table_id
					: null,
		comboId:
			typeof raw.comboId === 'string'
				? raw.comboId
				: typeof raw.combo_id === 'string'
					? raw.combo_id
					: null,
		mode: (raw.mode ?? 'online') as ServiceAvailabilityMode,
		fromMin:
			typeof raw.fromMin === 'number'
				? raw.fromMin
				: typeof raw.from_min === 'number'
					? raw.from_min
					: null,
		toMin:
			typeof raw.toMin === 'number'
				? raw.toMin
				: typeof raw.to_min === 'number'
					? raw.to_min
					: null,
		version: Number(raw.version ?? 1),
	}
}

export function normalizeSpecialDay(rawInput: unknown): SpecialDayDto {
	const raw =
		rawInput && typeof rawInput === 'object'
			? (rawInput as Record<string, unknown>)
			: {}
	const fromDate = String(raw.fromDate ?? raw.from_date ?? raw.date ?? '')
	const toDate = String(raw.toDate ?? raw.to_date ?? fromDate)
	const publicNoteI18n = (raw.publicNoteI18n ??
		raw.public_note_i18n ??
		{}) as LocalizedCopy
	const nameVal =
		typeof raw.name === 'string' && raw.name.trim()
			? raw.name
			: typeof raw.reason === 'string' && raw.reason.trim()
				? raw.reason
				: typeof publicNoteI18n.en === 'string' && publicNoteI18n.en.trim()
					? publicNoteI18n.en
					: null
	return {
		...(raw as Partial<SpecialDayDto>),
		id: String(raw.id ?? ''),
		locationId: String(raw.locationId ?? raw.location_id ?? ''),
		date: String(raw.date ?? fromDate),
		fromDate,
		toDate,
		kind: (raw.kind ?? raw.type ?? 'closed') as SpecialDayKind,
		name: nameVal,
		reason: nameVal,
		publicNoteI18n,
		serviceId:
			typeof raw.serviceId === 'string'
				? raw.serviceId
				: typeof raw.service_id === 'string'
					? raw.service_id
					: null,
		patch: (raw.patch ?? null) as SpecialDayDto['patch'],
		services: Array.isArray(raw.services)
			? (raw.services as SpecialDayDto['services'])
			: null,
		version: Number(raw.version ?? 1),
	}
}

export function normalizeBlock(rawInput: unknown): BlockDto {
	const raw =
		rawInput && typeof rawInput === 'object'
			? (rawInput as Record<string, unknown>)
			: {}
	return {
		...(raw as Partial<BlockDto>),
		id: String(raw.id ?? ''),
		locationId: String(raw.locationId ?? raw.location_id ?? ''),
		areaId:
			typeof raw.areaId === 'string'
				? raw.areaId
				: typeof raw.area_id === 'string'
					? raw.area_id
					: null,
		tableId:
			typeof raw.tableId === 'string'
				? raw.tableId
				: typeof raw.table_id === 'string'
					? raw.table_id
					: null,
		businessDate: String(raw.businessDate ?? raw.business_date ?? ''),
		startAt: Number(raw.startAt ?? raw.start_at ?? 0),
		endAt: Number(raw.endAt ?? raw.end_at ?? 0),
		startMin:
			typeof raw.startMin === 'number'
				? raw.startMin
				: typeof raw.start_min === 'number'
					? raw.start_min
					: null,
		endMin:
			typeof raw.endMin === 'number'
				? raw.endMin
				: typeof raw.end_min === 'number'
					? raw.end_min
					: null,
		reason: (raw.reason ?? 'other') as BlockReason,
		note: typeof raw.note === 'string' ? raw.note : null,
		version: Number(raw.version ?? 1),
	}
}

/**
 * The API stores a block as epoch instants; the list shows local minutes since
 * midnight of the block's business date (a window past midnight keeps counting).
 */
export function blockLocalWindow(
	block: Pick<
		BlockDto,
		'businessDate' | 'startAt' | 'endAt' | 'startMin' | 'endMin'
	>,
	timeZone: string | null | undefined,
): { startMin: number; endMin: number } {
	if (block.startMin !== null && block.endMin !== null) {
		return { startMin: block.startMin, endMin: block.endMin }
	}
	const toMinutes = (ms: number): number => {
		try {
			const parts = new Intl.DateTimeFormat('en-CA', {
				timeZone: timeZone || 'UTC',
				year: 'numeric',
				month: '2-digit',
				day: '2-digit',
				hour: '2-digit',
				minute: '2-digit',
				hourCycle: 'h23',
			}).formatToParts(new Date(ms))
			const get = (type: string) =>
				Number(parts.find((p) => p.type === type)?.value ?? 0)
			const localDay = Date.UTC(get('year'), get('month') - 1, get('day'))
			const [y, m, d] = block.businessDate.split('-').map(Number)
			const businessDay = Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1)
			const dayOffset = Math.round((localDay - businessDay) / 86_400_000)
			return dayOffset * 1440 + get('hour') * 60 + get('minute')
		} catch {
			return 0
		}
	}
	return { startMin: toMinutes(block.startAt), endMin: toMinutes(block.endAt) }
}

export function normalizeFloorPlanPayload(rawInput: unknown): FloorPlanPayload {
	const raw =
		rawInput && typeof rawInput === 'object'
			? (rawInput as Record<string, unknown>)
			: {}
	const areas = Array.isArray(raw.areas) ? raw.areas.map(normalizeArea) : []
	const tables = Array.isArray(raw.tables) ? raw.tables.map(normalizeTable) : []
	const rawCombos = Array.isArray(raw.combos)
		? raw.combos
		: Array.isArray(raw.combinations)
			? raw.combinations
			: []
	const combos = rawCombos.map(normalizeCombo)
	const elements = Array.isArray(raw.elements)
		? raw.elements.map(normalizeElement)
		: []
	const fpVer = Number(
		raw.floorPlanVersion ?? raw.floor_plan_version ?? raw.version ?? 1,
	)
	return {
		locationId: String(raw.locationId ?? raw.location_id ?? ''),
		floorPlanVersion: fpVer,
		version: Number(raw.version ?? fpVer),
		areas,
		tables,
		combos,
		combinations: combos,
		elements,
		conflicts: Array.isArray(raw.conflicts)
			? (raw.conflicts as SetupConflictDto[])
			: undefined,
		reflowedMoves: Array.isArray(raw.reflowedMoves)
			? (raw.reflowedMoves as ReflowedMoveDto[])
			: undefined,
	}
}

// --- Client API wrappers ---

const SETUP_BASE = '/operator/reservations/setup'

export async function fetchLocationSettings(
	client: ReservationsScopedClient,
	locationId: string,
	signal?: AbortSignal,
): Promise<{ settings: LocationSettingsDto }> {
	const res = await client.request<
		{ settings?: LocationSettingsDto } & Partial<LocationSettingsDto>
	>(`${SETUP_BASE}/locations/${encodeURIComponent(locationId)}/settings`, {
		signal,
	})
	const settings = normalizeLocationSettings(res.settings ?? res)
	return { settings }
}

export async function updateLocationSettings(
	client: ReservationsScopedClient,
	locationId: string,
	patch: Partial<LocationSettingsDto> & { expectedVersion: number },
): Promise<{ settings: LocationSettingsDto }> {
	const res = await client.request<
		{ settings?: LocationSettingsDto } & Partial<LocationSettingsDto>
	>(`${SETUP_BASE}/locations/${encodeURIComponent(locationId)}/settings`, {
		method: 'PUT',
		body: patch,
	})
	const settings = normalizeLocationSettings(res.settings ?? res)
	return { settings }
}

export async function rederiveLocationTimes(
	client: ReservationsScopedClient,
	locationId: string,
	timeZone?: string,
): Promise<{
	timeZone: string
	tzSyncedAt: number
	updatedReservations: number
	settings: LocationSettingsDto
}> {
	return client.request(
		`${SETUP_BASE}/locations/${encodeURIComponent(locationId)}/rederive-times`,
		{
			method: 'POST',
			body: timeZone ? { timeZone } : {},
		},
	)
}

export async function fetchFloorPlan(
	client: ReservationsScopedClient,
	locationId: string,
	signal?: AbortSignal,
): Promise<FloorPlanPayload> {
	const res = await client.request<FloorPlanPayload>(
		`${SETUP_BASE}/locations/${encodeURIComponent(locationId)}/floor-plan`,
		{ signal },
	)
	return normalizeFloorPlanPayload(res)
}

export async function saveFloorPlan(
	client: ReservationsScopedClient,
	locationId: string,
	payload: {
		expectedFloorPlanVersion: number
		areas: Array<Partial<DiningAreaDto> & { id: string; name: string }>
		tables: Array<
			Partial<TableDto> & { id: string; areaId: string; label: string }
		>
		combos?: Array<
			Partial<TableCombinationDto> & {
				id: string
				name: string
				tableIds: string[]
			}
		>
		elements: Array<
			Partial<FloorElementDto> & { id: string; kind: FloorElementKind }
		>
		archiveMissingTables?: boolean
	},
): Promise<FloorPlanPayload> {
	const res = await client.request<FloorPlanPayload>(
		`${SETUP_BASE}/locations/${encodeURIComponent(locationId)}/floor-plan`,
		{
			method: 'PUT',
			body: payload,
		},
	)
	return normalizeFloorPlanPayload(res)
}

export async function fetchAreas(
	client: ReservationsScopedClient,
	locationId: string,
	includeArchived = false,
	signal?: AbortSignal,
): Promise<{ areas: DiningAreaDto[] }> {
	const res = await client.request<{ areas?: DiningAreaDto[] }>(
		`${SETUP_BASE}/locations/${encodeURIComponent(locationId)}/areas`,
		{
			query: includeArchived ? { includeArchived: 'true' } : undefined,
			signal,
		},
	)
	return { areas: (res.areas ?? []).map(normalizeArea) }
}

export async function createArea(
	client: ReservationsScopedClient,
	locationId: string,
	body: {
		name: string
		nameI18n?: LocalizedCopy
		floorLabel?: string | null
		sortOrder?: number
		isOutdoor?: boolean
		isBookableOnline?: boolean
		onlinePriority?: number
	},
): Promise<{ area: DiningAreaDto; floorPlanVersion: number }> {
	const res = await client.request<{
		area?: DiningAreaDto
		floorPlanVersion?: number
	}>(`${SETUP_BASE}/locations/${encodeURIComponent(locationId)}/areas`, {
		method: 'POST',
		body: {
			...body,
			sort: body.sortOrder,
			onlineBookable: body.isBookableOnline,
		},
	})
	return {
		area: normalizeArea(res.area ?? res),
		floorPlanVersion: Number(res.floorPlanVersion ?? 1),
	}
}

export async function updateArea(
	client: ReservationsScopedClient,
	locationId: string,
	areaId: string,
	body: Partial<DiningAreaDto> & { expectedVersion?: number },
): Promise<{
	area: DiningAreaDto
	floorPlanVersion: number
	conflicts?: SetupConflictDto[]
	reflowedMoves?: ReflowedMoveDto[]
}> {
	const res = await client.request<{
		area?: DiningAreaDto
		floorPlanVersion?: number
		conflicts?: SetupConflictDto[]
		reflowedMoves?: ReflowedMoveDto[]
	}>(
		`${SETUP_BASE}/locations/${encodeURIComponent(locationId)}/areas/${encodeURIComponent(areaId)}`,
		{
			method: 'PUT',
			body: {
				...body,
				...(body.sortOrder !== undefined ? { sort: body.sortOrder } : {}),
				...(body.isBookableOnline !== undefined
					? { onlineBookable: body.isBookableOnline }
					: {}),
			},
		},
	)
	return {
		...res,
		area: normalizeArea(res.area ?? res),
		floorPlanVersion: Number(res.floorPlanVersion ?? 1),
	}
}

export async function deleteArea(
	client: ReservationsScopedClient,
	locationId: string,
	areaId: string,
): Promise<{
	area: DiningAreaDto
	floorPlanVersion: number
	conflicts?: SetupConflictDto[]
	reflowedMoves?: ReflowedMoveDto[]
}> {
	const res = await client.request<{
		area?: DiningAreaDto
		floorPlanVersion?: number
		conflicts?: SetupConflictDto[]
		reflowedMoves?: ReflowedMoveDto[]
	}>(
		`${SETUP_BASE}/locations/${encodeURIComponent(locationId)}/areas/${encodeURIComponent(areaId)}`,
		{
			method: 'DELETE',
		},
	)
	return {
		...res,
		area: normalizeArea(res.area ?? res),
		floorPlanVersion: Number(res.floorPlanVersion ?? 1),
	}
}

export async function fetchTables(
	client: ReservationsScopedClient,
	locationId: string,
	includeArchived = false,
	signal?: AbortSignal,
): Promise<{ tables: TableDto[] }> {
	const res = await client.request<{ tables?: TableDto[] }>(
		`${SETUP_BASE}/locations/${encodeURIComponent(locationId)}/tables`,
		{
			query: includeArchived ? { includeArchived: 'true' } : undefined,
			signal,
		},
	)
	return { tables: (res.tables ?? []).map(normalizeTable) }
}

export async function createTable(
	client: ReservationsScopedClient,
	locationId: string,
	body: {
		areaId: string
		label: string
		minCovers: number
		maxCovers: number
		shape?: TableShape
		x?: number
		y?: number
		width?: number
		height?: number
		rotation?: number
		combinable?: boolean
		isBookableOnline?: boolean
		isAccessible?: boolean
		isHighTop?: boolean
		isPatio?: boolean
		resetBufferMin?: number
		priority?: number
		notes?: string | null
	},
): Promise<{
	table: TableDto
	floorPlanVersion: number
	conflicts?: SetupConflictDto[]
	reflowedMoves?: ReflowedMoveDto[]
}> {
	const normalizedShape =
		body.shape === 'high_top' ? 'round' : (body.shape ?? 'square')
	const res = await client.request<{
		table?: TableDto
		floorPlanVersion?: number
		conflicts?: SetupConflictDto[]
		reflowedMoves?: ReflowedMoveDto[]
	}>(`${SETUP_BASE}/locations/${encodeURIComponent(locationId)}/tables`, {
		method: 'POST',
		body: {
			...body,
			shape: normalizedShape,
			w: body.width,
			h: body.height,
			onlineBookable: body.isBookableOnline,
		},
	})
	return {
		...res,
		table: normalizeTable(res.table ?? res),
		floorPlanVersion: Number(res.floorPlanVersion ?? 1),
	}
}

export async function updateTable(
	client: ReservationsScopedClient,
	locationId: string,
	tableId: string,
	body: Partial<TableDto> & { expectedVersion?: number },
): Promise<{
	table: TableDto
	floorPlanVersion: number
	conflicts?: SetupConflictDto[]
	reflowedMoves?: ReflowedMoveDto[]
}> {
	const normalizedShape = body.shape === 'high_top' ? 'round' : body.shape
	const res = await client.request<{
		table?: TableDto
		floorPlanVersion?: number
		conflicts?: SetupConflictDto[]
		reflowedMoves?: ReflowedMoveDto[]
	}>(
		`${SETUP_BASE}/locations/${encodeURIComponent(locationId)}/tables/${encodeURIComponent(tableId)}`,
		{
			method: 'PUT',
			body: {
				...body,
				...(normalizedShape !== undefined ? { shape: normalizedShape } : {}),
				...(body.width !== undefined ? { w: body.width } : {}),
				...(body.height !== undefined ? { h: body.height } : {}),
				...(body.isBookableOnline !== undefined
					? { onlineBookable: body.isBookableOnline }
					: {}),
			},
		},
	)
	return {
		...res,
		table: normalizeTable(res.table ?? res),
		floorPlanVersion: Number(res.floorPlanVersion ?? 1),
	}
}

export async function deleteTable(
	client: ReservationsScopedClient,
	locationId: string,
	tableId: string,
): Promise<{
	table: TableDto
	floorPlanVersion: number
	conflicts?: SetupConflictDto[]
	reflowedMoves?: ReflowedMoveDto[]
}> {
	const res = await client.request<{
		table?: TableDto
		floorPlanVersion?: number
		conflicts?: SetupConflictDto[]
		reflowedMoves?: ReflowedMoveDto[]
	}>(
		`${SETUP_BASE}/locations/${encodeURIComponent(locationId)}/tables/${encodeURIComponent(tableId)}`,
		{
			method: 'DELETE',
		},
	)
	return {
		...res,
		table: normalizeTable(res.table ?? res),
		floorPlanVersion: Number(res.floorPlanVersion ?? 1),
	}
}

export async function fetchCombinations(
	client: ReservationsScopedClient,
	locationId: string,
	signal?: AbortSignal,
): Promise<{ combos: TableCombinationDto[] }> {
	const res = await client.request<{
		combos?: TableCombinationDto[]
		combinations?: TableCombinationDto[]
	}>(`${SETUP_BASE}/locations/${encodeURIComponent(locationId)}/combos`, {
		signal,
	})
	return {
		combos: (res.combos ?? res.combinations ?? []).map(normalizeCombo),
	}
}

export async function createCombination(
	client: ReservationsScopedClient,
	locationId: string,
	body: {
		name: string
		areaId?: string | null
		minCovers: number
		maxCovers: number
		priority?: number
		isBookableOnline?: boolean
		tableIds: string[]
	},
): Promise<{
	combo: TableCombinationDto
	floorPlanVersion: number
	conflicts?: SetupConflictDto[]
	reflowedMoves?: ReflowedMoveDto[]
}> {
	const res = await client.request<{
		combo?: TableCombinationDto
		combination?: TableCombinationDto
		floorPlanVersion?: number
		conflicts?: SetupConflictDto[]
		reflowedMoves?: ReflowedMoveDto[]
	}>(`${SETUP_BASE}/locations/${encodeURIComponent(locationId)}/combos`, {
		method: 'POST',
		body: {
			...body,
			label: body.name,
			onlineBookable: body.isBookableOnline,
		},
	})
	return {
		...res,
		combo: normalizeCombo(res.combo ?? res.combination ?? res),
		floorPlanVersion: Number(res.floorPlanVersion ?? 1),
	}
}

export async function updateCombination(
	client: ReservationsScopedClient,
	locationId: string,
	comboId: string,
	body: Partial<TableCombinationDto> & { expectedVersion?: number },
): Promise<{
	combo: TableCombinationDto
	floorPlanVersion: number
	conflicts?: SetupConflictDto[]
	reflowedMoves?: ReflowedMoveDto[]
}> {
	const res = await client.request<{
		combo?: TableCombinationDto
		combination?: TableCombinationDto
		floorPlanVersion?: number
		conflicts?: SetupConflictDto[]
		reflowedMoves?: ReflowedMoveDto[]
	}>(
		`${SETUP_BASE}/locations/${encodeURIComponent(locationId)}/combos/${encodeURIComponent(comboId)}`,
		{
			method: 'PUT',
			body: {
				...body,
				...(body.name !== undefined ? { label: body.name } : {}),
				...(body.isBookableOnline !== undefined
					? { onlineBookable: body.isBookableOnline }
					: {}),
			},
		},
	)
	return {
		...res,
		combo: normalizeCombo(res.combo ?? res.combination ?? res),
		floorPlanVersion: Number(res.floorPlanVersion ?? 1),
	}
}

export async function deleteCombination(
	client: ReservationsScopedClient,
	locationId: string,
	comboId: string,
): Promise<{
	deleted: boolean
	floorPlanVersion: number
	conflicts?: SetupConflictDto[]
	reflowedMoves?: ReflowedMoveDto[]
}> {
	return client.request(
		`${SETUP_BASE}/locations/${encodeURIComponent(locationId)}/combos/${encodeURIComponent(comboId)}`,
		{
			method: 'DELETE',
		},
	)
}

export async function fetchServices(
	client: ReservationsScopedClient,
	locationId: string,
	includeArchived = false,
	signal?: AbortSignal,
): Promise<{ services: ServiceDto[] }> {
	const res = await client.request<{ services?: ServiceDto[] }>(
		`${SETUP_BASE}/locations/${encodeURIComponent(locationId)}/services`,
		{
			query: includeArchived ? { includeArchived: 'true' } : undefined,
			signal,
		},
	)
	return { services: (res.services ?? []).map(normalizeService) }
}

export async function createService(
	client: ReservationsScopedClient,
	locationId: string,
	body: {
		name: string
		nameI18n?: LocalizedCopy
		code?: string
		daysOfWeek: number[]
		firstSeatingMin: number
		lastSeatingMin: number
		endMin: number
		slotIntervalMin?: number | null
		defaultTurnTimeMin?: number | null
		onlineBookable?: boolean
		sortOrder?: number
		color?: string | null
	},
): Promise<{
	service: ServiceDto
	conflicts?: SetupConflictDto[]
	reflowedMoves?: ReflowedMoveDto[]
}> {
	const res = await client.request<{
		service?: ServiceDto
		conflicts?: SetupConflictDto[]
		reflowedMoves?: ReflowedMoveDto[]
	}>(`${SETUP_BASE}/locations/${encodeURIComponent(locationId)}/services`, {
		method: 'POST',
		body: {
			...body,
			daysMask: daysOfWeekToDaysMask(body.daysOfWeek),
			intervalMin: body.slotIntervalMin,
			onlineEnabled: body.onlineBookable,
			sort: body.sortOrder,
			colorToken: body.color,
		},
	})
	return {
		...res,
		service: normalizeService(res.service ?? res),
	}
}

export async function updateService(
	client: ReservationsScopedClient,
	locationId: string,
	serviceId: string,
	body: Partial<ServiceDto> & { expectedVersion?: number },
): Promise<{
	service: ServiceDto
	conflicts?: SetupConflictDto[]
	reflowedMoves?: ReflowedMoveDto[]
}> {
	const res = await client.request<{
		service?: ServiceDto
		conflicts?: SetupConflictDto[]
		reflowedMoves?: ReflowedMoveDto[]
	}>(
		`${SETUP_BASE}/locations/${encodeURIComponent(locationId)}/services/${encodeURIComponent(serviceId)}`,
		{
			method: 'PUT',
			body: {
				...body,
				...(body.daysOfWeek !== undefined
					? { daysMask: daysOfWeekToDaysMask(body.daysOfWeek) }
					: {}),
				...(body.slotIntervalMin !== undefined
					? { intervalMin: body.slotIntervalMin }
					: {}),
				...(body.onlineBookable !== undefined
					? { onlineEnabled: body.onlineBookable }
					: {}),
				...(body.sortOrder !== undefined ? { sort: body.sortOrder } : {}),
			},
		},
	)
	return {
		...res,
		service: normalizeService(res.service ?? res),
	}
}

export async function deleteService(
	client: ReservationsScopedClient,
	locationId: string,
	serviceId: string,
): Promise<{
	service: ServiceDto
	conflicts?: SetupConflictDto[]
	reflowedMoves?: ReflowedMoveDto[]
}> {
	const res = await client.request<{
		service?: ServiceDto
		conflicts?: SetupConflictDto[]
		reflowedMoves?: ReflowedMoveDto[]
	}>(
		`${SETUP_BASE}/locations/${encodeURIComponent(locationId)}/services/${encodeURIComponent(serviceId)}`,
		{
			method: 'DELETE',
		},
	)
	return {
		...res,
		service: normalizeService(res.service ?? res),
	}
}

export async function fetchTurnTimes(
	client: ReservationsScopedClient,
	locationId: string,
	signal?: AbortSignal,
): Promise<{ turnTimes: TurnTimeRuleDto[] }> {
	const res = await client.request<{
		turnTimes?: TurnTimeRuleDto[]
		turn_times?: TurnTimeRuleDto[]
		buckets?: TurnTimeRuleDto[]
		rules?: TurnTimeRuleDto[]
	}>(`${SETUP_BASE}/locations/${encodeURIComponent(locationId)}/turn-times`, {
		signal,
	})
	const list = res.turnTimes ?? res.turn_times ?? res.buckets ?? res.rules ?? []
	return { turnTimes: list.map(normalizeTurnTime) }
}

export async function createTurnTime(
	client: ReservationsScopedClient,
	locationId: string,
	body: {
		serviceId?: string | null
		partyMin: number
		partyMax: number
		minutes: number
		bufferMinutes?: number
	},
): Promise<{ turnTime: TurnTimeRuleDto }> {
	const res = await client.request<{
		turnTime?: TurnTimeRuleDto
		bucket?: TurnTimeRuleDto
	}>(`${SETUP_BASE}/locations/${encodeURIComponent(locationId)}/turn-times`, {
		method: 'POST',
		body,
	})
	return {
		turnTime: normalizeTurnTime(res.turnTime ?? res.bucket ?? res),
	}
}

export async function updateTurnTime(
	client: ReservationsScopedClient,
	locationId: string,
	ruleId: string,
	body: Partial<TurnTimeRuleDto> & { expectedVersion?: number },
): Promise<{ turnTime: TurnTimeRuleDto }> {
	const res = await client.request<{
		turnTime?: TurnTimeRuleDto
		bucket?: TurnTimeRuleDto
	}>(
		`${SETUP_BASE}/locations/${encodeURIComponent(locationId)}/turn-times/${encodeURIComponent(ruleId)}`,
		{
			method: 'PUT',
			body,
		},
	)
	return {
		turnTime: normalizeTurnTime(res.turnTime ?? res.bucket ?? res),
	}
}

export async function deleteTurnTime(
	client: ReservationsScopedClient,
	locationId: string,
	ruleId: string,
): Promise<{ deleted: boolean }> {
	return client.request(
		`${SETUP_BASE}/locations/${encodeURIComponent(locationId)}/turn-times/${encodeURIComponent(ruleId)}`,
		{
			method: 'DELETE',
		},
	)
}

export async function fetchPacingRules(
	client: ReservationsScopedClient,
	locationId: string,
	signal?: AbortSignal,
): Promise<{ pacing: PacingRuleDto[] }> {
	const res = await client.request<{
		pacing?: PacingRuleDto[]
		pacingRules?: PacingRuleDto[]
		pacing_rules?: PacingRuleDto[]
		rules?: PacingRuleDto[]
	}>(`${SETUP_BASE}/locations/${encodeURIComponent(locationId)}/pacing`, {
		signal,
	})
	const list =
		res.pacing ?? res.pacingRules ?? res.pacing_rules ?? res.rules ?? []
	return { pacing: list.map(normalizePacingRule) }
}

export async function createPacingRule(
	client: ReservationsScopedClient,
	locationId: string,
	body: {
		serviceId?: string | null
		bucketMin?: number
		fromMin?: number | null
		toMin?: number | null
		maxCovers?: number | null
		maxParties?: number | null
		rollingMin?: number | null
		rollingMaxCovers?: number | null
		channel?: PacingChannel
	},
): Promise<{ rule: PacingRuleDto }> {
	const safeChannel: 'all' | 'online' =
		body.channel === 'online' ? 'online' : 'all'
	const res = await client.request<{
		rule?: PacingRuleDto
		pacingRule?: PacingRuleDto
	}>(`${SETUP_BASE}/locations/${encodeURIComponent(locationId)}/pacing`, {
		method: 'POST',
		body: {
			...body,
			channel: safeChannel,
		},
	})
	return {
		rule: normalizePacingRule(res.rule ?? res.pacingRule ?? res),
	}
}

export async function updatePacingRule(
	client: ReservationsScopedClient,
	locationId: string,
	ruleId: string,
	body: Partial<PacingRuleDto> & { expectedVersion?: number },
): Promise<{ rule: PacingRuleDto }> {
	const res = await client.request<{
		rule?: PacingRuleDto
		pacingRule?: PacingRuleDto
	}>(
		`${SETUP_BASE}/locations/${encodeURIComponent(locationId)}/pacing/${encodeURIComponent(ruleId)}`,
		{
			method: 'PUT',
			body,
		},
	)
	return {
		rule: normalizePacingRule(res.rule ?? res.pacingRule ?? res),
	}
}

export async function deletePacingRule(
	client: ReservationsScopedClient,
	locationId: string,
	ruleId: string,
): Promise<{ deleted: boolean }> {
	return client.request(
		`${SETUP_BASE}/locations/${encodeURIComponent(locationId)}/pacing/${encodeURIComponent(ruleId)}`,
		{
			method: 'DELETE',
		},
	)
}

export async function fetchServiceAvailability(
	client: ReservationsScopedClient,
	locationId: string,
	signal?: AbortSignal,
): Promise<{ availability: ServiceAvailabilityDto[] }> {
	const res = await client.request<{
		availability?: ServiceAvailabilityDto[]
		serviceAvailability?: ServiceAvailabilityDto[]
		rules?: ServiceAvailabilityDto[]
		items?: ServiceAvailabilityDto[]
	}>(
		`${SETUP_BASE}/locations/${encodeURIComponent(locationId)}/service-availability`,
		{ signal },
	)
	const list =
		res.availability ?? res.serviceAvailability ?? res.rules ?? res.items ?? []
	return { availability: list.map(normalizeServiceAvailability) }
}

export async function createServiceAvailability(
	client: ReservationsScopedClient,
	locationId: string,
	body: {
		serviceId: string
		areaId?: string | null
		tableId?: string | null
		comboId?: string | null
		mode: ServiceAvailabilityMode
		fromMin?: number | null
		toMin?: number | null
	},
): Promise<{ availability: ServiceAvailabilityDto }> {
	const res = await client.request<{
		availability?: ServiceAvailabilityDto
		serviceAvailability?: ServiceAvailabilityDto
		rule?: ServiceAvailabilityDto
	}>(
		`${SETUP_BASE}/locations/${encodeURIComponent(locationId)}/service-availability`,
		{
			method: 'POST',
			body,
		},
	)
	return {
		availability: normalizeServiceAvailability(
			res.availability ?? res.serviceAvailability ?? res.rule ?? res,
		),
	}
}

export async function updateServiceAvailability(
	client: ReservationsScopedClient,
	locationId: string,
	ruleId: string,
	body: Partial<ServiceAvailabilityDto> & { expectedVersion?: number },
): Promise<{ availability: ServiceAvailabilityDto }> {
	const res = await client.request<{
		availability?: ServiceAvailabilityDto
		serviceAvailability?: ServiceAvailabilityDto
		rule?: ServiceAvailabilityDto
	}>(
		`${SETUP_BASE}/locations/${encodeURIComponent(locationId)}/service-availability/${encodeURIComponent(ruleId)}`,
		{
			method: 'PUT',
			body,
		},
	)
	return {
		availability: normalizeServiceAvailability(
			res.availability ?? res.serviceAvailability ?? res.rule ?? res,
		),
	}
}

export async function deleteServiceAvailability(
	client: ReservationsScopedClient,
	locationId: string,
	ruleId: string,
): Promise<{ deleted: boolean }> {
	return client.request(
		`${SETUP_BASE}/locations/${encodeURIComponent(locationId)}/service-availability/${encodeURIComponent(ruleId)}`,
		{
			method: 'DELETE',
		},
	)
}

export async function fetchSpecialDays(
	client: ReservationsScopedClient,
	locationId: string,
	signal?: AbortSignal,
): Promise<{ specialDays: SpecialDayDto[] }> {
	const res = await client.request<{
		specialDays?: SpecialDayDto[]
		special_days?: SpecialDayDto[]
	}>(`${SETUP_BASE}/locations/${encodeURIComponent(locationId)}/special-days`, {
		signal,
	})
	return {
		specialDays: (res.specialDays ?? res.special_days ?? []).map(
			normalizeSpecialDay,
		),
	}
}

export async function createSpecialDay(
	client: ReservationsScopedClient,
	locationId: string,
	body: {
		fromDate: string
		toDate: string
		kind: SpecialDayKind
		name?: string | null
		publicNoteI18n?: LocalizedCopy
		serviceId?: string | null
		patch?: SpecialDayDto['patch']
		services?: SpecialDayDto['services']
	},
): Promise<{
	specialDay: SpecialDayDto
	conflicts?: SetupConflictDto[]
	reflowedMoves?: ReflowedMoveDto[]
}> {
	const res = await client.request<{
		specialDay?: SpecialDayDto
		conflicts?: SetupConflictDto[]
		reflowedMoves?: ReflowedMoveDto[]
	}>(`${SETUP_BASE}/locations/${encodeURIComponent(locationId)}/special-days`, {
		method: 'POST',
		body,
	})
	return {
		...res,
		specialDay: normalizeSpecialDay(res.specialDay ?? res),
	}
}

export async function updateSpecialDay(
	client: ReservationsScopedClient,
	locationId: string,
	specialDayId: string,
	body: Partial<SpecialDayDto> & { expectedVersion?: number },
): Promise<{
	specialDay: SpecialDayDto
	conflicts?: SetupConflictDto[]
	reflowedMoves?: ReflowedMoveDto[]
}> {
	const res = await client.request<{
		specialDay?: SpecialDayDto
		conflicts?: SetupConflictDto[]
		reflowedMoves?: ReflowedMoveDto[]
	}>(
		`${SETUP_BASE}/locations/${encodeURIComponent(locationId)}/special-days/${encodeURIComponent(specialDayId)}`,
		{
			method: 'PUT',
			body,
		},
	)
	return {
		...res,
		specialDay: normalizeSpecialDay(res.specialDay ?? res),
	}
}

export async function deleteSpecialDay(
	client: ReservationsScopedClient,
	locationId: string,
	specialDayId: string,
): Promise<{
	deleted: boolean
	conflicts?: SetupConflictDto[]
	reflowedMoves?: ReflowedMoveDto[]
}> {
	return client.request(
		`${SETUP_BASE}/locations/${encodeURIComponent(locationId)}/special-days/${encodeURIComponent(specialDayId)}`,
		{
			method: 'DELETE',
		},
	)
}

export async function fetchBlocks(
	client: ReservationsScopedClient,
	locationId: string,
	options?: { date?: string; from?: string; to?: string },
	signal?: AbortSignal,
): Promise<{ blocks: BlockDto[] }> {
	const res = await client.request<{ blocks?: BlockDto[] }>(
		`${SETUP_BASE}/locations/${encodeURIComponent(locationId)}/blocks`,
		{
			query: options,
			signal,
		},
	)
	return { blocks: (res.blocks ?? []).map(normalizeBlock) }
}

export async function createBlock(
	client: ReservationsScopedClient,
	locationId: string,
	body: {
		businessDate: string
		areaId?: string | null
		tableId?: string | null
		startMin: number
		endMin: number
		reason: BlockReason
		note?: string | null
	},
): Promise<{
	block: BlockDto
	conflicts?: SetupConflictDto[]
	reflowedMoves?: ReflowedMoveDto[]
}> {
	const res = await client.request<{
		block?: BlockDto
		conflicts?: SetupConflictDto[]
		reflowedMoves?: ReflowedMoveDto[]
	}>(`${SETUP_BASE}/locations/${encodeURIComponent(locationId)}/blocks`, {
		method: 'POST',
		body,
	})
	return {
		...res,
		block: normalizeBlock(res.block ?? res),
	}
}

export async function deleteBlock(
	client: ReservationsScopedClient,
	locationId: string,
	blockId: string,
): Promise<{
	deleted: boolean
	conflicts?: SetupConflictDto[]
	reflowedMoves?: ReflowedMoveDto[]
}> {
	return client.request(
		`${SETUP_BASE}/locations/${encodeURIComponent(locationId)}/blocks/${encodeURIComponent(blockId)}`,
		{
			method: 'DELETE',
		},
	)
}

export async function fetchSetupValidation(
	client: ReservationsScopedClient,
	locationId: string,
	signal?: AbortSignal,
): Promise<SetupValidationResponse> {
	const res = await client.request<Partial<SetupValidationResponse>>(
		`${SETUP_BASE}/locations/${encodeURIComponent(locationId)}/validation`,
		{ signal },
	)
	const issues = Array.isArray(res.issues) ? res.issues : []
	const errors = Array.isArray(res.errors)
		? res.errors
		: issues.filter((i) => i.severity === 'error')
	const warnings = Array.isArray(res.warnings)
		? res.warnings
		: issues.filter((i) => i.severity === 'warning')
	return {
		valid: typeof res.valid === 'boolean' ? res.valid : errors.length === 0,
		issues,
		errors,
		warnings,
	}
}

const MAX_CONFLICT_ENRICHMENTS = 25

export async function fetchSetupConflicts(
	client: ReservationsScopedClient,
	locationId: string,
	options?: {
		date?: string
		from?: string
		to?: string
		/** Book-scoped client used to read booking details; defaults to `client`. */
		detailClient?: ReservationsScopedClient
	},
	signal?: AbortSignal,
): Promise<{ conflicts: SetupConflictDto[] }> {
	const { detailClient, ...query } = options ?? {}
	const res = await client.request<{ conflicts?: unknown[] }>(
		`${SETUP_BASE}/locations/${encodeURIComponent(locationId)}/conflicts`,
		{
			query,
			signal,
		},
	)
	const conflicts = Array.isArray(res.conflicts)
		? res.conflicts.map(normalizeSetupConflict)
		: []

	const missing = [
		...new Set(
			conflicts
				.filter((c) => c.reservationId && !c.confirmationCode)
				.map((c) => c.reservationId),
		),
	].slice(0, MAX_CONFLICT_ENRICHMENTS)
	const lookups = new Map<
		string,
		{ confirmationCode: string | null; partySize: number | null }
	>()
	await Promise.all(
		missing.map(async (id) => {
			try {
				const detail = await (detailClient ?? client).request<
					Record<string, unknown>
				>(
					`/operator/reservations/book/reservations/${encodeURIComponent(id)}`,
					{ signal },
				)
				const r = (detail.reservation ?? detail) as Record<string, unknown>
				lookups.set(id, {
					confirmationCode:
						typeof r.confirmationCode === 'string' ? r.confirmationCode : null,
					partySize: typeof r.partySize === 'number' ? r.partySize : null,
				})
			} catch {
				// A booking the operator cannot read keeps its row without a code.
			}
		}),
	)
	return {
		conflicts: conflicts.map((c) => {
			const found = lookups.get(c.reservationId)
			return found
				? {
						...c,
						confirmationCode: c.confirmationCode ?? found.confirmationCode,
						partySize: c.partySize ?? found.partySize,
					}
				: c
		}),
	}
}
