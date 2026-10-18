import {
	type DayReservationView,
	type DayFeedResponse,
} from '#app/utils/reservations/book-api.ts'
import {
	FLOOR_CANVAS_MAX,
	type RsvFloorElementRecord,
	type RsvScheduleBlockRecord,
	type RsvServiceRecord,
	type RsvTableRecord,
} from '#app/utils/reservations/setup-api.ts'

/**
 * Pure live-floor logic: which state each table is in right now, which blocks
 * count, where things sit on the stage. No React, no translation: the route
 * and `FloorTable` turn these keys into words (`status-style.tsx`).
 */

export type FloorLiveStatus =
	| 'available'
	| 'reserved_soon'
	| 'arrived_waiting'
	| 'seated'
	| 'dessert_check'
	| 'finishing'
	| 'overtime'
	| 'blocked'

export type ComputedTableFloorState = {
	table: RsvTableRecord
	liveStatus: FloorLiveStatus
	/** Course stage of a seated party (`dessert`, `check`, `bussing`) when it drives the state. */
	stage: string | null
	currentReservation: DayReservationView | null
	nextReservation: DayReservationView | null
	elapsedMin: number | null
	remainingMin: number | null
	isBlocked: boolean
	blockId: string | null
	blockReason: string | null
	/** `HH:MM` of the next booking when the table is merely reserved later. */
	reservedAtHhmm: string | null
	sectionId: string | null
	sectionName: string | null
	sectionColorToken: string | null
	serverLabel: string | null
}

export type TableSectionInfo = {
	sectionId: string
	sectionName: string
	colorToken: string
	serverLabel: string | null
}

/** Epoch values below 1e11 are seconds, the rest milliseconds (same rule as `useLiveNow`). */
export function epochToMs(value: number): number {
	return value < 1e11 ? value * 1000 : value
}

const UPCOMING_STATUSES = new Set([
	'booked',
	'confirmed',
	'pending_payment',
	'pending_approval',
	'requested',
])

const ENDED_STATUSES = new Set([
	'cancelled',
	'no_show',
	'completed',
	'finished',
	'declined',
	'expired',
])

export function isReservationOnFloor(status: string): boolean {
	return !ENDED_STATUSES.has(status)
}

export type FloorClock = {
	nowMs: number
	/** Minutes since the business day started (can pass 1440 after midnight). */
	nowLocalMin: number
	/** True only when the viewed business date is the location's current business date. */
	live: boolean
}

/**
 * A block counts only while its window is open. With epoch bounds that is
 * `startAt <= now < endAt`; without them, the minute window on the viewed date.
 * A day that is not live has no "now", so no block is active.
 */
export function isBlockActive(
	block: RsvScheduleBlockRecord,
	clock: FloorClock,
	businessDate: string,
): boolean {
	if (!clock.live) return false
	if (block.startAt > 0 && block.endAt > 0) {
		return (
			epochToMs(block.startAt) <= clock.nowMs &&
			clock.nowMs < epochToMs(block.endAt)
		)
	}
	if (block.businessDate && block.businessDate !== businessDate) return false
	const start = block.startMin ?? 0
	const end = block.endMin ?? Number.POSITIVE_INFINITY
	return start <= clock.nowLocalMin && clock.nowLocalMin < end
}

export function activeBlockForTable(
	tableId: string,
	blocks: readonly RsvScheduleBlockRecord[],
	clock: FloorClock,
	businessDate: string,
): RsvScheduleBlockRecord | null {
	return (
		blocks.find(
			(b) => b.tableId === tableId && isBlockActive(b, clock, businessDate),
		) ?? null
	)
}

/**
 * Window for "block for the rest of service": from now (or the service start,
 * whichever is later) to the service end. The end may pass midnight (a service
 * ending at 02:00 is 1560), so there is no 1440 clamp; the API allows 2880.
 */
