import { DEFAULT_DAY_START_MIN } from '#app/utils/reservations/business-date.ts'
import {
	type ReservationsConditionalResult,
	type ReservationsScopedClient,
} from '#app/utils/reservations/reservations-client.ts'
import {
	type RsvAreaRecord,
	type RsvCombinationRecord,
	type RsvFloorElementRecord,
	type RsvScheduleBlockRecord,
	type RsvServiceRecord,
	type RsvSettingsData,
	type RsvTableRecord,
} from '#app/utils/reservations/setup-api.ts'

export type RsvSectionItem = {
	id: string
	layoutId?: string
	name: string
	colorToken: string
	sort: number
	tableIds: string[]
}

export type RsvSectionAssignment = {
	sectionId?: string
	sectionName: string
	serverName: string
	staffId?: string | null
	color: string
	tableIds: string[]
}

export type RsvSectionLayoutRecord = {
	id: string
	locationId: string
	serviceId: string | null
	name: string
	sections: RsvSectionItem[]
	assignments: RsvSectionAssignment[]
	isDefault: boolean
	archivedAt?: number | null
	createdAt?: number
	updatedAt?: number
}

export type RsvServiceSectionAssignmentRow = {
	id: string
	locationId: string
	businessDate: string
	serviceId: string
	sectionId: string
	staffId: string | null
	serverLabel: string | null
	version: number
}

export type RsvServiceNoteRow = {
	id: string
	locationId: string
	businessDate: string
	serviceId: string | null
	note: string
	body: string
	updatedBy: string | null
	updatedAt: number | null
	version: number
}

export type DayReservationGuestTag = {
	id: string
	scope: string
	category: string
	name: string
	icon: string | null
	colorToken: string
	sensitive: boolean
}

export type DayReservationGuestSummary = {
	id: string
	fullName: string
	name: string
	firstName: string
	lastName: string
	preferredName: string | null
	phoneE164: string
	phone: string | null
	email: string | null
	locale: string
	vipTier: string
	dietaryCodes: string[]
	allergiesText: string | null
	allergyNotes: string | null
	hasAllergy: boolean
	seatingPrefText: string | null
	generalNotes: string | null
	visitCount: number
	visits: number
	covers: number
	completedCount: number
	noShowCount: number
	noShows: number
	lateCancelCount: number
	lateCancels: number
	cancels: number
	totalSpendMinor: number
	firstVisitAt: number | null
	lastVisitAt: number | null
	tags: DayReservationGuestTag[]
}

export type DayReservationView = {
	id: string
	version: number
	scheduleVersion: number
	confirmationCode: string
	locationId: string
	serviceId: string | null
	serviceName: string | null
	serviceColor: string | null
	areaId: string | null
	areaName: string | null
	guestId: string | null
	guestName: string
	guestPhone: string
	guestEmail: string | null
	guestLocale: string
	partySize: number
	arrivedCovers: number | null
	seatedCovers: number | null
	businessDate: string
	localStartMin: number
	localEndMin: number
	hhmm: string
	endHhmm: string
	slotStartAt: number
	slotEndAt: number
	durationMin: number
	status: string
	channel: string
	/** The `X-Client` value recorded at booking (`web`, `ios`, `android`, `operator`). */
	client: string | null
	assignment: 'soft' | 'locked' | 'unassigned'
	locked: boolean
	overbook: boolean
	assignedTableIds: string[]
	assignedTableLabels: string[]
	assignedCombinationId: string | null
	serverLabel: string | null
	courseStage: string | null
	occasion: string | null
	dietaryCodes: string[]
	dietaryNotes: string | null
	hasAllergy: boolean
	guestNotes: string | null
	internalNotes: string | null
	experienceId: string | null
	paymentRequired: string
	paymentStatus: string
	depositAmountMinor: number
	noShowFeeAmountMinor: number
	currency: string | null
	runningLateMin: number | null
	runningLateNote: string | null
	contactStatus: string | null
	arrivedAt: number | null
	seatedAt: number | null
	completedAt: number | null
	cancelledAt: number | null
	cancelledBy: string | null
	cancelReason: string | null
	noShowMarkedAt: number | null
	lateRisk: boolean
	hasConflict: boolean
	conflictReason: string | null
	createdAt: number
	updatedAt: number
	guest: DayReservationGuestSummary | null
}

export type DayWaitlistView = {
	id: string
	locationId: string
	serviceId: string | null
	areaId: string | null
	guestId: string | null
	guestName: string
	guestPhone: string
	partySize: number
	businessDate: string
	windowStartMin: number
	windowEndMin: number
	quotedWaitMin: number | null
	status: string
	position: number
	notes: string | null
	notifiedAt: number | null
	offerExpiresAt: number | null
	seatedReservationId: string | null
	createdAt: number
}

export type DayHoldView = {
	id: string
	locationId: string
	serviceId: string | null
	areaId: string | null
	partySize: number
	businessDate: string
	localStartMin: number
	hhmm: string
	slotStartAt: number
	slotEndAt: number
	tableIds: string[]
	combinationId: string | null
	channel: string
	expiresAt: number
}

export type LiveTableState = {
	tableId: string
	areaId: string
	label: string
	shape: string
	minCovers: number
	maxCovers: number
	x: number
	y: number
	width: number
	height: number
	rotation: number
	status:
		| 'open'
		| 'reserved_soon'
		| 'seated'
		| 'entree'
		| 'dessert'
		| 'check_dropped'
		| 'bussing'
		| 'blocked'
	activeReservation: DayReservationView | null
	nextReservation: DayReservationView | null
	upcomingReservations: DayReservationView[]
	seatedAtEpoch: number | null
	expectedClearAtEpoch: number | null
	turnDurationMin: number | null
	sectionId: string | null
	sectionName: string | null
	serverName: string | null
	sectionColor: string | null
	blockedReason: string | null
}

export type DayConflictNotice = {
	reservationId: string
	confirmationCode: string
	guestName: string
	partySize: number
	localStartMin: number
	hhmm: string
	tableIds: string[]
	reason:
		| 'table_blocked'
		| 'table_overlap'
		| 'capacity_exceeded'
		| 'unassigned'
		| 'schedule_closed'
	message: string
	suggestedTableIds: string[]
	suggestedTableLabels: string[]
}

export type DayMoveNotice = {
	reservationId: string
	confirmationCode: string
	guestName: string
	partySize: number
	localStartMin: number
	hhmm: string
	fromTableIds: string[]
	fromTableLabels: string[]
	toTableIds: string[]
	toTableLabels: string[]
	reason: string
}

export type DayPacingBucket = {
	localMin: number
	localStartMin: number
	time: string
	serviceId: string | null
	bookedCovers: number
	covers: number
	seatedCovers: number
	arrivedCovers: number
	partyCount: number
	maxCovers: number
	utilizationPct: number
	isOverPaced: boolean
}

export type DaySummaryStats = {
	totalParties: number
	totalCovers: number
	upcomingParties: number
	upcomingCovers: number
	arrivingSoonParties: number
	arrivingSoonCovers: number
	seatedParties: number
	seatedCovers: number
	completedParties: number
	completedCovers: number
	cancelledParties: number
	noShowParties: number
	walkInParties: number
	walkInCovers: number
	unassignedCount: number
	conflictCount: number
	waitlistActiveCount: number
	waitlistNotifiedCount: number
	activeHoldsCount: number
	lateRiskCount: number
}

export type DayFeedResponse = {
	etag: string
	shortEtag?: string
	dayVersion: number
	settingsVersion: number
	floorPlanVersion: number
	locationId: string
	location: {
		id: string
		slug: string
		name: string
		timezone: string
	}
	businessDate: string
	timezone: string
	dayStartMin: number
	settings: RsvSettingsData
	areas: RsvAreaRecord[]
	tables: RsvTableRecord[]
	combinations: RsvCombinationRecord[]
	elements: RsvFloorElementRecord[]
	floorElements: RsvFloorElementRecord[]
	services: RsvServiceRecord[]
	sectionLayouts: RsvSectionLayoutRecord[]
	sections: RsvSectionLayoutRecord[]
	sectionAssignments: RsvServiceSectionAssignmentRow[]
	serviceNotes: RsvServiceNoteRow[]
	scheduleBlocks: RsvScheduleBlockRecord[]
	blocks: RsvScheduleBlockRecord[]
	reservations: DayReservationView[]
	waitlist: DayWaitlistView[]
	holds: DayHoldView[]
	pacing: DayPacingBucket[]
	tableStates: LiveTableState[]
	unassigned: DayReservationView[]
	conflicts: DayConflictNotice[]
	moveNotices: DayMoveNotice[]
	/** Parties and covers of the rows in this (possibly filtered) feed, without cancelled or no-show. */
	counters: { parties: number; covers: number }
	/** Reservation and guest tags the operator may filter by. */
	tags: DayFeedTag[]
	stats: DaySummaryStats
}

export type DayFeedTag = {
	id: string
	name: string
	category: string | null
}

export type CalendarDaySummary = {
	date: string
	dayOfWeek: number
	isClosed: boolean
	specialLabel: string | null
	specialKind: string | null
	totalCovers: number
	totalParties: number
	seatedCovers: number
	completedCovers: number
	cancelledCount: number
	noShowCount: number
	waitlistCount: number
	maxCapacityCovers: number
	occupancyRatio: number
	pacingPct: number
	services: Array<{
		serviceId: string
		name: string
		color: string
		covers: number
		parties: number
		maxCovers: number
	}>
}

export type CalendarMonthResponse = {
	locationId: string
	month: string
	timezone: string
	days: CalendarDaySummary[]
	daysByDate: Record<string, CalendarDaySummary>
}

export type DayOverviewResponse = {
	locationId: string
	businessDate: string
	serviceId: string | null
	timezone: string
	stats: {
		partyCount: number
		expectedCovers: number
		vipsCount: number
		allergiesCount: number
		occasionsCount: number
		largePartiesCount: number
		firstTimersCount: number
	}
	totals: {
		covers: number
		parties: number
		walkInCovers: number
		cancelledCount: number
		noShowCount: number
		waitlistCount: number
		maxCapacityCovers: number
		utilizationPct: number
	}
	vips: DayReservationView[]
	allergies: DayReservationView[]
	occasions: DayReservationView[]
	largeParties: DayReservationView[]
	firstTimers: DayReservationView[]
	parties: DayReservationView[]
	serviceNotes: RsvServiceNoteRow[]
	sectionAssignments: RsvServiceSectionAssignmentRow[]
	byService: Array<{
		serviceId: string
		serviceName: string
		serviceColor: string
		startMin: number
		endMin: number
		covers: number
		parties: number
		seatedCovers: number
		completedCovers: number
		upcomingCovers: number
		maxCovers: number
		utilizationPct: number
	}>
	hourly: Array<{
		hour: number
		label: string
		covers: number
		parties: number
		seatedCovers: number
		capacityCovers: number
	}>
	byChannel: Record<string, { covers: number; parties: number }>
	pacingBuckets: Array<{
		startMin: number
		hhmm: string
		covers: number
		parties: number
		maxCoversPerSlot: number | null
		maxPartiesPerSlot: number | null
	}>
}

export type OperatorAvailabilitySlot = {
	localStartMin: number
	hhmm: string
	serviceId: string
	serviceName: string
	areaId: string | null
	status: 'available' | 'pacing_full' | 'unavailable'
	available: boolean
	pacingWarning: boolean
	canOverridePacing: boolean
	durationMin: number
	suggestedTableIds: string[]
	candidateTables: Array<{
		id: string
		label: string
		areaId: string
		minCovers: number
		maxCovers: number
	}>
	candidateCombinations: Array<{
		id: string
		name: string
		tableIds: string[]
		minCovers: number
		maxCovers: number
	}>
	reason?: string
}

