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

/** Smallest a live table tile is drawn (stage units, scale 1): below this its text cannot fit. */
export const FLOOR_TABLE_MIN = 72

/**
 * Placement of a table tile on the live floor: `floorPlacementWithFallback`,
 * grown (to the right and down, so the room never moves left or up) to at
 * least `FLOOR_TABLE_MIN` each way. The room bounds and fit scale use the same
 * size, so a grown tile never spills out of the stage.
 */
export function floorTablePlacement(
	item: PlacedBox,
	index: number,
): FloorPlacement {
	const p = floorPlacementWithFallback(item, index)
	return {
		...p,
		width: Math.max(FLOOR_TABLE_MIN, p.width),
		height: Math.max(FLOOR_TABLE_MIN, p.height),
	}
}

export type FloorTileLayout = {
	/** `tight` tiles print the table, one compact status word and the party; `roomy` ones add time, timer, capacity and section. */
	tier: 'tight' | 'roomy'
	/** Lines the party name may wrap to before it is clamped. */
	partyLines: 1 | 2
}

/**
 * What a tile can hold, from its own size (never from a fixed text width):
 * roomy needs 104x88 (a round tile loses its corners, so it needs 128x112),
 * and the party name gets a second line once the tile is 80 or more tall.
 */
export function floorTileLayout(
	width: number,
	height: number,
	isRound = false,
): FloorTileLayout {
	const needW = isRound ? 128 : 104
	const needH = isRound ? 112 : 88
	return {
		tier: width >= needW && height >= needH ? 'roomy' : 'tight',
		partyLines: height >= 80 ? 2 : 1,
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
		...tables.map((item, index) => floorTablePlacement(item, index)),
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

/** Padding around the room's tables, in stage units. */
const ROOM_PADDING = 16
/** Never magnify the room beyond this, so a one-table area does not become a poster (wide screens still fill). */
export const FLOOR_MAX_SCALE = 2.2
/** Below this the tiles stop being legible; the room scrolls sideways instead. */
export const FLOOR_MIN_SCALE = 0.8

/**
 * Bounding box of what is actually on the area (tables and elements), padded.
 * The live floor fits THIS box to its container instead of the full canvas, so
 * a small room is not left floating in empty space. Geometry stays in stage
 * units and is never mirrored (RTL does not flip a floor plan).
 */
export function floorRoomBounds(
	tables: readonly PlacedBox[],
	elements: readonly PlacedBox[] = [],
): { x: number; y: number; width: number; height: number } {
	const placements = [
		...tables.map((item, index) => floorTablePlacement(item, index)),
		...elements.map((item) => floorPlacement(item)),
	]
	if (placements.length === 0) {
		return { x: 0, y: 0, width: STAGE_MIN.width, height: STAGE_MIN.height }
	}
	let minX = Number.POSITIVE_INFINITY
	let minY = Number.POSITIVE_INFINITY
	let maxX = 0
	let maxY = 0
	for (const p of placements) {
		minX = Math.min(minX, p.x)
		minY = Math.min(minY, p.y)
		maxX = Math.max(maxX, p.x + p.width)
		maxY = Math.max(maxY, p.y + p.height)
	}
	const x = Math.max(0, minX - ROOM_PADDING)
	const y = Math.max(0, minY - ROOM_PADDING)
	return {
		x,
		y,
		width: maxX + ROOM_PADDING - x,
		height: maxY + ROOM_PADDING - y,
	}
}

/** Fit-to-width scale for a room, clamped to `[FLOOR_MIN_SCALE, FLOOR_MAX_SCALE]`. */
export function floorFitScale(
	availableWidth: number,
	roomWidth: number,
): number {
	if (!(availableWidth > 0) || !(roomWidth > 0)) return 1
	return Math.max(
		FLOOR_MIN_SCALE,
		Math.min(FLOOR_MAX_SCALE, availableWidth / roomWidth),
	)
}

export type FloorFeed = Pick<
	DayFeedResponse,
	'businessDate' | 'tables' | 'blocks' | 'reservations'
>