export function restOfServiceWindow({
	service,
	clock,
	dayStartMin,
}: {
	service:
		| (Pick<RsvServiceRecord, 'endMin' | 'firstSeatingMin'> & {
				startMin?: number
		  })
		| null
	clock: FloorClock
	dayStartMin: number
}): { startMin: number; endMin: number } {
	const serviceStart = service?.startMin ?? service?.firstSeatingMin ?? 0
	const startMin = Math.max(
		0,
		Math.min(
			2879,
			clock.live ? Math.max(clock.nowLocalMin, serviceStart) : serviceStart,
		),
	)
	const rawEnd = service?.endMin ?? dayStartMin + 1440
	const endMin = Math.min(2880, Math.max(startMin + 1, rawEnd))
	return { startMin, endMin }
}

export function computeTableFloorState({
	table,
	reservations,
	blocks,
	clock,
	businessDate,
	section,
}: {
	table: RsvTableRecord
	/** Reservations already filtered to the ones that still occupy the floor. */
	reservations: readonly DayReservationView[]
	blocks: readonly RsvScheduleBlockRecord[]
	clock: FloorClock
	businessDate: string
	section?: TableSectionInfo | null
}): ComputedTableFloorState {
	const assigned = reservations
		.filter((r) => r.assignedTableIds.includes(table.id))
		.sort((a, b) => a.localStartMin - b.localStartMin)

	const seatedRes = assigned.find((r) => r.status === 'seated') ?? null
	const arrivedRes = assigned.find((r) => r.status === 'arrived') ?? null
	const upcomingRes =
		assigned.find((r) => UPCOMING_STATUSES.has(r.status)) ?? null

	const currentReservation = seatedRes ?? arrivedRes ?? null
	const nextReservation = seatedRes ? (arrivedRes ?? upcomingRes) : upcomingRes

	const activeBlock = activeBlockForTable(table.id, blocks, clock, businessDate)

	let liveStatus: FloorLiveStatus = 'available'
	let stage: string | null = null
	let elapsedMin: number | null = null
	let remainingMin: number | null = null
	let reservedAtHhmm: string | null = null

	if (activeBlock) {
		liveStatus = 'blocked'
	} else if (seatedRes) {
		liveStatus = 'seated'
		if (clock.live) {
			const startEpoch =
				seatedRes.seatedAt ??
				(seatedRes.slotStartAt > 0 ? seatedRes.slotStartAt : null)
			const startMs = startEpoch ? epochToMs(startEpoch) : null
			if (startMs && startMs <= clock.nowMs) {
				elapsedMin = Math.max(0, Math.round((clock.nowMs - startMs) / 60_000))
			} else {
				elapsedMin = Math.max(0, clock.nowLocalMin - seatedRes.localStartMin)
			}
			const endMs =
				seatedRes.slotEndAt > 0
					? epochToMs(seatedRes.slotEndAt)
					: startMs
						? startMs + seatedRes.durationMin * 60_000
						: null
			remainingMin = endMs
				? Math.round((endMs - clock.nowMs) / 60_000)
				: seatedRes.durationMin - elapsedMin

			const courseStage = seatedRes.courseStage?.toLowerCase() ?? ''
			if (remainingMin < 0) {
				liveStatus = 'overtime'
			} else if (remainingMin <= 15) {
				liveStatus = 'finishing'
			} else if (
				courseStage === 'dessert' ||
				courseStage === 'check' ||
				courseStage === 'bussing'
			) {
				liveStatus = 'dessert_check'
				stage = courseStage
			}
		}
	} else if (arrivedRes) {
		liveStatus = 'arrived_waiting'
	} else if (upcomingRes) {
		const minsUntil = upcomingRes.localStartMin - clock.nowLocalMin
		if (clock.live && minsUntil >= -15 && minsUntil <= 30) {
			liveStatus = 'reserved_soon'
		} else {
			reservedAtHhmm = upcomingRes.hhmm
		}
	}

	return {
		table,
		liveStatus,
		stage,
		currentReservation,
		nextReservation,
		elapsedMin,
		remainingMin,
		isBlocked: Boolean(activeBlock),
		blockId: activeBlock?.id ?? null,
		blockReason: activeBlock?.note ?? activeBlock?.reason ?? null,
		reservedAtHhmm,
		sectionId: section?.sectionId ?? null,
		sectionName: section?.sectionName ?? null,
		sectionColorToken: section?.colorToken ?? null,
		serverLabel:
			section?.serverLabel ??
			currentReservation?.serverLabel ??
			nextReservation?.serverLabel ??
			null,
	}
}