export type OperatorAvailabilityResponse = {
	locationId: string
	businessDate: string
	timezone: string
	slots: OperatorAvailabilitySlot[]
}

export type ReservationAuditEntry = {
	id: string
	actorType: string
	actorId: string | null
	action: string
	reason: string | null
	beforeJson: Record<string, unknown> | null
	afterJson: Record<string, unknown> | null
	createdAt: number
}

export type ReservationDetailResponse = {
	reservation: DayReservationView
	guest: DayReservationGuestSummary | null
	history: Array<{
		id: string
		confirmationCode: string
		businessDate: string
		localStartMin: number
		hhmm: string
		partySize: number
		status: string
		serverLabel: string | null
	}>
	audit: ReservationAuditEntry[]
	messages: Array<{
		id: string
		templateKey: string
		channel: string
		status: string
		createdAt: number
	}>
}

const SECTION_COLOR_TOKEN_TO_HEX: Record<string, string> = {
	'1': '#3b82f6',
	'2': '#10b981',
	'3': '#f59e0b',
	'4': '#8b5cf6',
	'5': '#ec4899',
	'6': '#06b6d4',
	'7': '#f97316',
	'8': '#6366f1',
	blue: '#3b82f6',
	emerald: '#10b981',
	green: '#10b981',
	amber: '#f59e0b',
	purple: '#8b5cf6',
	violet: '#8b5cf6',
	pink: '#ec4899',
	rose: '#f43f5e',
	cyan: '#06b6d4',
	teal: '#14b8a6',
	orange: '#f97316',
	indigo: '#6366f1',
	slate: '#64748b',
}

export function resolveSectionColorHex(tokenOrHex?: string | null): string {
	if (!tokenOrHex) return '#3b82f6'
	if (tokenOrHex.startsWith('#')) return tokenOrHex
	return SECTION_COLOR_TOKEN_TO_HEX[tokenOrHex.toLowerCase()] ?? '#3b82f6'
}

export function formatMinutesToHHMM(localMin: number): string {
	const normalized = ((Math.floor(localMin) % 1440) + 1440) % 1440
	const hh = Math.floor(normalized / 60)
	const mm = normalized % 60
	return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
}