type AreaLike = { id: string; isActive?: boolean; archivedAt?: number | null }

/**
 * The floor draws one area at a time: each area has its own coordinate space,
 * so stacking them on one stage overlaps tables. Use the requested area when it
 * exists and is active, else the first active area.
 */
export function pickFloorAreaId(
	areas: readonly AreaLike[],
	requested: string | null | undefined,
): string | null {
	const usable = areas.filter((a) => a.isActive !== false && !a.archivedAt)
	if (requested && usable.some((a) => a.id === requested)) return requested
	return usable[0]?.id ?? null
}

export function floorTablesForArea(
	tables: readonly RsvTableRecord[],
	areaId: string | null,
): RsvTableRecord[] {
	return tables.filter(
		(table) => table.isActive !== false && (!areaId || table.areaId === areaId),
	)
}

/** Elements belong to an area; one with no area is shared and shows on every floor. */
export function floorElementsForArea(
	elements: readonly RsvFloorElementRecord[],
	areaId: string | null,
): RsvFloorElementRecord[] {
	return elements.filter(
		(element) => !areaId || !element.areaId || element.areaId === areaId,
	)
}

export const FLOOR_STAGE_MAX_HEIGHT = 720
export const FLOOR_TILE_MIN = 20
const STAGE_PADDING = 24
const STAGE_MIN = { width: 560, height: 360 }

export type FloorPlacement = {
	x: number
	y: number
	width: number
	height: number
	rotation: number
}

type PlacedBox = {
	x?: number
	y?: number
	posX?: number
	posY?: number
	width?: number
	height?: number
	w?: number
	h?: number
	rotation?: number
	rotDeg?: number
}

/** Real position and size from the layout; a missing size falls back to 70, the editor default. */
export function floorPlacement(item: PlacedBox): FloorPlacement {
	return {
		x: Number(item.x ?? item.posX ?? 0),
		y: Number(item.y ?? item.posY ?? 0),
		width: Math.max(FLOOR_TILE_MIN, Number(item.width ?? item.w ?? 70)),
		height: Math.max(FLOOR_TILE_MIN, Number(item.height ?? item.h ?? 70)),
		rotation: Number(item.rotation ?? item.rotDeg ?? 0),
	}
}

/**
 * Tables a layout never placed (all at 0,0) would pile up in the corner, so the
 * second and later ones go on a simple grid instead.
 */
export function floorPlacementWithFallback(
	item: PlacedBox,
	index: number,
): FloorPlacement {
	const placement = floorPlacement(item)
	if (index === 0 || placement.x > 0 || placement.y > 0) return placement
	return {
		...placement,
		x: 24 + (index % 6) * (placement.width + 24),
		y: 24 + Math.floor(index / 6) * (placement.height + 24),
	}
}

/**
 * Stage size: wraps what is on the area with some padding, never larger than
 * the editor canvas (`FLOOR_CANVAS_MAX` wide, 720 high), so a layout drawn in
 * the editor lands in the same place here.
 */
export function floorStageSize(
	tables: readonly PlacedBox[],
	elements: readonly PlacedBox[] = [],
): {
	width: number
	height: number
} {
	let maxX = 0
	let maxY = 0
	const placements = [
		...tables.map((item, index) => floorPlacementWithFallback(item, index)),
		...elements.map((item) => floorPlacement(item)),
	]
	for (const p of placements) {
		maxX = Math.max(maxX, p.x + p.width)
		maxY = Math.max(maxY, p.y + p.height)
	}
	return {
		width: Math.min(
			FLOOR_CANVAS_MAX,
			Math.max(STAGE_MIN.width, maxX + STAGE_PADDING),
		),
		height: Math.min(
			FLOOR_STAGE_MAX_HEIGHT,
			Math.max(STAGE_MIN.height, maxY + STAGE_PADDING),
		),
	}
}

export type FloorFeed = Pick<
	DayFeedResponse,
	'businessDate' | 'tables' | 'blocks' | 'reservations'
>