export function generateIdempotencyKey(prefix = 'rsv'): string {
	if (
		typeof crypto !== 'undefined' &&
		typeof crypto.randomUUID === 'function'
	) {
		return `${prefix}-${crypto.randomUUID()}`
	}
	return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

export function normalizeGuestSummary(
	raw: Record<string, unknown> | null | undefined,
): DayReservationGuestSummary | null {
	if (!raw || typeof raw !== 'object') return null
	const firstName =
		(typeof raw.firstName === 'string' && raw.firstName) ||
		(typeof raw.first_name === 'string' && raw.first_name) ||
		''
	const lastName =
		(typeof raw.lastName === 'string' && raw.lastName) ||
		(typeof raw.last_name === 'string' && raw.last_name) ||
		''
	const fullName =
		(typeof raw.fullName === 'string' && raw.fullName.trim()) ||
		(typeof raw.name === 'string' && raw.name.trim()) ||
		`${firstName} ${lastName}`.trim() ||
		'Guest'
	const phoneE164 =
		(typeof raw.phoneE164 === 'string' && raw.phoneE164) ||
		(typeof raw.phone_e164 === 'string' && raw.phone_e164) ||
		(typeof raw.phone === 'string' && raw.phone) ||
		''
	const email =
		(typeof raw.email === 'string' && raw.email) ||
		(typeof raw.emailNorm === 'string' && raw.emailNorm) ||
		null
	const tagsRaw = Array.isArray(raw.tags) ? raw.tags : []
	const tags: DayReservationGuestTag[] = tagsRaw
		.filter((t): t is Record<string, unknown> =>
			Boolean(t && typeof t === 'object'),
		)
		.map((t) => ({
			id: String(t.id ?? ''),
			scope: String(t.scope ?? 'guest'),
			category: String(t.category ?? 'general'),
			name: String(t.name ?? ''),
			icon: typeof t.icon === 'string' ? t.icon : null,
			colorToken: String(t.colorToken ?? t.color_token ?? 'slate'),
			sensitive: Boolean(t.sensitive),
		}))

	const hasVipTag = tags.some(
		(t) => t.category === 'vip' || t.name.toLowerCase().includes('vip'),
	)
	const vipTier =
		(typeof raw.vipTier === 'string' && raw.vipTier) ||
		(raw.vip ? 'vip' : hasVipTag ? 'vip' : 'none')

	const allergyNotes =
		typeof raw.allergyNotes === 'string'
			? raw.allergyNotes
			: typeof raw.allergiesText === 'string'
				? raw.allergiesText
				: null
	const hasAllergy = Boolean(
		raw.hasAllergy ??
		raw.has_allergy ??
		(allergyNotes && allergyNotes.trim().length > 0),
	)
	const dietaryCodes = Array.isArray(raw.dietaryCodes)
		? raw.dietaryCodes.map(String)
		: tags
				.filter((t) => t.category === 'dietary' || t.category === 'allergy')
				.map((t) => t.name)

	const visits = Number(raw.visitCount ?? raw.visits ?? 0)
	const noShows = Number(raw.noShowCount ?? raw.noShows ?? raw.no_shows ?? 0)
	const lateCancels = Number(
		raw.lateCancelCount ?? raw.lateCancels ?? raw.late_cancels ?? 0,
	)
	const cancels = Number(raw.cancels ?? raw.cancellations ?? 0)

	return {
		id: String(raw.id ?? ''),
		fullName,
		name: fullName,
		firstName: firstName || fullName.split(' ')[0] || 'Guest',
		lastName: lastName || fullName.split(' ').slice(1).join(' '),
		preferredName:
			typeof raw.preferredName === 'string' ? raw.preferredName : null,
		phoneE164,
		phone: phoneE164 || null,
		email,
		locale: typeof raw.locale === 'string' ? raw.locale : 'en',
		vipTier,
		dietaryCodes,
		allergiesText: allergyNotes,
		allergyNotes,
		hasAllergy,
		seatingPrefText:
			typeof raw.seatingPrefText === 'string' ? raw.seatingPrefText : null,
		generalNotes:
			typeof raw.generalNotes === 'string'
				? raw.generalNotes
				: typeof raw.notes === 'string'
					? raw.notes
					: null,
		visitCount: visits,
		visits,
		covers: Number(raw.covers ?? 0),
		completedCount: Math.max(0, visits - noShows),
		noShowCount: noShows,
		noShows,
		lateCancelCount: lateCancels,
		lateCancels,
		cancels,
		totalSpendMinor: Number(raw.totalSpendMinor ?? raw.totalSpendCents ?? 0),
		firstVisitAt:
			typeof raw.firstVisitAt === 'number' ? raw.firstVisitAt : null,
		lastVisitAt: typeof raw.lastVisitAt === 'number' ? raw.lastVisitAt : null,
		tags,
	}
}

export function normalizeReservationView(
	raw: Record<string, unknown>,
	context?: {
		servicesById?: Map<string, { name: string; color?: string }>
		areasById?: Map<string, { name: string }>
		tablesById?: Map<string, { label: string; areaId?: string }>
		serverByTableId?: Map<string, string>
	},
): DayReservationView {
	const guest = normalizeGuestSummary(
		raw.guest as Record<string, unknown> | null | undefined,
	)
	const localStartMin = Number(raw.localStartMin ?? raw.local_start_min ?? 0)
	const durationMin = Number(raw.durationMin ?? raw.duration_min ?? 90)
	const localEndMin =
		typeof raw.localEndMin === 'number'
			? raw.localEndMin
			: localStartMin + durationMin
	const hhmm =
		(typeof raw.hhmm === 'string' && raw.hhmm) ||
		(typeof raw.time === 'string' && raw.time) ||
		formatMinutesToHHMM(localStartMin)
	const endHhmm =
		(typeof raw.endHhmm === 'string' && raw.endHhmm) ||
		formatMinutesToHHMM(localEndMin)

	const assignedTableIds = Array.isArray(raw.assignedTableIds)
		? raw.assignedTableIds.map(String)
		: Array.isArray(raw.tableIds)
			? raw.tableIds.map(String)
			: []
	const assignedTableLabels = Array.isArray(raw.assignedTableLabels)
		? raw.assignedTableLabels.map(String)
		: Array.isArray(raw.tableLabels)
			? raw.tableLabels.map(String)
			: assignedTableIds.map(
					(tid) => context?.tablesById?.get(tid)?.label ?? tid,
				)

	const serviceId =
		typeof raw.serviceId === 'string'
			? raw.serviceId
			: typeof raw.service_id === 'string'
				? raw.service_id
				: null
	const svcInfo = serviceId ? context?.servicesById?.get(serviceId) : undefined

	const firstTableAreaId =
		assignedTableIds.length > 0
			? context?.tablesById?.get(assignedTableIds[0]!)?.areaId
			: undefined
	const areaId =
		(typeof raw.areaId === 'string' && raw.areaId) ||
		(typeof raw.areaPrefId === 'string' && raw.areaPrefId) ||
		(typeof raw.diningAreaId === 'string' && raw.diningAreaId) ||
		firstTableAreaId ||
		null
	const areaInfo = areaId ? context?.areasById?.get(areaId) : undefined

	const rawStatus = String(raw.status ?? 'booked')
	const assignment =
		raw.assignment === 'locked' || raw.locked || raw.tableLocked
			? 'locked'
			: assignedTableIds.length > 0
				? 'soft'
				: 'unassigned'
	const locked = assignment === 'locked'

	const dietaryNotes =
		typeof raw.dietaryNotes === 'string'
			? raw.dietaryNotes
			: typeof raw.dietary_notes === 'string'
				? raw.dietary_notes
				: null
	const dietaryCodes = Array.isArray(raw.dietaryCodes)
		? raw.dietaryCodes.map(String)
		: dietaryNotes
			? dietaryNotes
					.split(',')
					.map((s) => s.trim())
					.filter(Boolean)
			: (guest?.dietaryCodes ?? [])

	const guestNotes =
		typeof raw.guestNotes === 'string'
			? raw.guestNotes
			: typeof raw.guestRequests === 'string'
				? raw.guestRequests
				: null
	const internalNotes =
		typeof raw.internalNotes === 'string'
			? raw.internalNotes
			: typeof raw.staffNotes === 'string'
				? raw.staffNotes
				: null

	const serverLabel =
		(typeof raw.serverLabel === 'string' && raw.serverLabel) ||
		(assignedTableIds.length > 0
			? (context?.serverByTableId?.get(assignedTableIds[0]!) ?? null)
			: null)

	const slotStartAt = Number(
		raw.slotStartAt ?? raw.startAt ?? raw.start_at ?? 0,
	)
	const slotEndAt = Number(raw.slotEndAt ?? raw.endAt ?? raw.end_at ?? 0)
	const runningLateMin =
		typeof raw.runningLateMin === 'number'
			? raw.runningLateMin
			: typeof raw.runningLateMinutes === 'number'
				? raw.runningLateMinutes
				: null

	return {
		id: String(raw.id ?? ''),
		version: Number(raw.version ?? 1),
		scheduleVersion: Number(raw.scheduleVersion ?? raw.schedule_version ?? 1),
		confirmationCode: String(
			raw.confirmationCode ?? raw.confirmation_code ?? '',
		),
		locationId: String(raw.locationId ?? raw.location_id ?? ''),
		serviceId,
		serviceName:
			(typeof raw.serviceName === 'string' && raw.serviceName) ||
			svcInfo?.name ||
			null,
		serviceColor:
			(typeof raw.serviceColor === 'string' && raw.serviceColor) ||
			svcInfo?.color ||
			null,
		areaId,
		areaName:
			(typeof raw.areaName === 'string' && raw.areaName) ||
			areaInfo?.name ||
			null,
		guestId:
			typeof raw.guestId === 'string' ? raw.guestId : (guest?.id ?? null),
		guestName:
			(typeof raw.guestName === 'string' && raw.guestName.trim()) ||
			guest?.fullName ||
			'Walk-in Guest',
		guestPhone:
			(typeof raw.guestPhone === 'string' && raw.guestPhone) ||
			guest?.phoneE164 ||
			'',
		guestEmail:
			(typeof raw.guestEmail === 'string' && raw.guestEmail) ||
			guest?.email ||
			null,
		guestLocale:
			(typeof raw.guestLocale === 'string' && raw.guestLocale) ||
			guest?.locale ||
			'en',
		partySize: Number(raw.partySize ?? raw.party_size ?? 2),
		arrivedCovers:
			typeof raw.arrivedCovers === 'number' ? raw.arrivedCovers : null,
		seatedCovers:
			typeof raw.seatedCovers === 'number' ? raw.seatedCovers : null,
		businessDate: String(raw.businessDate ?? raw.date ?? ''),
		localStartMin,
		localEndMin,
		hhmm,
		endHhmm,
		slotStartAt,
		slotEndAt,
		durationMin,
		status: rawStatus,
		channel: String(raw.channel ?? 'host'),
		client:
			typeof raw.client === 'string' && raw.client.trim()
				? raw.client.trim()
				: null,
		assignment,
		locked,
		overbook: Boolean(raw.overbook ?? raw.overbooked ?? false),
		assignedTableIds,
		assignedTableLabels,
		assignedCombinationId:
			typeof raw.assignedCombinationId === 'string'
				? raw.assignedCombinationId
				: typeof raw.comboId === 'string'
					? raw.comboId
					: null,
		serverLabel,
		courseStage:
			(typeof raw.courseStage === 'string' && raw.courseStage) ||
			(typeof raw.courseStatus === 'string' && raw.courseStatus) ||
			null,
		occasion:
			typeof raw.occasion === 'string' && raw.occasion ? raw.occasion : null,
		dietaryCodes,
		dietaryNotes,
		hasAllergy: Boolean(
			raw.hasAllergy ?? raw.has_allergy ?? guest?.hasAllergy ?? false,
		),
		guestNotes,
		internalNotes,
		experienceId:
			typeof raw.experienceId === 'string' ? raw.experienceId : null,
		paymentRequired: String(raw.paymentRequired ?? 'none'),
		paymentStatus: String(raw.paymentStatus ?? raw.payment_status ?? 'none'),
		depositAmountMinor: Number(raw.depositAmountMinor ?? 0),
		noShowFeeAmountMinor: Number(raw.noShowFeeAmountMinor ?? 0),
		currency: typeof raw.currency === 'string' ? raw.currency : null,
		runningLateMin,
		runningLateNote:
			typeof raw.runningLateNote === 'string' ? raw.runningLateNote : null,
		contactStatus:
			typeof raw.contactStatus === 'string' ? raw.contactStatus : null,
		arrivedAt: typeof raw.arrivedAt === 'number' ? raw.arrivedAt : null,
		seatedAt: typeof raw.seatedAt === 'number' ? raw.seatedAt : null,
		completedAt:
			typeof raw.completedAt === 'number'
				? raw.completedAt
				: typeof raw.finishedAt === 'number'
					? raw.finishedAt
					: null,
		cancelledAt: typeof raw.cancelledAt === 'number' ? raw.cancelledAt : null,
		cancelledBy: typeof raw.cancelledBy === 'string' ? raw.cancelledBy : null,
		cancelReason:
			typeof raw.cancelReason === 'string' ? raw.cancelReason : null,
		noShowMarkedAt:
			typeof raw.noShowMarkedAt === 'number'
				? raw.noShowMarkedAt
				: typeof raw.noShowAt === 'number'
					? raw.noShowAt
					: null,
		lateRisk: Boolean(
			raw.lateRisk ??
			((rawStatus === 'booked' || rawStatus === 'confirmed') &&
				slotStartAt > 0 &&
				Date.now() > slotStartAt + 10 * 60_000),
		),
		hasConflict: Boolean(raw.hasConflict ?? false),
		conflictReason:
			typeof raw.conflictReason === 'string' ? raw.conflictReason : null,
		createdAt: Number(raw.createdAt ?? raw.created_at ?? Date.now()),
		updatedAt: Number(raw.updatedAt ?? raw.updated_at ?? Date.now()),
		guest,
	}
}

export function normalizeSectionLayout(
	raw: Record<string, unknown>,
	assignmentsBySectionId?: Map<
		string,
		{ serverLabel: string | null; staffId: string | null }
	>,
): RsvSectionLayoutRecord {
	const rawSections = Array.isArray(raw.sections) ? raw.sections : []
	const rawAssignments = Array.isArray(raw.assignments) ? raw.assignments : []

	const sections: RsvSectionItem[] =
		rawSections.length > 0
			? rawSections
					.filter((s): s is Record<string, unknown> =>
						Boolean(s && typeof s === 'object'),
					)
					.map((s, idx) => ({
						id: String(s.id ?? `sec-${idx + 1}`),
						layoutId: typeof s.layoutId === 'string' ? s.layoutId : undefined,
						name: String(s.name ?? `Section ${idx + 1}`),
						colorToken: String(
							s.colorToken ?? s.color_token ?? String((idx % 8) + 1),
						),
						sort: Number(s.sort ?? s.sortOrder ?? idx),
						tableIds: Array.isArray(s.tableIds)
							? s.tableIds.map(String)
							: Array.isArray(s.table_ids)
								? s.table_ids.map(String)
								: [],
					}))
			: rawAssignments
					.filter((a): a is Record<string, unknown> =>
						Boolean(a && typeof a === 'object'),
					)
					.map((a, idx) => ({
						id: String(a.sectionId ?? a.id ?? `sec-${idx + 1}`),
						name: String(a.sectionName ?? a.name ?? `Section ${idx + 1}`),
						colorToken: String(
							a.colorToken ?? a.color ?? String((idx % 8) + 1),
						),
						sort: idx,
						tableIds: Array.isArray(a.tableIds) ? a.tableIds.map(String) : [],
					}))

	const assignments: RsvSectionAssignment[] = sections.map((sec) => {
		const assigned = assignmentsBySectionId?.get(sec.id)
		return {
			sectionId: sec.id,
			sectionName: sec.name,
			serverName: assigned?.serverLabel ?? '',
			staffId: assigned?.staffId ?? null,
			color: resolveSectionColorHex(sec.colorToken),
			tableIds: sec.tableIds,
		}
	})

	return {
		id: String(raw.id ?? ''),
		locationId: String(raw.locationId ?? raw.location_id ?? ''),
		serviceId: typeof raw.serviceId === 'string' ? raw.serviceId : null,
		name: String(raw.name ?? 'Layout'),
		sections,
		assignments,
		isDefault: Boolean(raw.isDefault ?? false),
		archivedAt: typeof raw.archivedAt === 'number' ? raw.archivedAt : null,
	}
}

/** The feed carries the day start in `settings`; a root value wins when present. */
function resolveDayStartMin(rootValue: unknown, settings: RsvSettingsData) {
	const fromSettings = (settings as Record<string, unknown>).dayStartMin
	for (const candidate of [rootValue, fromSettings]) {
		if (typeof candidate === 'number' && Number.isFinite(candidate)) {
			return candidate
		}
	}
	return DEFAULT_DAY_START_MIN
}

export function normalizeDayFeedResponse(
	raw: Record<string, unknown>,
	etagHeader?: string | null,
): DayFeedResponse {
	const locationId = String(raw.locationId ?? '')
	const businessDate = String(raw.businessDate ?? raw.date ?? '')
	const settings = (raw.settings ?? {}) as RsvSettingsData
	const timezone = String(
		raw.timezone ??
			(settings as Record<string, unknown>)?.timeZone ??
			(settings as Record<string, unknown>)?.timezone ??
			'UTC',
	)
	const areas = (Array.isArray(raw.areas) ? raw.areas : []).map((a) => {
		const item = a as Record<string, unknown>
		return {
			...item,
			isActive:
				typeof item.isActive === 'boolean' ? item.isActive : !item.archivedAt,
		}
	}) as unknown as RsvAreaRecord[]
	const tables = (Array.isArray(raw.tables) ? raw.tables : []).map((t) => {
		const item = t as Record<string, unknown>
		return {
			...item,
			isActive:
				typeof item.isActive === 'boolean' ? item.isActive : !item.archivedAt,
			x: Number(item.x ?? item.posX ?? 60),
			y: Number(item.y ?? item.posY ?? 60),
			width: Number(item.width ?? item.w ?? 88),
			height: Number(item.height ?? item.h ?? 88),
			rotation: Number(item.rotation ?? item.rotDeg ?? 0),
		}
	}) as unknown as RsvTableRecord[]
	const combinations = (
		Array.isArray(raw.combinations)
			? raw.combinations
			: Array.isArray(raw.combos)
				? raw.combos
				: []
	) as RsvCombinationRecord[]
	const elements = (
		Array.isArray(raw.elements) ? raw.elements : []
	) as RsvFloorElementRecord[]
	const services = (Array.isArray(raw.services) ? raw.services : []).map(
		(s) => {
			const item = s as Record<string, unknown>
			return {
				...item,
				isActive:
					typeof item.isActive === 'boolean' ? item.isActive : !item.archivedAt,
				startMin: Number(
					item.startMin ?? item.firstSeatingMin ?? item.first_seating_min ?? 0,
				),
				endMin: Number(item.endMin ?? item.end_min ?? 1440),
			}
		},
	) as unknown as RsvServiceRecord[]

	const rawSectionAssignments = (
		Array.isArray(raw.sectionAssignments) ? raw.sectionAssignments : []
	) as RsvServiceSectionAssignmentRow[]
	const assignmentsBySectionId = new Map<
		string,
		{ serverLabel: string | null; staffId: string | null }
	>()
	for (const sa of rawSectionAssignments) {
		if (sa && sa.sectionId) {
			assignmentsBySectionId.set(sa.sectionId, {
				serverLabel: sa.serverLabel ?? null,
				staffId: sa.staffId ?? null,
			})
		}
	}

	const sectionLayouts = (
		Array.isArray(raw.sectionLayouts) ? raw.sectionLayouts : []
	)
		.filter((l): l is Record<string, unknown> =>
			Boolean(l && typeof l === 'object'),
		)
		.map((l) => normalizeSectionLayout(l, assignmentsBySectionId))

	const sectionByTableId = new Map<
		string,
		{
			sectionId: string
			sectionName: string
			serverName: string | null
			sectionColor: string
		}
	>()
	for (const layout of sectionLayouts) {
		for (const sec of layout.sections) {
			const assign = assignmentsBySectionId.get(sec.id)
			for (const tid of sec.tableIds) {
				if (!sectionByTableId.has(tid)) {
					sectionByTableId.set(tid, {
						sectionId: sec.id,
						sectionName: sec.name,
						serverName: assign?.serverLabel ?? null,
						sectionColor: resolveSectionColorHex(sec.colorToken),
					})
				}
			}
		}
	}

	const servicesById = new Map(
		services.map((s) => [
			s.id,
			{ name: s.name, color: (s as Record<string, unknown>).color as string },
		]),
	)
	const areasById = new Map(areas.map((a) => [a.id, { name: a.name }]))
	const tablesById = new Map(
		tables.map((t) => [t.id, { label: t.label, areaId: t.areaId }]),
	)
	const serverByTableId = new Map<string, string>()
	for (const [tid, info] of sectionByTableId.entries()) {
		if (info.serverName) serverByTableId.set(tid, info.serverName)
	}

	const reservations = (Array.isArray(raw.reservations) ? raw.reservations : [])
		.filter((r): r is Record<string, unknown> =>
			Boolean(r && typeof r === 'object'),
		)
		.map((r) =>
			normalizeReservationView(r, {
				servicesById,
				areasById,
				tablesById,
				serverByTableId,
			}),
		)

	const scheduleBlocks = (
		Array.isArray(raw.scheduleBlocks)
			? raw.scheduleBlocks
			: Array.isArray(raw.blocks)
				? raw.blocks
				: []
	) as RsvScheduleBlockRecord[]

	const waitlist: DayWaitlistView[] = (
		Array.isArray(raw.waitlist) ? raw.waitlist : []
	)
		.filter((w): w is Record<string, unknown> =>
			Boolean(w && typeof w === 'object'),
		)
		.map((w, idx) => ({
			id: String(w.id ?? `wl-${idx}`),
			locationId: String(w.locationId ?? locationId),
			serviceId: typeof w.serviceId === 'string' ? w.serviceId : null,
			areaId: typeof w.areaId === 'string' ? w.areaId : null,
			guestId: typeof w.guestId === 'string' ? w.guestId : null,
			guestName: String(w.guestName ?? w.displayName ?? w.firstName ?? 'Guest'),
			guestPhone: String(w.guestPhone ?? w.phoneE164 ?? ''),
			partySize: Number(w.partySize ?? 2),
			businessDate: String(w.businessDate ?? businessDate),
			windowStartMin: Number(w.windowStartMin ?? 0),
			windowEndMin: Number(w.windowEndMin ?? 0),
			quotedWaitMin:
				typeof w.quotedWaitMin === 'number'
					? w.quotedWaitMin
					: typeof w.quotedMin === 'number'
						? w.quotedMin
						: null,
			status: String(w.status ?? 'waiting'),
			position: Number(w.position ?? idx + 1),
			notes: typeof w.notes === 'string' ? w.notes : null,
			notifiedAt: typeof w.notifiedAt === 'number' ? w.notifiedAt : null,
			offerExpiresAt:
				typeof w.offerExpiresAt === 'number' ? w.offerExpiresAt : null,
			seatedReservationId:
				typeof w.seatedReservationId === 'string'
					? w.seatedReservationId
					: null,
			createdAt: Number(w.createdAt ?? Date.now()),
		}))

	const holds: DayHoldView[] = (Array.isArray(raw.holds) ? raw.holds : [])
		.filter((h): h is Record<string, unknown> =>
			Boolean(h && typeof h === 'object'),
		)
		.map((h, idx) => {
			const localStartMin = Number(h.localStartMin ?? 0)
			return {
				id: String(h.id ?? `hold-${idx}`),
				locationId: String(h.locationId ?? locationId),
				serviceId: typeof h.serviceId === 'string' ? h.serviceId : null,
				areaId: typeof h.areaId === 'string' ? h.areaId : null,
				partySize: Number(h.partySize ?? 2),
				businessDate: String(h.businessDate ?? businessDate),
				localStartMin,
				hhmm:
					typeof h.hhmm === 'string'
						? h.hhmm
						: formatMinutesToHHMM(localStartMin),
				slotStartAt: Number(h.slotStartAt ?? h.startAt ?? 0),
				slotEndAt: Number(h.slotEndAt ?? h.endAt ?? 0),
				tableIds: Array.isArray(h.tableIds) ? h.tableIds.map(String) : [],
				combinationId:
					typeof h.combinationId === 'string' ? h.combinationId : null,
				channel: String(h.channel ?? 'online'),
				expiresAt: Number(h.expiresAt ?? 0),
			}
		})

	const pacing: DayPacingBucket[] = (
		Array.isArray(raw.pacing) ? raw.pacing : []
	)
		.filter((p): p is Record<string, unknown> =>
			Boolean(p && typeof p === 'object'),
		)
		.map((p) => {
			const localMin = Number(p.localMin ?? p.localStartMin ?? p.startMin ?? 0)
			const bookedCovers = Number(p.bookedCovers ?? p.covers ?? 0)
			const maxCovers = Number(p.maxCovers ?? p.maxCoversPerSlot ?? 20)
			return {
				localMin,
				localStartMin: localMin,
				time: String(p.time ?? p.hhmm ?? formatMinutesToHHMM(localMin)),
				serviceId: typeof p.serviceId === 'string' ? p.serviceId : null,
				bookedCovers,
				covers: bookedCovers,
				seatedCovers: Number(p.seatedCovers ?? 0),
				arrivedCovers: Number(p.arrivedCovers ?? 0),
				partyCount: Number(p.partyCount ?? p.parties ?? 0),
				maxCovers,
				utilizationPct: Number(p.utilizationPct ?? 0),
				isOverPaced: Boolean(
					p.isOverPaced ?? (maxCovers > 0 && bookedCovers > maxCovers),
				),
			}
		})

	// Active reservations for table state & unassigned derivation
	const activeReservations = reservations.filter(
		(r) =>
			r.status !== 'cancelled' &&
			r.status !== 'no_show' &&
			r.status !== 'completed' &&
			r.status !== 'finished',
	)

	const unassigned = Array.isArray(raw.unassigned)
		? (raw.unassigned as Record<string, unknown>[]).map((r) =>
				normalizeReservationView(r, {
					servicesById,
					areasById,
					tablesById,
					serverByTableId,
				}),
			)
		: activeReservations.filter(
				(r) =>
					r.assignedTableIds.length === 0 &&
					(r.status === 'booked' ||
						r.status === 'confirmed' ||
						r.status === 'arrived' ||
						r.status === 'pending_payment' ||
						r.status === 'pending_approval'),
			)

	// Detect overlapping reservations or blocked tables to populate conflicts
	const conflicts: DayConflictNotice[] = Array.isArray(raw.conflicts)
		? (raw.conflicts as DayConflictNotice[])
		: []
	if (!Array.isArray(raw.conflicts)) {
		for (let i = 0; i < activeReservations.length; i++) {
			const a = activeReservations[i]!
			for (let j = i + 1; j < activeReservations.length; j++) {
				const b = activeReservations[j]!
				const sharedTables = a.assignedTableIds.filter((tid) =>
					b.assignedTableIds.includes(tid),
				)
				if (
					sharedTables.length > 0 &&
					a.localStartMin < b.localEndMin &&
					a.localEndMin > b.localStartMin
				) {
					a.hasConflict = true
					b.hasConflict = true
					const freeTables = tables.filter(
						(t) =>
							t.minCovers <= b.partySize &&
							t.maxCovers >= b.partySize &&
							!activeReservations.some(
								(other) =>
									other.id !== b.id &&
									other.assignedTableIds.includes(t.id) &&
									other.localStartMin < b.localEndMin &&
									other.localEndMin > b.localStartMin,
							),
					)
					conflicts.push({
						reservationId: b.id,
						confirmationCode: b.confirmationCode,
						guestName: b.guestName,
						partySize: b.partySize,
						localStartMin: b.localStartMin,
						hhmm: b.hhmm,
						tableIds: sharedTables,
						reason: 'table_overlap',
						message: `Overlaps with ${a.guestName} on ${sharedTables.map((tid) => tablesById.get(tid)?.label ?? tid).join(', ')}`,
						suggestedTableIds: freeTables.slice(0, 1).map((t) => t.id),
						suggestedTableLabels: freeTables.slice(0, 1).map((t) => t.label),
					})
				}
			}
		}
	}

	const tableStates: LiveTableState[] = Array.isArray(raw.tableStates)
		? (raw.tableStates as LiveTableState[])
		: tables.map((table) => {
				const tRaw = table as unknown as Record<string, unknown>
				const tableRes = activeReservations
					.filter((r) => r.assignedTableIds.includes(table.id))
					.sort((a, b) => a.localStartMin - b.localStartMin)
				const seatedRes = tableRes.find((r) => r.status === 'seated') ?? null
				const upcoming = tableRes.filter((r) => r.status !== 'seated')
				const nextRes = upcoming[0] ?? null
				const block = scheduleBlocks.find(
					(b) => (b as unknown as Record<string, unknown>).tableId === table.id,
				)
				const secInfo = sectionByTableId.get(table.id)

				let status: LiveTableState['status'] = 'open'
				if (block) {
					status = 'blocked'
				} else if (seatedRes) {
					const stage = seatedRes.courseStage
					if (stage === 'entree' || stage === 'mains') status = 'entree'
					else if (stage === 'dessert') status = 'dessert'
					else if (
						stage === 'check' ||
						stage === 'check_dropped' ||
						stage === 'paid'
					)
						status = 'check_dropped'
					else if (stage === 'bussing') status = 'bussing'
					else status = 'seated'
				} else if (nextRes) {
					status = 'reserved_soon'
				}

				const seatedAtEpoch =
					seatedRes?.seatedAt ??
					(seatedRes && seatedRes.slotStartAt > 0
						? seatedRes.slotStartAt
						: null)
				const expectedClearAtEpoch =
					seatedRes && seatedAtEpoch
						? seatedAtEpoch + seatedRes.durationMin * 60_000
						: seatedRes && seatedRes.slotEndAt > 0
							? seatedRes.slotEndAt
							: null

				return {
					tableId: table.id,
					areaId: table.areaId,
					label: table.label,
					shape: String(table.shape ?? 'rect'),
					minCovers: Number(table.minCovers ?? 1),
					maxCovers: Number(table.maxCovers ?? 4),
					x: Number(tRaw.x ?? tRaw.posX ?? 60),
					y: Number(tRaw.y ?? tRaw.posY ?? 60),
					width: Number(tRaw.width ?? tRaw.w ?? 88),
					height: Number(tRaw.height ?? tRaw.h ?? 88),
					rotation: Number(tRaw.rotation ?? tRaw.rotDeg ?? 0),
					status,
					activeReservation: seatedRes,
					nextReservation: nextRes,
					upcomingReservations: upcoming,
					seatedAtEpoch,
					expectedClearAtEpoch,
					turnDurationMin: seatedRes?.durationMin ?? null,
					sectionId: secInfo?.sectionId ?? null,
					sectionName: secInfo?.sectionName ?? null,
					serverName: secInfo?.serverName ?? seatedRes?.serverLabel ?? null,
					sectionColor: secInfo?.sectionColor ?? null,
					blockedReason: block
						? String(
								(block as unknown as Record<string, unknown>).reason ??
									'Blocked',
							)
						: null,
				}
			})

	const upcomingList = reservations.filter(
		(r) =>
			r.status === 'booked' ||
			r.status === 'confirmed' ||
			r.status === 'arrived' ||
			r.status === 'pending_payment' ||
			r.status === 'pending_approval',
	)
	const seatedList = reservations.filter((r) => r.status === 'seated')
	const completedList = reservations.filter(
		(r) => r.status === 'finished' || r.status === 'completed',
	)
	const walkInList = reservations.filter(
		(r) =>
			r.channel === 'walk_in' &&
			r.status !== 'cancelled' &&
			r.status !== 'no_show',
	)
	const rawStats = (raw.stats ?? {}) as Record<string, unknown>

	const stats: DaySummaryStats = {
		totalParties: Number(
			rawStats.totalParties ??
				rawStats.totalReservations ??
				upcomingList.length + seatedList.length + completedList.length,
		),
		totalCovers: Number(
			rawStats.totalCovers ??
				[...upcomingList, ...seatedList, ...completedList].reduce(
					(s, r) => s + r.partySize,
					0,
				),
		),
		upcomingParties: Number(rawStats.upcomingParties ?? upcomingList.length),
		upcomingCovers: Number(
			rawStats.upcomingCovers ??
				upcomingList.reduce((s, r) => s + r.partySize, 0),
		),
		arrivingSoonParties: Number(
			rawStats.arrivingSoonParties ??
				upcomingList.filter((r) => r.status === 'arrived').length,
		),
		arrivingSoonCovers: Number(
			rawStats.arrivingSoonCovers ??
				upcomingList
					.filter((r) => r.status === 'arrived')
					.reduce((s, r) => s + r.partySize, 0),
		),
		seatedParties: Number(rawStats.seatedParties ?? seatedList.length),
		seatedCovers: Number(
			rawStats.seatedCovers ??
				seatedList.reduce((s, r) => s + (r.seatedCovers ?? r.partySize), 0),
		),
		completedParties: Number(rawStats.completedParties ?? completedList.length),
		completedCovers: Number(
			rawStats.completedCovers ??
				rawStats.finishedCovers ??
				completedList.reduce((s, r) => s + (r.seatedCovers ?? r.partySize), 0),
		),
		cancelledParties: Number(
			rawStats.cancelledParties ??
				rawStats.cancelledCount ??
				reservations.filter((r) => r.status === 'cancelled').length,
		),
		noShowParties: Number(
			rawStats.noShowParties ??
				rawStats.noShowCount ??
				reservations.filter((r) => r.status === 'no_show').length,
		),
		walkInParties: Number(rawStats.walkInParties ?? walkInList.length),
		walkInCovers: Number(
			rawStats.walkInCovers ?? walkInList.reduce((s, r) => s + r.partySize, 0),
		),
		unassignedCount: Number(rawStats.unassignedCount ?? unassigned.length),
		conflictCount: Number(rawStats.conflictCount ?? conflicts.length),
		waitlistActiveCount: Number(
			rawStats.waitlistActiveCount ??
				rawStats.waitlistWaitingCount ??
				waitlist.filter(
					(w) => w.status === 'waiting' || w.status === 'notified',
				).length,
		),
		waitlistNotifiedCount: Number(
			rawStats.waitlistNotifiedCount ??
				waitlist.filter((w) => w.status === 'notified').length,
		),
		activeHoldsCount: Number(rawStats.activeHoldsCount ?? holds.length),
		lateRiskCount: Number(
			rawStats.lateRiskCount ?? upcomingList.filter((r) => r.lateRisk).length,
		),
	}

	const serviceNotes: RsvServiceNoteRow[] = (
		Array.isArray(raw.serviceNotes) ? raw.serviceNotes : []
	)
		.filter((n): n is Record<string, unknown> =>
			Boolean(n && typeof n === 'object'),
		)
		.map((n) => ({
			id: String(n.id ?? ''),
			locationId: String(n.locationId ?? locationId),
			businessDate: String(n.businessDate ?? businessDate),
			serviceId: typeof n.serviceId === 'string' ? n.serviceId : null,
			note: String(n.note ?? n.body ?? ''),
			body: String(n.body ?? n.note ?? ''),
			updatedBy: typeof n.updatedBy === 'string' ? n.updatedBy : null,
			updatedAt: typeof n.updatedAt === 'number' ? n.updatedAt : null,
			version: Number(n.version ?? 1),
		}))

	return {
		etag: String(etagHeader ?? raw.etag ?? ''),
		shortEtag: typeof raw.shortEtag === 'string' ? raw.shortEtag : undefined,
		dayVersion: Number(raw.dayVersion ?? 1),
		settingsVersion: Number(raw.settingsVersion ?? 1),
		floorPlanVersion: Number(raw.floorPlanVersion ?? 1),
		locationId,
		location: (raw.location as DayFeedResponse['location']) ?? {
			id: locationId,
			slug: locationId,
			name: locationId,
			timezone,
		},
		businessDate,
		timezone,
		dayStartMin: resolveDayStartMin(raw.dayStartMin, settings),
		settings,
		areas,
		tables,
		combinations,
		elements,
		floorElements: elements,
		services,
		sectionLayouts,
		sections: sectionLayouts,
		sectionAssignments: rawSectionAssignments,
		serviceNotes,
		scheduleBlocks,
		blocks: scheduleBlocks,
		reservations,
		waitlist,
		holds,
		pacing,
		tableStates,
		unassigned,
		conflicts,
		moveNotices: normalizeMovesList(raw.moveNotices),
		counters: normalizeDayCounters(raw.counters, reservations),
		tags: (Array.isArray(raw.tags) ? raw.tags : [])
			.filter((t): t is Record<string, unknown> =>
				Boolean(t && typeof t === 'object' && (t as { id?: unknown }).id),
			)
			.map((t) => ({
				id: String(t.id),
				name: String(t.name ?? t.id),
				category: typeof t.category === 'string' ? t.category : null,
			})),
		stats,
	}
}

function normalizeDayCounters(
	raw: unknown,
	reservations: DayReservationView[],
): { parties: number; covers: number } {
	if (raw && typeof raw === 'object') {
		const c = raw as Record<string, unknown>
		if (typeof c.parties === 'number' && typeof c.covers === 'number') {
			return { parties: c.parties, covers: c.covers }
		}
	}
	const counted = reservations.filter(
		(r) => r.status !== 'cancelled' && r.status !== 'no_show',
	)
	return {
		parties: counted.length,
		covers: counted.reduce((sum, r) => sum + r.partySize, 0),
	}
}

export async function fetchBookDayConditional(
	client: ReservationsScopedClient,
	params: {
		locationId: string
		date?: string
		serviceId?: string | null
		areaId?: string | null
		source?: string | null
		tag?: string | null
	},
	etag?: string | null,
	signal?: AbortSignal,
): Promise<ReservationsConditionalResult<DayFeedResponse>> {
	const res = await client.requestConditional<Record<string, unknown>>(
		'/operator/reservations/book/day',
		{
			query: {
				locationId: params.locationId,
				...(params.date ? { date: params.date } : {}),
				...(params.serviceId ? { serviceId: params.serviceId } : {}),
				...(params.areaId ? { areaId: params.areaId } : {}),
				...(params.source ? { source: params.source } : {}),
				...(params.tag ? { tag: params.tag } : {}),
			},
			ifNoneMatch: etag,
			signal,
		},
	)
	if (res.status === 304) {
		return { status: 304, etag: res.etag }
	}
	const data = normalizeDayFeedResponse(res.data, res.etag)
	return {
		status: 200,
		etag: res.etag ?? data.etag,
		data,
	}
}

export async function fetchBookCalendar(
	client: ReservationsScopedClient,
	params: { locationId: string; month: string },
	signal?: AbortSignal,
): Promise<CalendarMonthResponse> {
	const raw = await client.request<Record<string, unknown>>(
		'/operator/reservations/book/calendar',
		{
			query: params,
			signal,
		},
	)
	const rawDays = Array.isArray(raw.days)
		? raw.days
		: Array.isArray(raw.daysList)
			? raw.daysList
			: []
	const days: CalendarDaySummary[] = rawDays
		.filter((d): d is Record<string, unknown> =>
			Boolean(d && typeof d === 'object'),
		)
		.map((d) => {
			const dateStr = String(d.date ?? '')
			const dt = new Date(`${dateStr}T12:00:00Z`)
			const dow = Number.isNaN(dt.getUTCDay())
				? Number(d.dayOfWeek ?? 0)
				: dt.getUTCDay()
			const sp = d.specialDay as Record<string, unknown> | null | undefined
			const totalCovers = Number(d.totalCovers ?? d.bookedCovers ?? 0)
			const maxCapacityCovers = Number(
				d.maxCapacityCovers ?? d.capacityCovers ?? 0,
			)
			const pacingPct = Number(
				d.pacingPct ??
					(maxCapacityCovers > 0
						? Math.min(100, Math.round((totalCovers / maxCapacityCovers) * 100))
						: 0),
			)
			return {
				date: dateStr,
				dayOfWeek: dow,
				isClosed: Boolean(d.isClosed ?? d.closed ?? sp?.kind === 'closed'),
				specialLabel:
					(typeof d.specialLabel === 'string' && d.specialLabel) ||
					(typeof sp?.name === 'string' && sp.name) ||
					null,
				specialKind: typeof sp?.kind === 'string' ? sp.kind : null,
				totalCovers,
				totalParties: Number(
					d.totalParties ?? d.partyCount ?? d.reservationCount ?? 0,
				),
				seatedCovers: Number(d.seatedCovers ?? 0),
				completedCovers: Number(d.completedCovers ?? 0),
				cancelledCount: Number(d.cancelledCount ?? 0),
				noShowCount: Number(d.noShowCount ?? 0),
				waitlistCount: Number(d.waitlistCount ?? 0),
				maxCapacityCovers,
				occupancyRatio:
					typeof d.occupancyRatio === 'number'
						? d.occupancyRatio
						: pacingPct / 100,
				pacingPct,
				services: Array.isArray(d.services)
					? (d.services as CalendarDaySummary['services'])
					: [],
			}
		})
	const daysByDate: Record<string, CalendarDaySummary> = {}
	for (const day of days) {
		daysByDate[day.date] = day
	}
	return {
		locationId: String(raw.locationId ?? params.locationId),
		month: String(raw.month ?? params.month),
		timezone: String(raw.timezone ?? 'UTC'),
		days,
		daysByDate,
	}
}

export async function fetchBookOverview(
	client: ReservationsScopedClient,
	params: { locationId: string; date: string; serviceId?: string | null },
	signal?: AbortSignal,
): Promise<DayOverviewResponse> {
	const raw = await client.request<Record<string, unknown>>(
		'/operator/reservations/book/overview',
		{
			query: {
				locationId: params.locationId,
				date: params.date,
				...(params.serviceId ? { serviceId: params.serviceId } : {}),
			},
			signal,
		},
	)
	const normalizeList = (arr: unknown): DayReservationView[] =>
		(Array.isArray(arr) ? arr : [])
			.filter((r): r is Record<string, unknown> =>
				Boolean(r && typeof r === 'object'),
			)
			.map((r) => normalizeReservationView(r))

	const parties = normalizeList(raw.parties)
	const vips = normalizeList(raw.vips ?? raw.vipList)
	const allergies = normalizeList(raw.allergies ?? raw.allergyList)
	const occasions = normalizeList(raw.occasions ?? raw.occasionsList)
	const largeParties = normalizeList(raw.largeParties)
	const firstTimers = normalizeList(raw.firstTimers)

	const rawStats = (raw.stats ?? {}) as Record<string, unknown>
	const rawTotals = (raw.totals ?? {}) as Record<string, unknown>
	const expectedCovers = Number(
		rawStats.expectedCovers ??
			rawTotals.covers ??
			parties.reduce((s, r) => s + r.partySize, 0),
	)
	const partyCount = Number(
		rawStats.partyCount ?? rawTotals.parties ?? parties.length,
	)

	// Compute 15-min arrival buckets from parties if pacingBuckets not directly returned
	const bucketMap = new Map<number, { covers: number; parties: number }>()
	for (const p of parties) {
		const slot = Math.floor(p.localStartMin / 15) * 15
		const prev = bucketMap.get(slot) ?? { covers: 0, parties: 0 }
		prev.covers += p.partySize
		prev.parties += 1
		bucketMap.set(slot, prev)
	}
	const computedBuckets = [...bucketMap.entries()]
		.sort((a, b) => a[0] - b[0])
		.map(([startMin, val]) => ({
			startMin,
			hhmm: formatMinutesToHHMM(startMin),
			covers: val.covers,
			parties: val.parties,
			maxCoversPerSlot: null,
			maxPartiesPerSlot: null,
		}))

	const serviceNotes: RsvServiceNoteRow[] = (
		Array.isArray(raw.serviceNotes) ? raw.serviceNotes : []
	)
		.filter((n): n is Record<string, unknown> =>
			Boolean(n && typeof n === 'object'),
		)
		.map((n) => ({
			id: String(n.id ?? ''),
			locationId: String(n.locationId ?? params.locationId),
			businessDate: String(n.businessDate ?? params.date),
			serviceId: typeof n.serviceId === 'string' ? n.serviceId : null,
			note: String(n.note ?? n.body ?? ''),
			body: String(n.body ?? n.note ?? ''),
			updatedBy: typeof n.updatedBy === 'string' ? n.updatedBy : null,
			updatedAt: typeof n.updatedAt === 'number' ? n.updatedAt : null,
			version: Number(n.version ?? 1),
		}))

	return {
		locationId: String(raw.locationId ?? params.locationId),
		businessDate: String(raw.businessDate ?? raw.date ?? params.date),
		serviceId:
			typeof raw.serviceId === 'string'
				? raw.serviceId
				: (params.serviceId ?? null),
		timezone: String(raw.timezone ?? 'UTC'),
		stats: {
			partyCount,
			expectedCovers,
			vipsCount: Number(rawStats.vipsCount ?? vips.length),
			allergiesCount: Number(rawStats.allergiesCount ?? allergies.length),
			occasionsCount: Number(rawStats.occasionsCount ?? occasions.length),
			largePartiesCount: Number(
				rawStats.largePartiesCount ?? largeParties.length,
			),
			firstTimersCount: Number(rawStats.firstTimersCount ?? firstTimers.length),
		},
		totals: {
			covers: expectedCovers,
			parties: partyCount,
			walkInCovers: Number(
				rawTotals.walkInCovers ??
					parties
						.filter((p) => p.channel === 'walk_in')
						.reduce((s, p) => s + p.partySize, 0),
			),
			cancelledCount: Number(rawTotals.cancelledCount ?? 0),
			noShowCount: Number(rawTotals.noShowCount ?? 0),
			waitlistCount: Number(rawTotals.waitlistCount ?? 0),
			maxCapacityCovers: Number(rawTotals.maxCapacityCovers ?? 100),
			utilizationPct: Number(rawTotals.utilizationPct ?? 0),
		},
		vips,
		allergies,
		occasions,
		largeParties,
		firstTimers,
		parties,
		serviceNotes,
		sectionAssignments: Array.isArray(raw.sectionAssignments)
			? (raw.sectionAssignments as RsvServiceSectionAssignmentRow[])
			: [],
		byService: Array.isArray(raw.byService)
			? (raw.byService as DayOverviewResponse['byService'])
			: [],
		hourly: Array.isArray(raw.hourly)
			? (raw.hourly as DayOverviewResponse['hourly'])
			: [],
		byChannel:
			(raw.byChannel as Record<string, { covers: number; parties: number }>) ??
			{},
		pacingBuckets: Array.isArray(raw.pacingBuckets)
			? (raw.pacingBuckets as DayOverviewResponse['pacingBuckets'])
			: computedBuckets,
	}
}

export async function saveServiceNotes(
	client: ReservationsScopedClient,
	input: {
		locationId: string
		date: string
		serviceId?: string | null
		note: string
		expectedVersion?: number
	},
): Promise<{ note: string; version: number; updatedAt: number | null }> {
	const res = await client.request<Record<string, unknown>>(
		'/operator/reservations/book/service-notes',
		{
			method: 'PUT',
			body: {
				locationId: input.locationId,
				businessDate: input.date,
				date: input.date,
				serviceId: input.serviceId ?? null,
				note: input.note,
				body: input.note,
				...(input.expectedVersion !== undefined
					? { expectedVersion: input.expectedVersion }
					: {}),
			},
		},
	)
	return {
		note: String(res.note ?? res.body ?? input.note),
		version: Number(res.version ?? 1),
		updatedAt: typeof res.updatedAt === 'number' ? res.updatedAt : Date.now(),
	}
}

export async function saveSectionServerAssignments(
	client: ReservationsScopedClient,
	input: {
		locationId: string
		date: string
		serviceId: string
		assignments: Array<{
			sectionId: string
			staffId?: string | null
			serverLabel?: string | null
		}>
	},
): Promise<{ assignments: RsvServiceSectionAssignmentRow[] }> {
	return client.request<{ assignments: RsvServiceSectionAssignmentRow[] }>(
		'/operator/reservations/book/sections/assignments',
		{
			method: 'PUT',
			body: {
				locationId: input.locationId,
				businessDate: input.date,
				date: input.date,
				serviceId: input.serviceId,
				assignments: input.assignments,
			},
		},
	)
}

export async function searchBookAvailability(
	client: ReservationsScopedClient,
	input: {
		locationId: string
		date: string
		partySize: number
		serviceId?: string | null
		areaId?: string | null
		durationMin?: number | null
		includePacingOverride?: boolean
	},
): Promise<OperatorAvailabilityResponse> {
	const raw = await client.request<Record<string, unknown>>(
		'/operator/reservations/book/availability',
		{
			method: 'GET',
			query: {
				locationId: input.locationId,
				date: input.date,
				partySize: input.partySize,
				...(input.serviceId ? { serviceId: input.serviceId } : {}),
				...(input.areaId ? { areaId: input.areaId } : {}),
				...(input.durationMin ? { durationMin: input.durationMin } : {}),
			},
		},
	)
	const rawSlots = Array.isArray(raw.slots) ? raw.slots : []
	const slots: OperatorAvailabilitySlot[] = rawSlots
		.filter((s): s is Record<string, unknown> =>
			Boolean(s && typeof s === 'object'),
		)
		.map((s) => {
			const localStartMin = Number(s.localStartMin ?? 0)
			const hhmm = String(
				s.hhmm ?? s.time ?? s.slotLocal ?? formatMinutesToHHMM(localStartMin),
			)
			const available = Boolean(s.available ?? s.status === 'available')
			const pacingWarning = Boolean(
				s.pacingWarning ?? s.status === 'pacing_full',
			)
			const canOverridePacing = Boolean(
				s.canOverridePacing ?? s.overbookAvailable ?? true,
			)
			const status: OperatorAvailabilitySlot['status'] = available
				? 'available'
				: pacingWarning
					? 'pacing_full'
					: 'unavailable'
			const suggestedTableIds = Array.isArray(s.suggestedTableIds)
				? s.suggestedTableIds.map(String)
				: []
			return {
				localStartMin,
				hhmm,
				serviceId: String(s.serviceId ?? input.serviceId ?? ''),
				serviceName: String(s.serviceName ?? ''),
				areaId:
					typeof s.areaId === 'string' ? s.areaId : (input.areaId ?? null),
				status,
				available,
				pacingWarning,
				canOverridePacing,
				durationMin: Number(s.durationMin ?? input.durationMin ?? 90),
				suggestedTableIds,
				candidateTables: Array.isArray(s.candidateTables)
					? (s.candidateTables as OperatorAvailabilitySlot['candidateTables'])
					: suggestedTableIds.map((tid) => ({
							id: tid,
							label: tid,
							areaId: input.areaId ?? '',
							minCovers: 1,
							maxCovers: input.partySize,
						})),
				candidateCombinations: Array.isArray(s.candidateCombinations)
					? (s.candidateCombinations as OperatorAvailabilitySlot['candidateCombinations'])
					: [],
			}
		})
	return {
		locationId: String(raw.locationId ?? input.locationId),
		businessDate: String(raw.businessDate ?? raw.date ?? input.date),
		timezone: String(raw.timezone ?? 'UTC'),
		slots,
	}
}

export async function searchBookGuests(
	client: ReservationsScopedClient,
	query: string,
	limit = 10,
): Promise<{ guests: DayReservationGuestSummary[] }> {
	const raw = await client.request<Record<string, unknown>>(
		'/operator/reservations/book/guests/lookup',
		{
			query: { q: query, limit },
		},
	)
	const rawGuests = Array.isArray(raw.guests) ? raw.guests : []
	return {
		guests: rawGuests
			.map((g) => normalizeGuestSummary(g as Record<string, unknown>))
			.filter((g): g is DayReservationGuestSummary => g !== null),
	}
}

function normalizeAuditEntries(rawEvents: unknown[]): ReservationAuditEntry[] {
	return rawEvents
		.filter((e): e is Record<string, unknown> =>
			Boolean(e && typeof e === 'object'),
		)
		.map((e, idx) => ({
			id: String(e.id ?? `ev-${idx}`),
			actorType: String(e.actorType ?? e.actorKind ?? 'operator'),
			actorId: typeof e.actorId === 'string' ? e.actorId : null,
			action: String(e.action ?? e.type ?? 'updated'),
			reason:
				typeof e.reason === 'string'
					? e.reason
					: typeof (e.data as Record<string, unknown> | null)?.reason ===
						  'string'
						? String((e.data as Record<string, unknown>).reason)
						: null,
			beforeJson:
				(e.beforeJson as Record<string, unknown> | null) ??
				(e.fromStatus ? { status: e.fromStatus } : null),
			afterJson:
				(e.afterJson as Record<string, unknown> | null) ??
				(e.data as Record<string, unknown> | null) ??
				(e.toStatus ? { status: e.toStatus } : null),
			createdAt: Number(e.createdAt ?? e.at ?? 0),
		}))
}

/** Change history of one reservation, oldest first. */
export async function fetchReservationEvents(
	client: ReservationsScopedClient,
	reservationId: string,
	signal?: AbortSignal,
): Promise<ReservationAuditEntry[]> {
	const raw = await client.request<Record<string, unknown>>(
		`/operator/reservations/book/reservations/${encodeURIComponent(reservationId)}/events`,
		{ signal },
	)
	return normalizeAuditEntries(Array.isArray(raw.events) ? raw.events : [])
}

export async function fetchReservationDetail(
	client: ReservationsScopedClient,
	reservationId: string,
	signal?: AbortSignal,
): Promise<ReservationDetailResponse> {
	const raw = await client.request<Record<string, unknown>>(
		`/operator/reservations/book/reservations/${encodeURIComponent(reservationId)}`,
		{ signal },
	)
	const reservation = normalizeReservationView(
		(raw.reservation ?? raw) as Record<string, unknown>,
	)
	const guest =
		normalizeGuestSummary(
			(raw.guest ?? raw.guestDetail ?? reservation.guest) as
				Record<string, unknown> | null | undefined,
		) ?? reservation.guest

	const audit = normalizeAuditEntries(
		Array.isArray(raw.audit)
			? raw.audit
			: Array.isArray(raw.events)
				? raw.events
				: [],
	)

	const rawMessages = Array.isArray(raw.messages) ? raw.messages : []
	const messages = rawMessages
		.filter((m): m is Record<string, unknown> =>
			Boolean(m && typeof m === 'object'),
		)
		.map((m, idx) => ({
			id: String(m.id ?? `msg-${idx}`),
			templateKey: String(m.templateKey ?? m.kind ?? 'notification'),
			channel: String(m.channel ?? 'sms'),
			status: String(m.status ?? 'sent'),
			createdAt: Number(m.createdAt ?? m.sentAt ?? Date.now()),
		}))

	return {
		reservation,
		guest,
		history: Array.isArray(raw.history)
			? (raw.history as ReservationDetailResponse['history'])
			: [],
		audit,
		messages,
	}
}

function normalizeMovesList(rawMoves: unknown): DayMoveNotice[] {
	if (!Array.isArray(rawMoves)) return []
	return rawMoves
		.filter((m): m is Record<string, unknown> =>
			Boolean(m && typeof m === 'object'),
		)
		.map((m) => ({
			reservationId: String(m.reservationId ?? m.bookingId ?? ''),
			confirmationCode: String(m.confirmationCode ?? ''),
			guestName: String(m.guestName ?? 'Party'),
			partySize: Number(m.partySize ?? 2),
			localStartMin: Number(m.localStartMin ?? 0),
			hhmm: String(m.hhmm ?? formatMinutesToHHMM(Number(m.localStartMin ?? 0))),
			fromTableIds: Array.isArray(m.fromTableIds)
				? m.fromTableIds.map(String)
				: [],
			fromTableLabels: Array.isArray(m.fromTableLabels)
				? m.fromTableLabels.map(String)
				: Array.isArray(m.fromTableIds)
					? m.fromTableIds.map(String)
					: [],
			toTableIds: Array.isArray(m.toTableIds) ? m.toTableIds.map(String) : [],
			toTableLabels: Array.isArray(m.toTableLabels)
				? m.toTableLabels.map(String)
				: Array.isArray(m.toTableIds)
					? m.toTableIds.map(String)
					: [],
			reason: String(m.reason ?? 'reflow'),
		}))
}

export async function createPhoneReservation(
	client: ReservationsScopedClient,
	input: {
		locationId: string
		date: string
		localStartMin: number
		partySize: number
		serviceId?: string | null
		areaId?: string | null
		tableIds?: string[]
		combinationId?: string | null
		lockTable?: boolean
		durationMin?: number
		channel?: 'phone' | 'operator' | 'in_person' | 'host'
		guest: {
			fullName: string
			phone: string
			email?: string | null
			preferredLocale?: 'en' | 'ar'
			dietaryCodes?: string[]
			allergiesText?: string | null
			seatingPrefText?: string | null
			generalNotes?: string | null
		}
		occasion?: string | null
		dietaryCodes?: string[]
		dietaryNotes?: string | null
		guestNotes?: string | null
		internalNotes?: string | null
		serverLabel?: string | null
		overridePacing?: boolean
		overrideBlockedTable?: boolean
		overrideScheduleBlock?: boolean
		overbookReason?: string | null
		skipPayment?: boolean
		paymentPolicyMode?: 'none' | 'send_link' | 'waive'
	},
	idempotencyKey = generateIdempotencyKey('book'),
): Promise<{
	reservation: DayReservationView
	replayed?: boolean
	moveNotices?: DayMoveNotice[]
}> {
	const nameParts = input.guest.fullName.trim().split(/\s+/)
	const firstName = nameParts[0] || 'Guest'
	const lastName = nameParts.slice(1).join(' ')
	const isOverbook = Boolean(
		input.overridePacing ||
		input.overrideBlockedTable ||
		input.overrideScheduleBlock,
	)
	const dietaryText = [
		...(input.dietaryCodes ?? []),
		input.dietaryNotes?.trim() ?? '',
		input.guest.allergiesText ?? '',
	]
		.filter(Boolean)
		.join(', ')

	const raw = await client.request<Record<string, unknown>>(
		'/operator/reservations/book/reservations',
		{
			method: 'POST',
			headers: { 'Idempotency-Key': idempotencyKey },
			body: {
				locationId: input.locationId,
				date: input.date,
				businessDate: input.date,
				localStartMin: input.localStartMin,
				time: formatMinutesToHHMM(input.localStartMin),
				partySize: input.partySize,
				...(input.durationMin ? { durationMin: input.durationMin } : {}),
				...(input.serviceId ? { serviceId: input.serviceId } : {}),
				...(input.areaId
					? { areaPrefId: input.areaId, diningAreaId: input.areaId }
					: {}),
				...(input.tableIds && input.tableIds.length > 0
					? { tableIds: input.tableIds }
					: {}),
				...(input.combinationId ? { comboId: input.combinationId } : {}),
				...(input.lockTable !== undefined
					? { lockTable: input.lockTable }
					: {}),
				guest: {
					firstName,
					lastName,
					name: input.guest.fullName.trim(),
					...(input.guest.phone
						? { phone: input.guest.phone, phoneE164: input.guest.phone }
						: {}),
					...(input.guest.email ? { email: input.guest.email } : {}),
					locale: input.guest.preferredLocale ?? 'en',
					...(input.guest.allergiesText
						? { allergyNotes: input.guest.allergiesText }
						: {}),
				},
				firstName,
				lastName,
				...(input.guest.phone ? { phone: input.guest.phone } : {}),
				...(input.guest.email ? { email: input.guest.email } : {}),
				...(input.occasion
					? { occasion: input.occasion, occasionTagId: input.occasion }
					: {}),
				...(dietaryText ? { dietaryNotes: dietaryText } : {}),
				...(input.guestNotes ? { guestRequests: input.guestNotes } : {}),
				...(input.internalNotes
					? {
							staffNotes: input.internalNotes,
							internalNotes: input.internalNotes,
						}
					: {}),
				...(isOverbook
					? {
							overbook: true,
							overbookReason:
								input.overbookReason?.trim() ||
								'Operator pacing/table override',
						}
					: {}),
				channel:
					input.channel === 'in_person' || input.channel === 'operator'
						? 'host'
						: (input.channel ?? 'phone'),
			},
		},
	)
	return {
		reservation: normalizeReservationView(
			(raw.reservation ?? raw) as Record<string, unknown>,
		),
		replayed: Boolean(raw.replayed),
		moveNotices: normalizeMovesList(raw.moveNotices ?? raw.moves),
	}
}

export async function createWalkInReservation(
	client: ReservationsScopedClient,
	input: {
		locationId: string
		partySize: number
		date?: string
		localStartMin?: number
		durationMin?: number
		tableIds?: string[]
		combinationId?: string | null
		areaId?: string | null
		serviceId?: string | null
		guestName?: string
		guestPhone?: string
		guestNotes?: string | null
		internalNotes?: string | null
		serverLabel?: string | null
		forceOverbook?: boolean
		overbookReason?: string | null
	},
	idempotencyKey = generateIdempotencyKey('walkin'),
): Promise<{
	reservation: DayReservationView
	replayed?: boolean
	moveNotices?: DayMoveNotice[]
}> {
	const raw = await client.request<Record<string, unknown>>(
		'/operator/reservations/book/walk-ins',
		{
			method: 'POST',
			headers: { 'Idempotency-Key': idempotencyKey },
			body: {
				locationId: input.locationId,
				partySize: input.partySize,
				...(input.date ? { date: input.date, businessDate: input.date } : {}),
				...(input.localStartMin !== undefined
					? { localStartMin: input.localStartMin }
					: {}),
				...(input.durationMin ? { durationMin: input.durationMin } : {}),
				...(input.serviceId ? { serviceId: input.serviceId } : {}),
				...(input.areaId
					? { areaId: input.areaId, diningAreaId: input.areaId }
					: {}),
				...(input.tableIds && input.tableIds.length > 0
					? { tableIds: input.tableIds }
					: {}),
				...(input.combinationId ? { comboId: input.combinationId } : {}),
				...(input.guestName ? { guestName: input.guestName } : {}),
				...(input.guestPhone ? { phone: input.guestPhone } : {}),
				...(input.guestNotes ? { dietaryNotes: input.guestNotes } : {}),
				...(input.internalNotes
					? {
							staffNotes: input.internalNotes,
							internalNotes: input.internalNotes,
						}
					: {}),
				...(input.forceOverbook
					? {
							overbook: true,
							overbookReason:
								input.overbookReason?.trim() || 'Walk-in overbook override',
						}
					: {}),
			},
		},
	)
	return {
		reservation: normalizeReservationView(
			(raw.reservation ?? raw) as Record<string, unknown>,
		),
		replayed: Boolean(raw.replayed),
		moveNotices: normalizeMovesList(raw.moveNotices ?? raw.moves),
	}
}

export async function updateReservation(
	client: ReservationsScopedClient,
	reservationId: string,
	patch: {
		expectedVersion?: number
		date?: string
		localStartMin?: number
		durationMin?: number
		partySize?: number
		serviceId?: string | null
		areaId?: string | null
		tableIds?: string[]
		combinationId?: string | null
		lockTable?: boolean
		locked?: boolean
		unlock?: boolean
		occasion?: string | null
		dietaryCodes?: string[]
		guestNotes?: string | null
		internalNotes?: string | null
		serverLabel?: string | null
		courseStage?: string | null
		runningLateMin?: number | null
		contactStatus?: string | null
		forceOverbook?: boolean
		overbookReason?: string | null
		overridePacing?: boolean
		overrideScheduleBlock?: boolean
		reflowLaterParties?: boolean
		reason?: string
	},
): Promise<{
	reservation: DayReservationView
	moveNotices: DayMoveNotice[]
}> {
	const isOverbook = Boolean(
		patch.forceOverbook || patch.overridePacing || patch.overrideScheduleBlock,
	)
	const resolvedLock = patch.lockTable ?? patch.locked
	const raw = await client.request<Record<string, unknown>>(
		`/operator/reservations/book/reservations/${encodeURIComponent(reservationId)}`,
		{
			method: 'PATCH',
			body: {
				...(patch.expectedVersion !== undefined
					? { expectedVersion: patch.expectedVersion }
					: {}),
				...(patch.date ? { date: patch.date, businessDate: patch.date } : {}),
				...(patch.localStartMin !== undefined
					? {
							localStartMin: patch.localStartMin,
							time: formatMinutesToHHMM(patch.localStartMin),
						}
					: {}),
				...(patch.durationMin !== undefined
					? { durationMin: patch.durationMin }
					: {}),
				...(patch.partySize !== undefined
					? { partySize: patch.partySize }
					: {}),
				...(patch.serviceId !== undefined
					? { serviceId: patch.serviceId }
					: {}),
				...(patch.areaId !== undefined
					? { areaPrefId: patch.areaId, diningAreaId: patch.areaId }
					: {}),
				...(patch.tableIds !== undefined ? { tableIds: patch.tableIds } : {}),
				...(patch.combinationId !== undefined
					? { comboId: patch.combinationId }
					: {}),
				...(resolvedLock !== undefined
					? { lockTable: resolvedLock, locked: resolvedLock }
					: {}),
				...(patch.unlock !== undefined ? { unlock: patch.unlock } : {}),
				...(patch.occasion !== undefined
					? { occasion: patch.occasion, occasionTagId: patch.occasion }
					: {}),
				...(patch.dietaryCodes !== undefined
					? { dietaryNotes: patch.dietaryCodes.join(', ') }
					: {}),
				...(patch.guestNotes !== undefined
					? { guestRequests: patch.guestNotes }
					: {}),
				...(patch.internalNotes !== undefined
					? {
							staffNotes: patch.internalNotes,
							internalNotes: patch.internalNotes,
						}
					: {}),
				...(isOverbook
					? {
							overbook: true,
							overbookReason:
								patch.overbookReason?.trim() ||
								patch.reason?.trim() ||
								'Operator override',
						}
					: {}),
			},
		},
	)
	return {
		reservation: normalizeReservationView(
			(raw.reservation ?? raw) as Record<string, unknown>,
		),
		moveNotices: normalizeMovesList(raw.moveNotices ?? raw.moves),
	}
}

export async function transitionReservationStatus(
	client: ReservationsScopedClient,
	reservationId: string,
	input: {
		to: string
		expectedVersion?: number
		tableIds?: string[]
		combinationId?: string | null
		serverLabel?: string | null
		reason?: string
		cancelledBy?: 'guest' | 'operator' | 'system'
		forceOverbook?: boolean
		reflowLaterParties?: boolean
		waiveFee?: boolean
	},
): Promise<{
	reservation: DayReservationView
	undoToken: string | null
	undoExpiresAt: number | null
	moveNotices: DayMoveNotice[]
}> {
	const mappedStatus = input.to === 'completed' ? 'finished' : input.to
	const raw = await client.request<Record<string, unknown>>(
		`/operator/reservations/book/reservations/${encodeURIComponent(reservationId)}/status`,
		{
			method: 'POST',
			body: {
				status: mappedStatus,
				toStatus: mappedStatus,
				...(input.expectedVersion !== undefined
					? { expectedVersion: input.expectedVersion }
					: {}),
				...(input.tableIds ? { tableIds: input.tableIds } : {}),
				...(input.combinationId ? { comboId: input.combinationId } : {}),
				...(input.reason
					? { cancelReason: input.reason, reason: input.reason }
					: {}),
				...(input.forceOverbook
					? {
							overbook: true,
							overbookReason: input.reason || 'Operator status override',
						}
					: {}),
			},
		},
	)
	return {
		reservation: normalizeReservationView(
			(raw.reservation ?? raw) as Record<string, unknown>,
		),
		undoToken: typeof raw.undoToken === 'string' ? raw.undoToken : 'undo',
		undoExpiresAt:
			typeof raw.undoExpiresAt === 'number'
				? raw.undoExpiresAt
				: Date.now() + 10 * 60_000,
		moveNotices: normalizeMovesList(raw.moveNotices ?? raw.moves),
	}
}

/** Decides a large-party request (`pending_approval`) from the public site. */
async function decideReservationRequest(
	client: ReservationsScopedClient,
	reservationId: string,
	decision: 'approve' | 'decline',
	input: { locationId?: string; reason?: string },
): Promise<{ reservation: DayReservationView }> {
	const reason = input.reason?.trim()
	const raw = await client.request<Record<string, unknown>>(
		`/operator/reservations/book/requests/${encodeURIComponent(reservationId)}/${decision}`,
		{
			method: 'POST',
			body: {
				...(input.locationId ? { locationId: input.locationId } : {}),
				...(decision === 'decline' && reason ? { reason } : {}),
			},
		},
	)
	return {
		reservation: normalizeReservationView(
			(raw.reservation ?? raw) as Record<string, unknown>,
		),
	}
}

export function approveReservationRequest(
	client: ReservationsScopedClient,
	reservationId: string,
	input: { locationId?: string } = {},
) {
	return decideReservationRequest(client, reservationId, 'approve', input)
}

export function declineReservationRequest(
	client: ReservationsScopedClient,
	reservationId: string,
	input: { locationId?: string; reason?: string } = {},
) {
	return decideReservationRequest(client, reservationId, 'decline', input)
}

export async function assignReservationTable(
	client: ReservationsScopedClient,
	reservationId: string,
	input: {
		tableIds: string[]
		combinationId?: string | null
		expectedVersion?: number
		lock?: boolean
		locked?: boolean
		unlock?: boolean
		serverLabel?: string | null
		localStartMin?: number
		durationMin?: number
		forceOverbook?: boolean
		overbookReason?: string | null
		reflowLaterParties?: boolean
		swapWithReservationId?: string | null
		reason?: string
	},
): Promise<{
	reservation: DayReservationView
	swappedReservation: DayReservationView | null
	moveNotices: DayMoveNotice[]
}> {
	const resolvedLock = input.lock ?? input.locked
	const raw = await client.request<Record<string, unknown>>(
		`/operator/reservations/book/reservations/${encodeURIComponent(reservationId)}/assign`,
		{
			method: 'POST',
			body: {
				tableIds: input.tableIds,
				...(input.combinationId ? { comboId: input.combinationId } : {}),
				...(input.expectedVersion !== undefined
					? { expectedVersion: input.expectedVersion }
					: {}),
				...(resolvedLock !== undefined
					? { lock: resolvedLock, locked: resolvedLock }
					: {}),
				...(input.unlock !== undefined ? { unlock: input.unlock } : {}),
				...(input.swapWithReservationId
					? {
							swap: true,
							swapWithReservationId: input.swapWithReservationId,
						}
					: {}),
				...(input.forceOverbook
					? {
							overbook: true,
							overbookReason:
								input.overbookReason?.trim() ||
								input.reason?.trim() ||
								'Operator table override',
						}
					: {}),
			},
		},
	)
	return {
		reservation: normalizeReservationView(
			(raw.reservation ?? raw) as Record<string, unknown>,
		),
		swappedReservation: raw.swappedReservation
			? normalizeReservationView(
					raw.swappedReservation as Record<string, unknown>,
				)
			: null,
		moveNotices: normalizeMovesList(raw.moveNotices ?? raw.moves),
	}
}

export async function undoReservationTransition(
	client: ReservationsScopedClient,
	reservationId: string,
	undoToken?: string | null,
	expectedVersion?: number,
): Promise<{ reservation: DayReservationView }> {
	const raw = await client.request<Record<string, unknown>>(
		`/operator/reservations/book/reservations/${encodeURIComponent(reservationId)}/undo`,
		{
			method: 'POST',
			body: {
				...(undoToken ? { undoToken } : {}),
				...(expectedVersion !== undefined ? { expectedVersion } : {}),
			},
		},
	)
	return {
		reservation: normalizeReservationView(
			(raw.reservation ?? raw) as Record<string, unknown>,
		),
	}
}

export async function updateReservationContactStatus(
	client: ReservationsScopedClient,
	reservationId: string,
	contactStatus: string,
	noteOrExpectedVersion?: string | number,
	expectedVersion?: number,
): Promise<{ reservation: DayReservationView }> {
	const resolvedNote =
		typeof noteOrExpectedVersion === 'string'
			? noteOrExpectedVersion
			: undefined
	const resolvedExpectedVersion =
		typeof noteOrExpectedVersion === 'number'
			? noteOrExpectedVersion
			: expectedVersion
	const raw = await client.request<Record<string, unknown>>(
		`/operator/reservations/book/reservations/${encodeURIComponent(reservationId)}/contact`,
		{
			method: 'POST',
			body: {
				contactStatus,
				status: contactStatus,
				...(resolvedNote ? { note: resolvedNote } : {}),
				...(resolvedExpectedVersion !== undefined
					? { expectedVersion: resolvedExpectedVersion }
					: {}),
			},
		},
	)
	return {
		reservation: normalizeReservationView(
			(raw.reservation ?? raw) as Record<string, unknown>,
		),
	}
}

export async function markReservationRunningLate(
	client: ReservationsScopedClient,
	reservationId: string,
	minutes: number,
	reflowLaterParties = true,
	expectedVersion?: number,
): Promise<{
	reservation: DayReservationView
	moveNotices: DayMoveNotice[]
}> {
	const raw = await client.request<Record<string, unknown>>(
		`/operator/reservations/book/reservations/${encodeURIComponent(reservationId)}/running-late`,
		{
			method: 'POST',
			body: {
				runningLateMin: minutes,
				minutes,
				reflowLaterParties,
				...(expectedVersion !== undefined ? { expectedVersion } : {}),
			},
		},
	)
	return {
		reservation: normalizeReservationView(
			(raw.reservation ?? raw) as Record<string, unknown>,
		),
		moveNotices: normalizeMovesList(raw.moveNotices ?? raw.moves),
	}
}

export async function updateReservationCourseStage(
	client: ReservationsScopedClient,
	reservationId: string,
	courseStage: string | null,
	expectedVersion?: number,
): Promise<{ reservation: DayReservationView }> {
	const raw = await client.request<Record<string, unknown>>(
		`/operator/reservations/book/reservations/${encodeURIComponent(reservationId)}/course`,
		{
			method: 'POST',
			body: {
				course: courseStage ?? 'none',
				courseStatus: courseStage ?? 'none',
				...(expectedVersion !== undefined ? { expectedVersion } : {}),
			},
		},
	)
	return {
		reservation: normalizeReservationView(
			(raw.reservation ?? raw) as Record<string, unknown>,
		),
	}
}

export async function updateReservationNotes(
	client: ReservationsScopedClient,
	reservationId: string,
	input: {
		internalNotes?: string | null
		guestNotes?: string | null
		serverLabel?: string | null
		dietaryCodes?: string[]
		occasion?: string | null
		expectedVersion?: number
	},
): Promise<{ reservation: DayReservationView }> {
	const raw = await client.request<Record<string, unknown>>(
		`/operator/reservations/book/reservations/${encodeURIComponent(reservationId)}/notes`,
		{
			method: 'POST',
			body: {
				...(input.internalNotes !== undefined
					? {
							staffNotes: input.internalNotes,
							internalNotes: input.internalNotes,
						}
					: {}),
				...(input.guestNotes !== undefined
					? { guestRequests: input.guestNotes }
					: {}),
				...(input.dietaryCodes !== undefined
					? { dietaryNotes: input.dietaryCodes.join(', ') }
					: {}),
				...(input.expectedVersion !== undefined
					? { expectedVersion: input.expectedVersion }
					: {}),
			},
		},
	)
	return {
		reservation: normalizeReservationView(
			(raw.reservation ?? raw) as Record<string, unknown>,
		),
	}
}

export async function listSectionLayouts(
	client: ReservationsScopedClient,
	locationId: string,
): Promise<RsvSectionLayoutRecord[]> {
	const res = await client.request<Record<string, unknown>>(
		'/operator/reservations/setup/sections/layouts',
		{ query: { locationId } },
	)
	const list = Array.isArray(res.layouts)
		? res.layouts
		: Array.isArray(res.sectionLayouts)
			? res.sectionLayouts
			: Array.isArray(res.sections)
				? res.sections
				: []
	return list
		.filter((l): l is Record<string, unknown> =>
			Boolean(l && typeof l === 'object'),
		)
		.map((l) => normalizeSectionLayout(l))
}

export async function createSectionLayout(
	client: ReservationsScopedClient,
	input: {
		locationId: string
		serviceId?: string | null
		name: string
		sections: Array<{
			id?: string
			name: string
			colorToken: string
			sort?: number
			tableIds: string[]
		}>
		isDefault?: boolean
	},
): Promise<RsvSectionLayoutRecord> {
	const res = await client.request<Record<string, unknown>>(
		'/operator/reservations/setup/sections/layouts',
		{
			method: 'POST',
			body: input,
		},
	)
	const layoutObj = (res.layout ?? res.section ?? res) as Record<
		string,
		unknown
	>
	return normalizeSectionLayout(layoutObj)
}

export async function updateSectionLayout(
	client: ReservationsScopedClient,
	sectionId: string,
	patch: {
		serviceId?: string | null
		name?: string
		sections?: Array<{
			id?: string
			name: string
			colorToken: string
			sort?: number
			tableIds: string[]
		}>
		isDefault?: boolean
	},
): Promise<RsvSectionLayoutRecord> {
	const res = await client.request<Record<string, unknown>>(
		`/operator/reservations/setup/sections/layouts/${encodeURIComponent(sectionId)}`,
		{
			method: 'PATCH',
			body: patch,
		},
	)
	const layoutObj = (res.layout ?? res.section ?? res) as Record<
		string,
		unknown
	>
	return normalizeSectionLayout(layoutObj)
}

export async function deleteSectionLayout(
	client: ReservationsScopedClient,
	sectionId: string,
): Promise<{ ok: boolean; id: string }> {
	return client.request(
		`/operator/reservations/setup/sections/layouts/${encodeURIComponent(sectionId)}`,
		{
			method: 'DELETE',
		},
	)
}

// --- resend ---

export type ResendConfirmationResult = {
	queued: number
	rotated: boolean
	reservation: DayReservationView | null
}

/** Sends the guest a fresh confirmation; `rotate` also retires the old manage link. */
export async function resendReservationConfirmation(
	client: ReservationsScopedClient,
	reservationId: string,
	options: { rotate?: boolean } = {},
): Promise<ResendConfirmationResult> {
	const raw = await client.request<Record<string, unknown>>(
		`/operator/reservations/book/reservations/${encodeURIComponent(reservationId)}/resend`,
		{
			method: 'POST',
			body: options.rotate ? { rotate: true } : {},
		},
	)
	const reservation =
		raw.reservation && typeof raw.reservation === 'object'
			? normalizeReservationView(raw.reservation as Record<string, unknown>)
			: null
	return {
		queued: Number(raw.queued ?? 0),
		rotated: raw.rotated === true,
		reservation,
	}
}
