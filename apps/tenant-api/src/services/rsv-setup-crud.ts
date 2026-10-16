import { randomUUID } from 'node:crypto'
import {
	isValidTimeZone,
	localToInstant,
	type ConflictItem,
} from '@repo/reservations'
import {
	rsvAreas,
	rsvAuditLog,
	rsvBlocks,
	rsvDayVersions,
	rsvFloorElements,
	rsvLocationSettings,
	rsvPacingRules,
	rsvReservations,
	rsvSectionLayouts,
	rsvSections,
	rsvSectionTables,
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
import { and, asc, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm'
import { badRequest, conflict, notFound } from '../lib/http.js'
import { withSetupWrite } from '../lib/reservations-write.ts'
import {
	getFloorPlan,
	reflowFutureBookingsForLocation,
	serializeArea,
	serializeBlock,
	serializeCombo,
	serializeElement,
	serializePacingRule,
	serializeService,
	serializeServiceAvailability,
	serializeSpecialDay,
	serializeTable,
	serializeTurnTime,
	type ReflowMove,
} from './rsv-setup-service.js'

function createId(prefix: string): string {
	return `${prefix}_${randomUUID()}`
}

const SOFT_REFLOWABLE_STATUSES = new Set([
	'pending_payment',
	'pending_approval',
	'booked',
	'confirmed',
])

async function ensureSettingsRowForLocation(
	db: TenantDatabase,
	locationId: string,
) {
	const existing = await db
		.select()
		.from(rsvLocationSettings)
		.where(eq(rsvLocationSettings.locationId, locationId))
		.get()
	if (existing) return existing

	const now = Date.now()
	await db
		.insert(rsvLocationSettings)
		.values({
			locationId,
			timeZone: 'UTC',
			updatedAt: now,
		})
		.onConflictDoNothing()

	const created = await db
		.select()
		.from(rsvLocationSettings)
		.where(eq(rsvLocationSettings.locationId, locationId))
		.get()
	if (!created) throw notFound('Location settings could not be initialized')
	return created
}

async function bumpFloorPlanVersion(
	db: TenantDatabase,
	locationId: string,
	actorId: string | null,
): Promise<number> {
	const settings = await ensureSettingsRowForLocation(db, locationId)
	const nextVersion = (settings.floorPlanVersion ?? 1) + 1
	await db
		.update(rsvLocationSettings)
		.set({
			floorPlanVersion: nextVersion,
			updatedAt: Date.now(),
			updatedBy: actorId,
		})
		.where(eq(rsvLocationSettings.locationId, locationId))
	return nextVersion
}

async function bumpDayVersion(
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

async function writeSetupAudit(
	db: TenantDatabase,
	params: {
		actorId: string | null
		locationId: string
		action: string
		entityKind: string
		entityId: string
		diff?: Record<string, unknown>
	},
) {
	await db.insert(rsvAuditLog).values({
		id: createId('aud'),
		at: Date.now(),
		actorKind: 'operator',
		actorId: params.actorId,
		locationId: params.locationId,
		entityType: params.entityKind,
		entityId: params.entityId,
		action: params.action,
		changes: params.diff ?? {},
	})
}

// ============================================================================
// Dining Areas
// ============================================================================

export async function listAreasForLocation(
	db: TenantDatabase,
	locationId: string,
	includeArchived = false,
) {
	const rows = await db
		.select()
		.from(rsvAreas)
		.where(
			includeArchived
				? eq(rsvAreas.locationId, locationId)
				: and(eq(rsvAreas.locationId, locationId), isNull(rsvAreas.archivedAt)),
		)
		.orderBy(asc(rsvAreas.sort), asc(rsvAreas.name))
		.all()
	return rows.map(serializeArea)
}

export async function createAreaForLocation(
	db: TenantDatabase,
	input: {
		actorId: string | null
		locationId: string
		name: string
		nameI18n?: Record<string, string>
		onlineBookable?: boolean
		guestSelectable?: boolean
		canvasW?: number
		canvasH?: number
		sort?: number
		sortOrder?: number
	},
) {
	return withSetupWrite(db, async (db) => {
		await ensureSettingsRowForLocation(db, input.locationId)
		const now = Date.now()
		const id = createId('area')
		await db.insert(rsvAreas).values({
			id,
			locationId: input.locationId,
			name: input.name.trim(),
			nameI18n: input.nameI18n ?? { en: input.name.trim() },
			sort: input.sort ?? input.sortOrder ?? 0,
			onlineBookable: input.onlineBookable ?? true,
			guestSelectable: input.guestSelectable ?? true,
			canvasW: input.canvasW ?? 1200,
			canvasH: input.canvasH ?? 800,
			archivedAt: null,
			createdAt: now,
			updatedAt: now,
			version: 1,
		})
		const floorPlanVersion = await bumpFloorPlanVersion(
			db,
			input.locationId,
			input.actorId,
		)
		await writeSetupAudit(db, {
			actorId: input.actorId,
			locationId: input.locationId,
			action: 'area.create',
			entityKind: 'area',
			entityId: id,
			diff: { name: input.name.trim() },
		})
		const row = await db
			.select()
			.from(rsvAreas)
			.where(eq(rsvAreas.id, id))
			.get()
		return { area: serializeArea(row!), floorPlanVersion }
	})
}

export async function updateAreaForLocation(
	db: TenantDatabase,
	areaId: string,
	patch: {
		actorId: string | null
		locationId?: string
		name?: string
		nameI18n?: Record<string, string>
		onlineBookable?: boolean
		guestSelectable?: boolean
		canvasW?: number
		canvasH?: number
		sort?: number
		sortOrder?: number
		active?: boolean
		archived?: boolean
	},
) {
	return withSetupWrite(db, async (db) => {
		const existing = await db
			.select()
			.from(rsvAreas)
			.where(eq(rsvAreas.id, areaId))
			.get()
		if (!existing) throw notFound('Area not found')
		if (patch.locationId && patch.locationId !== existing.locationId) {
			throw notFound('Area not found in location')
		}

		const now = Date.now()
		const shouldArchive =
			patch.archived === true ||
			patch.active === false ||
			(patch.archived === undefined &&
				patch.active === undefined &&
				existing.archivedAt !== null)
		const nextArchivedAt = shouldArchive ? (existing.archivedAt ?? now) : null

		await db
			.update(rsvAreas)
			.set({
				...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
				...(patch.nameI18n !== undefined ? { nameI18n: patch.nameI18n } : {}),
				...(patch.onlineBookable !== undefined
					? { onlineBookable: patch.onlineBookable }
					: {}),
				...(patch.guestSelectable !== undefined
					? { guestSelectable: patch.guestSelectable }
					: {}),
				...(patch.canvasW !== undefined ? { canvasW: patch.canvasW } : {}),
				...(patch.canvasH !== undefined ? { canvasH: patch.canvasH } : {}),
				...(patch.sort !== undefined || patch.sortOrder !== undefined
					? { sort: patch.sort ?? patch.sortOrder ?? existing.sort }
					: {}),
				archivedAt: nextArchivedAt,
				updatedAt: now,
				version: existing.version + 1,
			})
			.where(eq(rsvAreas.id, areaId))

		const floorPlanVersion = await bumpFloorPlanVersion(
			db,
			existing.locationId,
			patch.actorId,
		)

		let reflowResult: {
			conflicts: ConflictItem[]
			reflowedMoves: ReflowMove[]
		} = {
			conflicts: [],
			reflowedMoves: [],
		}
		if (
			(existing.archivedAt === null && nextArchivedAt !== null) ||
			(patch.onlineBookable === false && existing.onlineBookable === true)
		) {
			const areaTables = await db
				.select()
				.from(rsvTables)
				.where(eq(rsvTables.areaId, areaId))
				.all()
			reflowResult = await reflowFutureBookingsForLocation(
				db,
				existing.locationId,
				{
					invalidatedTableIds:
						nextArchivedAt !== null ? areaTables.map((t) => t.id) : [],
				},
			)
		}

		await writeSetupAudit(db, {
			actorId: patch.actorId,
			locationId: existing.locationId,
			action: 'area.update',
			entityKind: 'area',
			entityId: areaId,
		})
		const updated = await db
			.select()
			.from(rsvAreas)
			.where(eq(rsvAreas.id, areaId))
			.get()
		return {
			area: serializeArea(updated!),
			floorPlanVersion,
			...reflowResult,
		}
	})
}

export async function archiveAreaForLocation(
	db: TenantDatabase,
	areaId: string,
	actorId: string | null,
	locationId?: string,
) {
	return withSetupWrite(db, async (db) => {
		const existing = await db
			.select()
			.from(rsvAreas)
			.where(eq(rsvAreas.id, areaId))
			.get()
		if (!existing) throw notFound('Area not found')
		if (locationId && existing.locationId !== locationId) {
			throw notFound('Area not found in location')
		}

		const now = Date.now()
		await db
			.update(rsvAreas)
			.set({
				archivedAt: now,
				updatedAt: now,
				version: existing.version + 1,
			})
			.where(eq(rsvAreas.id, areaId))

		const areaTables = await db
			.select()
			.from(rsvTables)
			.where(and(eq(rsvTables.areaId, areaId), isNull(rsvTables.archivedAt)))
			.all()

		if (areaTables.length > 0) {
			await db
				.update(rsvTables)
				.set({ archivedAt: now, updatedAt: now })
				.where(eq(rsvTables.areaId, areaId))
		}

		const floorPlanVersion = await bumpFloorPlanVersion(
			db,
			existing.locationId,
			actorId,
		)
		const reflowResult = await reflowFutureBookingsForLocation(
			db,
			existing.locationId,
			{
				invalidatedTableIds: areaTables.map((t) => t.id),
			},
		)

		await writeSetupAudit(db, {
			actorId,
			locationId: existing.locationId,
			action: 'area.archive',
			entityKind: 'area',
			entityId: areaId,
		})

		const updated = await db
			.select()
			.from(rsvAreas)
			.where(eq(rsvAreas.id, areaId))
			.get()
		return {
			area: serializeArea(updated!),
			floorPlanVersion,
			...reflowResult,
		}
	})
}

// ============================================================================
// Tables
// ============================================================================

export async function listTablesForLocation(
	db: TenantDatabase,
	locationId: string,
	opts?: { areaId?: string; includeArchived?: boolean },
) {
	const conditions = [eq(rsvTables.locationId, locationId)]
	if (opts?.areaId) conditions.push(eq(rsvTables.areaId, opts.areaId))
	if (!opts?.includeArchived) conditions.push(isNull(rsvTables.archivedAt))

	const rows = await db
		.select()
		.from(rsvTables)
		.where(and(...conditions))
		.orderBy(asc(rsvTables.priority), asc(rsvTables.label))
		.all()
	return rows.map(serializeTable)
}

export async function createTableForLocation(
	db: TenantDatabase,
	input: {
		actorId: string | null
		locationId: string
		areaId: string
		label: string
		shape?: 'round' | 'square' | 'rect' | 'booth' | 'bar'
		minCovers?: number
		maxCovers?: number
		minSeats?: number
		maxSeats?: number
		onlineBookable?: boolean
		onlineEnabled?: boolean
		combinable?: boolean
		priority?: number
		resetBufferMin?: number | null
		x?: number
		y?: number
		w?: number
		h?: number
		width?: number
		height?: number
		rotation?: number
	},
) {
	return withSetupWrite(db, async (db) => {
		const area = await db
			.select()
			.from(rsvAreas)
			.where(
				and(
					eq(rsvAreas.id, input.areaId),
					eq(rsvAreas.locationId, input.locationId),
				),
			)
			.get()
		if (!area)
			throw badRequest('invalid_area', 'Area does not exist in location')

		const minCovers = input.minCovers ?? input.minSeats ?? 1
		const maxCovers = input.maxCovers ?? input.maxSeats ?? 2
		if (minCovers < 1 || maxCovers < minCovers || maxCovers > 99) {
			throw badRequest(
				'invalid_capacity',
				'minCovers must be >= 1 and <= maxCovers (<= 99)',
			)
		}
		const resetBufferMin = input.resetBufferMin ?? 0
		if (resetBufferMin < 0 || resetBufferMin > 120) {
			throw badRequest(
				'invalid_reset_buffer',
				'resetBufferMin must be between 0 and 120',
			)
		}

		const trimmedLabel = input.label.trim()
		const dup = await db
			.select()
			.from(rsvTables)
			.where(
				and(
					eq(rsvTables.locationId, input.locationId),
					eq(rsvTables.label, trimmedLabel),
					isNull(rsvTables.archivedAt),
				),
			)
			.get()
		if (dup) {
			throw conflict(
				'duplicate_table_label',
				`Active table with label "${trimmedLabel}" already exists in this location`,
			)
		}

		const now = Date.now()
		const id = createId('tbl')
		await db.insert(rsvTables).values({
			id,
			locationId: input.locationId,
			areaId: input.areaId,
			label: trimmedLabel,
			shape: input.shape ?? 'square',
			minCovers,
			maxCovers,
			onlineBookable: input.onlineBookable ?? input.onlineEnabled ?? true,
			combinable: input.combinable ?? false,
			priority: input.priority ?? 0,
			resetBufferMin,
			x: input.x ?? 0,
			y: input.y ?? 0,
			w: input.w ?? input.width ?? 60,
			h: input.h ?? input.height ?? 60,
			rotation: input.rotation ?? 0,
			archivedAt: null,
			createdAt: now,
			updatedAt: now,
		})

		const floorPlanVersion = await bumpFloorPlanVersion(
			db,
			input.locationId,
			input.actorId,
		)
		await writeSetupAudit(db, {
			actorId: input.actorId,
			locationId: input.locationId,
			action: 'table.create',
			entityKind: 'table',
			entityId: id,
			diff: { label: trimmedLabel, minCovers, maxCovers },
		})

		const row = await db
			.select()
			.from(rsvTables)
			.where(eq(rsvTables.id, id))
			.get()
		return { table: serializeTable(row!), floorPlanVersion }
	})
}

export async function updateTableForLocation(
	db: TenantDatabase,
	tableId: string,
	patch: {
		actorId: string | null
		locationId?: string
		areaId?: string
		label?: string
		shape?: 'round' | 'square' | 'rect' | 'booth' | 'bar'
		minCovers?: number
		maxCovers?: number
		minSeats?: number
		maxSeats?: number
		onlineBookable?: boolean
		onlineEnabled?: boolean
		combinable?: boolean
		priority?: number
		resetBufferMin?: number | null
		x?: number
		y?: number
		w?: number
		h?: number
		width?: number
		height?: number
		rotation?: number
		active?: boolean
		archived?: boolean
	},
) {
	return withSetupWrite(db, async (db) => {
		const existing = await db
			.select()
			.from(rsvTables)
			.where(eq(rsvTables.id, tableId))
			.get()
		if (!existing) throw notFound('Table not found')
		if (patch.locationId && patch.locationId !== existing.locationId) {
			throw notFound('Table not found in location')
		}

		const nextLabel =
			patch.label !== undefined ? patch.label.trim() : existing.label
		if (nextLabel !== existing.label) {
			const dup = await db
				.select()
				.from(rsvTables)
				.where(
					and(
						eq(rsvTables.locationId, existing.locationId),
						eq(rsvTables.label, nextLabel),
						isNull(rsvTables.archivedAt),
					),
				)
				.get()
			if (dup && dup.id !== tableId) {
				throw conflict(
					'duplicate_table_label',
					`Active table with label "${nextLabel}" already exists in this location`,
				)
			}
		}

		const nextMinCovers =
			patch.minCovers ?? patch.minSeats ?? existing.minCovers
		const nextMaxCovers =
			patch.maxCovers ?? patch.maxSeats ?? existing.maxCovers
		if (
			nextMinCovers < 1 ||
			nextMaxCovers < nextMinCovers ||
			nextMaxCovers > 99
		) {
			throw badRequest(
				'invalid_capacity',
				'minCovers must be >= 1 and <= maxCovers (<= 99)',
			)
		}
		const nextResetBuffer =
			patch.resetBufferMin !== undefined
				? (patch.resetBufferMin ?? 0)
				: existing.resetBufferMin
		if (nextResetBuffer < 0 || nextResetBuffer > 120) {
			throw badRequest(
				'invalid_reset_buffer',
				'resetBufferMin must be between 0 and 120',
			)
		}

		const now = Date.now()
		const shouldArchive =
			patch.archived === true ||
			patch.active === false ||
			(patch.archived === undefined &&
				patch.active === undefined &&
				existing.archivedAt !== null)
		const nextArchivedAt = shouldArchive ? (existing.archivedAt ?? now) : null
		const nextOnlineBookable =
			patch.onlineBookable ?? patch.onlineEnabled ?? existing.onlineBookable

		await db
			.update(rsvTables)
			.set({
				...(patch.areaId !== undefined ? { areaId: patch.areaId } : {}),
				label: nextLabel,
				...(patch.shape !== undefined ? { shape: patch.shape } : {}),
				minCovers: nextMinCovers,
				maxCovers: nextMaxCovers,
				onlineBookable: nextOnlineBookable,
				...(patch.combinable !== undefined
					? { combinable: patch.combinable }
					: {}),
				...(patch.priority !== undefined ? { priority: patch.priority } : {}),
				resetBufferMin: nextResetBuffer,
				...(patch.x !== undefined ? { x: patch.x } : {}),
				...(patch.y !== undefined ? { y: patch.y } : {}),
				...(patch.w !== undefined || patch.width !== undefined
					? { w: patch.w ?? patch.width ?? existing.w }
					: {}),
				...(patch.h !== undefined || patch.height !== undefined
					? { h: patch.h ?? patch.height ?? existing.h }
					: {}),
				...(patch.rotation !== undefined ? { rotation: patch.rotation } : {}),
				archivedAt: nextArchivedAt,
				updatedAt: now,
			})
			.where(eq(rsvTables.id, tableId))

		const floorPlanVersion = await bumpFloorPlanVersion(
			db,
			existing.locationId,
			patch.actorId,
		)

		const capacityShrunk =
			nextMaxCovers < existing.maxCovers || nextMinCovers > existing.minCovers
		const newlyArchived =
			existing.archivedAt === null && nextArchivedAt !== null

		let reflowResult: {
			conflicts: ConflictItem[]
			reflowedMoves: ReflowMove[]
		} = {
			conflicts: [],
			reflowedMoves: [],
		}
		if (newlyArchived || capacityShrunk) {
			reflowResult = await reflowFutureBookingsForLocation(
				db,
				existing.locationId,
				{
					invalidatedTableIds: newlyArchived ? [tableId] : [],
				},
			)
		}

		await writeSetupAudit(db, {
			actorId: patch.actorId,
			locationId: existing.locationId,
			action: 'table.update',
			entityKind: 'table',
			entityId: tableId,
			diff: {
				minCovers: nextMinCovers,
				maxCovers: nextMaxCovers,
				archivedAt: nextArchivedAt,
			},
		})

		const updated = await db
			.select()
			.from(rsvTables)
			.where(eq(rsvTables.id, tableId))
			.get()
		return {
			table: serializeTable(updated!),
			floorPlanVersion,
			...reflowResult,
		}
	})
}

export async function archiveTableForLocation(
	db: TenantDatabase,
	tableId: string,
	actorId: string | null,
	locationId?: string,
) {
	return withSetupWrite(db, async (db) => {
		const existing = await db
			.select()
			.from(rsvTables)
			.where(eq(rsvTables.id, tableId))
			.get()
		if (!existing) throw notFound('Table not found')
		if (locationId && existing.locationId !== locationId) {
			throw notFound('Table not found in location')
		}

		const now = Date.now()
		await db
			.update(rsvTables)
			.set({
				archivedAt: now,
				updatedAt: now,
			})
			.where(eq(rsvTables.id, tableId))

		const floorPlanVersion = await bumpFloorPlanVersion(
			db,
			existing.locationId,
			actorId,
		)
		const reflowResult = await reflowFutureBookingsForLocation(
			db,
			existing.locationId,
			{
				invalidatedTableIds: [tableId],
			},
		)

		await writeSetupAudit(db, {
			actorId,
			locationId: existing.locationId,
			action: 'table.archive',
			entityKind: 'table',
			entityId: tableId,
		})

		const updated = await db
			.select()
			.from(rsvTables)
			.where(eq(rsvTables.id, tableId))
			.get()
		return {
			archived: true,
			table: serializeTable(updated!),
			floorPlanVersion,
			...reflowResult,
		}
	})
}

// ============================================================================
// Table Combinations
// ============================================================================

export async function createComboForLocation(
	db: TenantDatabase,
	input: {
		actorId: string | null
		locationId: string
		label?: string
		name?: string
		minCovers?: number
		maxCovers?: number
		minSeats?: number
		maxSeats?: number
		priority?: number
		onlineBookable?: boolean
		tableIds: string[]
	},
) {
	return withSetupWrite(db, async (db) => {
		const uniqueTableIds = [...new Set(input.tableIds)].sort()
		if (uniqueTableIds.length < 2) {
			throw badRequest(
				'invalid_combination',
				'Combination must contain at least 2 distinct tables',
			)
		}
		const minCovers = input.minCovers ?? input.minSeats ?? 2
		const maxCovers = input.maxCovers ?? input.maxSeats ?? 6
		if (minCovers < 1 || maxCovers < minCovers || maxCovers > 99) {
			throw badRequest(
				'invalid_capacity',
				'minCovers must be >= 1 and <= maxCovers (<= 99)',
			)
		}

		const tables = await db
			.select()
			.from(rsvTables)
			.where(
				and(
					eq(rsvTables.locationId, input.locationId),
					inArray(rsvTables.id, uniqueTableIds),
				),
			)
			.all()
		if (tables.length !== uniqueTableIds.length) {
			throw badRequest(
				'invalid_combination_tables',
				'All combination tables must belong to this location',
			)
		}
		for (const tbl of tables) {
			if (tbl.archivedAt !== null || !tbl.combinable) {
				throw badRequest(
					'table_not_combinable',
					`Table "${tbl.label}" is not combinable or is archived`,
				)
			}
		}

		const activeCombos = await db
			.select()
			.from(rsvTableCombos)
			.where(
				and(
					eq(rsvTableCombos.locationId, input.locationId),
					isNull(rsvTableCombos.archivedAt),
				),
			)
			.all()
		if (activeCombos.length > 0) {
			const activeComboIds = activeCombos.map((c) => c.id)
			const existingMembers = await db
				.select()
				.from(rsvTableComboMembers)
				.where(inArray(rsvTableComboMembers.comboId, activeComboIds))
				.all()
			const canonicalKey = uniqueTableIds.join(',')
			for (const c of activeCombos) {
				const cKey = existingMembers
					.filter((m) => m.comboId === c.id)
					.map((m) => m.tableId)
					.sort()
					.join(',')
				if (cKey === canonicalKey) {
					throw conflict(
						'duplicate_combination',
						'An active combination with the same member tables already exists',
					)
				}
			}
		}

		const now = Date.now()
		const id = createId('cmb')
		const label = (input.label ?? input.name ?? 'Combo').trim()
		await db.insert(rsvTableCombos).values({
			id,
			locationId: input.locationId,
			label,
			minCovers,
			maxCovers,
			onlineBookable: input.onlineBookable ?? true,
			priority: input.priority ?? 0,
			archivedAt: null,
			createdAt: now,
			updatedAt: now,
		})

		for (const tid of uniqueTableIds) {
			await db.insert(rsvTableComboMembers).values({
				comboId: id,
				tableId: tid,
			})
		}

		const floorPlanVersion = await bumpFloorPlanVersion(
			db,
			input.locationId,
			input.actorId,
		)
		await writeSetupAudit(db, {
			actorId: input.actorId,
			locationId: input.locationId,
			action: 'combo.create',
			entityKind: 'combination',
			entityId: id,
			diff: { label, tableIds: uniqueTableIds },
		})

		const row = await db
			.select()
			.from(rsvTableCombos)
			.where(eq(rsvTableCombos.id, id))
			.get()
		const serialized = serializeCombo(row!, uniqueTableIds)
		return {
			combo: serialized,
			combination: serialized,
			floorPlanVersion,
		}
	})
}

export async function updateComboForLocation(
	db: TenantDatabase,
	comboId: string,
	patch: {
		actorId: string | null
		locationId?: string
		label?: string
		name?: string
		minCovers?: number
		maxCovers?: number
		minSeats?: number
		maxSeats?: number
		priority?: number
		onlineBookable?: boolean
		active?: boolean
		archived?: boolean
		tableIds?: string[]
	},
) {
	return withSetupWrite(db, async (db) => {
		const existing = await db
			.select()
			.from(rsvTableCombos)
			.where(eq(rsvTableCombos.id, comboId))
			.get()
		if (!existing) throw notFound('Combination not found')
		if (patch.locationId && patch.locationId !== existing.locationId) {
			throw notFound('Combination not found in location')
		}

		const nextMinCovers =
			patch.minCovers ?? patch.minSeats ?? existing.minCovers
		const nextMaxCovers =
			patch.maxCovers ?? patch.maxSeats ?? existing.maxCovers
		if (
			nextMinCovers < 1 ||
			nextMaxCovers < nextMinCovers ||
			nextMaxCovers > 99
		) {
			throw badRequest(
				'invalid_capacity',
				'minCovers must be >= 1 and <= maxCovers (<= 99)',
			)
		}

		const now = Date.now()
		const shouldArchive =
			patch.archived === true ||
			patch.active === false ||
			(patch.archived === undefined &&
				patch.active === undefined &&
				existing.archivedAt !== null)
		const nextArchivedAt = shouldArchive ? (existing.archivedAt ?? now) : null

		let nextTableIds: string[] | undefined
		if (patch.tableIds !== undefined) {
			nextTableIds = [...new Set(patch.tableIds)].sort()
			if (nextTableIds.length < 2) {
				throw badRequest(
					'invalid_combination',
					'Combination must contain at least 2 distinct tables',
				)
			}
			const tables = await db
				.select()
				.from(rsvTables)
				.where(
					and(
						eq(rsvTables.locationId, existing.locationId),
						inArray(rsvTables.id, nextTableIds),
					),
				)
				.all()
			if (tables.length !== nextTableIds.length) {
				throw badRequest(
					'invalid_combination_tables',
					'All combination tables must belong to this location',
				)
			}
			for (const tbl of tables) {
				if (tbl.archivedAt !== null || !tbl.combinable) {
					throw badRequest(
						'table_not_combinable',
						`Table "${tbl.label}" is not combinable or is archived`,
					)
				}
			}
		}

		if (nextArchivedAt === null) {
			const effectiveTableIds =
				nextTableIds ??
				(
					await db
						.select()
						.from(rsvTableComboMembers)
						.where(eq(rsvTableComboMembers.comboId, comboId))
						.all()
				)
					.map((m) => m.tableId)
					.sort()
			const canonicalKey = effectiveTableIds.join(',')
			const activeCombos = await db
				.select()
				.from(rsvTableCombos)
				.where(
					and(
						eq(rsvTableCombos.locationId, existing.locationId),
						isNull(rsvTableCombos.archivedAt),
					),
				)
				.all()
			const otherComboIds = activeCombos
				.filter((c) => c.id !== comboId)
				.map((c) => c.id)
			if (otherComboIds.length > 0) {
				const existingMembers = await db
					.select()
					.from(rsvTableComboMembers)
					.where(inArray(rsvTableComboMembers.comboId, otherComboIds))
					.all()
				for (const otherId of otherComboIds) {
					const otherKey = existingMembers
						.filter((m) => m.comboId === otherId)
						.map((m) => m.tableId)
						.sort()
						.join(',')
					if (otherKey === canonicalKey) {
						throw conflict(
							'duplicate_combination',
							'An active combination with the same member tables already exists',
						)
					}
				}
			}
		}

		if (nextTableIds !== undefined) {
			await db
				.delete(rsvTableComboMembers)
				.where(eq(rsvTableComboMembers.comboId, comboId))
			for (const tid of nextTableIds) {
				await db.insert(rsvTableComboMembers).values({
					comboId,
					tableId: tid,
				})
			}
		}

		await db
			.update(rsvTableCombos)
			.set({
				...(patch.label !== undefined || patch.name !== undefined
					? { label: (patch.label ?? patch.name ?? existing.label).trim() }
					: {}),
				minCovers: nextMinCovers,
				maxCovers: nextMaxCovers,
				...(patch.priority !== undefined ? { priority: patch.priority } : {}),
				...(patch.onlineBookable !== undefined
					? { onlineBookable: patch.onlineBookable }
					: {}),
				archivedAt: nextArchivedAt,
				updatedAt: now,
			})
			.where(eq(rsvTableCombos.id, comboId))

		const floorPlanVersion = await bumpFloorPlanVersion(
			db,
			existing.locationId,
			patch.actorId,
		)

		let reflowResult: {
			conflicts: ConflictItem[]
			reflowedMoves: ReflowMove[]
		} = {
			conflicts: [],
			reflowedMoves: [],
		}
		if (
			nextMaxCovers < existing.maxCovers ||
			nextMinCovers > existing.minCovers ||
			nextArchivedAt !== null
		) {
			reflowResult = await reflowFutureBookingsForLocation(
				db,
				existing.locationId,
			)
		}

		const members = await db
			.select()
			.from(rsvTableComboMembers)
			.where(eq(rsvTableComboMembers.comboId, comboId))
			.all()
		const updated = await db
			.select()
			.from(rsvTableCombos)
			.where(eq(rsvTableCombos.id, comboId))
			.get()
		const serialized = serializeCombo(
			updated!,
			members.map((m) => m.tableId),
		)
		return {
			combo: serialized,
			combination: serialized,
			floorPlanVersion,
			...reflowResult,
		}
	})
}

export async function deleteComboForLocation(
	db: TenantDatabase,
	comboId: string,
	actorId: string | null,
	locationId?: string,
) {
	return withSetupWrite(db, async (db) => {
		const existing = await db
			.select()
			.from(rsvTableCombos)
			.where(eq(rsvTableCombos.id, comboId))
			.get()
		if (!existing) throw notFound('Combination not found')
		if (locationId && existing.locationId !== locationId) {
			throw notFound('Combination not found in location')
		}

		const now = Date.now()
		await db
			.update(rsvTableCombos)
			.set({ archivedAt: now, updatedAt: now })
			.where(eq(rsvTableCombos.id, comboId))

		const floorPlanVersion = await bumpFloorPlanVersion(
			db,
			existing.locationId,
			actorId,
		)
		const reflowResult = await reflowFutureBookingsForLocation(
			db,
			existing.locationId,
		)
		await writeSetupAudit(db, {
			actorId,
			locationId: existing.locationId,
			action: 'combo.delete',
			entityKind: 'combination',
			entityId: comboId,
		})
		return { deleted: true, id: comboId, floorPlanVersion, ...reflowResult }
	})
}

// ============================================================================
// Floor Elements & Atomic Floor Plan Save
// ============================================================================

export async function listFloorElementsForLocation(
	db: TenantDatabase,
	locationId: string,
	areaId?: string,
) {
	const areas = await db
		.select()
		.from(rsvAreas)
		.where(eq(rsvAreas.locationId, locationId))
		.all()
	const areaIds = areaId
		? areas.filter((a) => a.id === areaId).map((a) => a.id)
		: areas.map((a) => a.id)
	if (areaIds.length === 0) return []
	const rows = await db
		.select()
		.from(rsvFloorElements)
		.where(inArray(rsvFloorElements.areaId, areaIds))
		.all()
	return rows.map(serializeElement)
}

export async function createFloorElementForLocation(
	db: TenantDatabase,
	input: {
		actorId: string | null
		locationId: string
		areaId: string
		kind: 'wall' | 'bar' | 'door' | 'window' | 'label' | 'plant' | 'zone'
		label?: string | null
		x?: number
		y?: number
		w?: number
		h?: number
		width?: number
		height?: number
		rotation?: number
	},
) {
	return withSetupWrite(db, async (db) => {
		const area = await db
			.select()
			.from(rsvAreas)
			.where(
				and(
					eq(rsvAreas.id, input.areaId),
					eq(rsvAreas.locationId, input.locationId),
				),
			)
			.get()
		if (!area)
			throw badRequest('invalid_area', 'Area does not exist in location')

		const id = createId('el')
		await db.insert(rsvFloorElements).values({
			id,
			areaId: input.areaId,
			kind: input.kind,
			label: input.label ?? null,
			x: input.x ?? 0,
			y: input.y ?? 0,
			w: input.w ?? input.width ?? 60,
			h: input.h ?? input.height ?? 20,
			rotation: input.rotation ?? 0,
		})
		const floorPlanVersion = await bumpFloorPlanVersion(
			db,
			input.locationId,
			input.actorId,
		)
		const row = await db
			.select()
			.from(rsvFloorElements)
			.where(eq(rsvFloorElements.id, id))
			.get()
		return { element: serializeElement(row!), floorPlanVersion }
	})
}

export async function deleteFloorElementForLocation(
	db: TenantDatabase,
	elementId: string,
	actorId: string | null,
	locationId?: string,
) {
	return withSetupWrite(db, async (db) => {
		const existing = await db
			.select()
			.from(rsvFloorElements)
			.where(eq(rsvFloorElements.id, elementId))
			.get()
		if (!existing) throw notFound('Floor element not found')

		const area = await db
			.select()
			.from(rsvAreas)
			.where(eq(rsvAreas.id, existing.areaId))
			.get()
		if (!area || (locationId && area.locationId !== locationId)) {
			throw notFound('Floor element not found in location')
		}

		await db.delete(rsvFloorElements).where(eq(rsvFloorElements.id, elementId))
		const floorPlanVersion = await bumpFloorPlanVersion(
			db,
			area.locationId,
			actorId,
		)
		return { deleted: true, id: elementId, floorPlanVersion }
	})
}

export async function saveFloorPlan(
	db: TenantDatabase,
	orgId: string,
	locationId: string,
	payload: {
		expectedFloorPlanVersion?: number
		expectedVersion?: number
		areas?: Array<{
			id?: string
			name: string
			nameI18n?: Record<string, string>
			onlineBookable?: boolean
			guestSelectable?: boolean
			canvasW?: number
			canvasH?: number
			sort?: number
			sortOrder?: number
			active?: boolean
			archived?: boolean
			archivedAt?: number | null
		}>
		tables?: Array<{
			id?: string
			areaId: string
			label: string
			shape?: 'round' | 'square' | 'rect' | 'booth' | 'bar'
			minCovers?: number
			maxCovers?: number
			minSeats?: number
			maxSeats?: number
			onlineBookable?: boolean
			onlineEnabled?: boolean
			combinable?: boolean
			priority?: number
			resetBufferMin?: number | null
			x?: number
			y?: number
			w?: number
			h?: number
			width?: number
			height?: number
			rotation?: number
			active?: boolean
			archived?: boolean
			archivedAt?: number | null
		}>
		combos?: Array<{
			id?: string
			label?: string
			name?: string
			minCovers?: number
			maxCovers?: number
			minSeats?: number
			maxSeats?: number
			priority?: number
			onlineBookable?: boolean
			active?: boolean
			archived?: boolean
			archivedAt?: number | null
			tableIds: string[]
		}>
		combinations?: Array<{
			id?: string
			label?: string
			name?: string
			minCovers?: number
			maxCovers?: number
			minSeats?: number
			maxSeats?: number
			priority?: number
			onlineBookable?: boolean
			active?: boolean
			archived?: boolean
			archivedAt?: number | null
			tableIds: string[]
		}>
		elements?: Array<{
			id?: string
			areaId: string
			kind: 'wall' | 'bar' | 'door' | 'window' | 'label' | 'plant' | 'zone'
			label?: string | null
			x?: number
			y?: number
			w?: number
			h?: number
			width?: number
			height?: number
			rotation?: number
		}>
		floorElements?: Array<{
			id?: string
			areaId: string
			kind: 'wall' | 'bar' | 'door' | 'window' | 'label' | 'plant' | 'zone'
			label?: string | null
			x?: number
			y?: number
			w?: number
			h?: number
			width?: number
			height?: number
			rotation?: number
		}>
		archiveMissingTables?: boolean
		floorPlanVersion?: number
	},
	actorId: string | null,
) {
	return withSetupWrite(
		db,
		async (db) => {
			const settings = await ensureSettingsRowForLocation(db, locationId)
			const expectedFpVersion =
				payload.expectedFloorPlanVersion ??
				payload.expectedVersion ??
				payload.floorPlanVersion
			if (
				expectedFpVersion !== undefined &&
				expectedFpVersion !== settings.floorPlanVersion
			) {
				throw conflict(
					'stale_version',
					'Floor plan has been modified by another session; reload before saving.',
					{
						floorPlanVersion: settings.floorPlanVersion,
						currentFloorPlanVersion: settings.floorPlanVersion,
					},
				)
			}

			const now = Date.now()
			const invalidatedTableIds: string[] = []

			// Validate duplicate labels among active tables in payload
			if (payload.tables) {
				const seenLabels = new Set<string>()
				for (const t of payload.tables) {
					const isArchived =
						t.archived === true ||
						t.active === false ||
						(t.archivedAt !== undefined && t.archivedAt !== null)
					if (isArchived) continue
					const key = t.label.trim().toLowerCase()
					if (seenLabels.has(key)) {
						throw conflict(
							'duplicate_table_label',
							`Duplicate active table label "${t.label}" in floor plan save`,
						)
					}
					seenLabels.add(key)
				}
			}

			// Upsert areas if provided
			if (payload.areas) {
				for (const a of payload.areas) {
					const id = a.id ?? createId('area')
					const existing = await db
						.select()
						.from(rsvAreas)
						.where(
							and(eq(rsvAreas.id, id), eq(rsvAreas.locationId, locationId)),
						)
						.get()
					const isArchived =
						a.archived === true ||
						a.active === false ||
						(a.archivedAt !== undefined && a.archivedAt !== null)
					if (existing) {
						await db
							.update(rsvAreas)
							.set({
								name: a.name.trim(),
								...(a.nameI18n !== undefined ? { nameI18n: a.nameI18n } : {}),
								...(a.onlineBookable !== undefined
									? { onlineBookable: a.onlineBookable }
									: {}),
								...(a.guestSelectable !== undefined
									? { guestSelectable: a.guestSelectable }
									: {}),
								...(a.canvasW !== undefined ? { canvasW: a.canvasW } : {}),
								...(a.canvasH !== undefined ? { canvasH: a.canvasH } : {}),
								sort: a.sort ?? a.sortOrder ?? existing.sort,
								archivedAt: isArchived ? (existing.archivedAt ?? now) : null,
								updatedAt: now,
								version: existing.version + 1,
							})
							.where(eq(rsvAreas.id, id))
					} else {
						await db.insert(rsvAreas).values({
							id,
							locationId,
							name: a.name.trim(),
							nameI18n: a.nameI18n ?? { en: a.name.trim() },
							sort: a.sort ?? a.sortOrder ?? 0,
							onlineBookable: a.onlineBookable ?? true,
							guestSelectable: a.guestSelectable ?? true,
							canvasW: a.canvasW ?? 1200,
							canvasH: a.canvasH ?? 800,
							archivedAt: isArchived ? now : null,
							createdAt: now,
							updatedAt: now,
							version: 1,
						})
					}
				}
			}

			// Upsert tables if provided
			if (payload.tables) {
				const existingTables = await db
					.select()
					.from(rsvTables)
					.where(eq(rsvTables.locationId, locationId))
					.all()
				const existingById = new Map(existingTables.map((t) => [t.id, t]))
				const seenIds = new Set<string>()

				for (const t of payload.tables) {
					const id = t.id ?? createId('tbl')
					seenIds.add(id)
					const existing = existingById.get(id)
					const minCovers =
						t.minCovers ?? t.minSeats ?? existing?.minCovers ?? 1
					const maxCovers =
						t.maxCovers ?? t.maxSeats ?? existing?.maxCovers ?? 2
					if (minCovers < 1 || maxCovers < minCovers || maxCovers > 99) {
						throw badRequest(
							'invalid_capacity',
							'minCovers must be >= 1 and <= maxCovers (<= 99)',
						)
					}
					const isArchived =
						t.archived === true ||
						t.active === false ||
						(t.archivedAt !== undefined && t.archivedAt !== null)
					const nextArchivedAt = isArchived
						? (existing?.archivedAt ?? now)
						: null

					if (existing) {
						if (existing.archivedAt === null && nextArchivedAt !== null) {
							invalidatedTableIds.push(id)
						}
						await db
							.update(rsvTables)
							.set({
								areaId: t.areaId,
								label: t.label.trim(),
								shape: t.shape ?? existing.shape,
								minCovers,
								maxCovers,
								onlineBookable:
									t.onlineBookable ??
									t.onlineEnabled ??
									existing.onlineBookable,
								combinable: t.combinable ?? existing.combinable,
								priority: t.priority ?? existing.priority,
								resetBufferMin:
									t.resetBufferMin !== undefined
										? (t.resetBufferMin ?? 0)
										: existing.resetBufferMin,
								x: t.x ?? existing.x,
								y: t.y ?? existing.y,
								w: t.w ?? t.width ?? existing.w,
								h: t.h ?? t.height ?? existing.h,
								rotation: t.rotation ?? existing.rotation,
								archivedAt: nextArchivedAt,
								updatedAt: now,
							})
							.where(eq(rsvTables.id, id))
					} else {
						await db.insert(rsvTables).values({
							id,
							locationId,
							areaId: t.areaId,
							label: t.label.trim(),
							shape: t.shape ?? 'square',
							minCovers,
							maxCovers,
							onlineBookable: t.onlineBookable ?? t.onlineEnabled ?? true,
							combinable: t.combinable ?? false,
							priority: t.priority ?? 0,
							resetBufferMin: t.resetBufferMin ?? 0,
							x: t.x ?? 0,
							y: t.y ?? 0,
							w: t.w ?? t.width ?? 60,
							h: t.h ?? t.height ?? 60,
							rotation: t.rotation ?? 0,
							archivedAt: nextArchivedAt,
							createdAt: now,
							updatedAt: now,
						})
					}
				}

				if (payload.archiveMissingTables) {
					for (const existing of existingTables) {
						if (existing.archivedAt === null && !seenIds.has(existing.id)) {
							await db
								.update(rsvTables)
								.set({ archivedAt: now, updatedAt: now })
								.where(eq(rsvTables.id, existing.id))
							invalidatedTableIds.push(existing.id)
						}
					}
				}
			}

			// Upsert combinations if provided
			const combosInput = payload.combos ?? payload.combinations
			if (combosInput) {
				for (const c of combosInput) {
					const id = c.id ?? createId('cmb')
					const existing = await db
						.select()
						.from(rsvTableCombos)
						.where(
							and(
								eq(rsvTableCombos.id, id),
								eq(rsvTableCombos.locationId, locationId),
							),
						)
						.get()
					const minCovers =
						c.minCovers ?? c.minSeats ?? existing?.minCovers ?? 2
					const maxCovers =
						c.maxCovers ?? c.maxSeats ?? existing?.maxCovers ?? 6
					const isArchived =
						c.archived === true ||
						c.active === false ||
						(c.archivedAt !== undefined && c.archivedAt !== null)
					const nextArchivedAt = isArchived
						? (existing?.archivedAt ?? now)
						: null
					const label = (c.label ?? c.name ?? existing?.label ?? 'Combo').trim()
					const uniqueTableIds = [...new Set(c.tableIds)].sort()

					if (!isArchived) {
						if (uniqueTableIds.length < 2) {
							throw badRequest(
								'invalid_combination',
								'Combination must contain at least 2 distinct tables',
							)
						}
						const memberTables = await db
							.select()
							.from(rsvTables)
							.where(
								and(
									eq(rsvTables.locationId, locationId),
									inArray(rsvTables.id, uniqueTableIds),
								),
							)
							.all()
						if (memberTables.length !== uniqueTableIds.length) {
							throw badRequest(
								'invalid_combination_tables',
								'All combination tables must belong to this location',
							)
						}
						for (const tbl of memberTables) {
							if (tbl.archivedAt !== null || !tbl.combinable) {
								throw badRequest(
									'table_not_combinable',
									`Table "${tbl.label}" is not combinable or is archived`,
								)
							}
						}
					}

					if (existing) {
						await db
							.update(rsvTableCombos)
							.set({
								label,
								minCovers,
								maxCovers,
								priority: c.priority ?? existing.priority,
								onlineBookable: c.onlineBookable ?? existing.onlineBookable,
								archivedAt: nextArchivedAt,
								updatedAt: now,
							})
							.where(eq(rsvTableCombos.id, id))
						await db
							.delete(rsvTableComboMembers)
							.where(eq(rsvTableComboMembers.comboId, id))
					} else {
						await db.insert(rsvTableCombos).values({
							id,
							locationId,
							label,
							minCovers,
							maxCovers,
							priority: c.priority ?? 0,
							onlineBookable: c.onlineBookable ?? true,
							archivedAt: nextArchivedAt,
							createdAt: now,
							updatedAt: now,
						})
					}
					for (const tid of uniqueTableIds) {
						await db.insert(rsvTableComboMembers).values({
							comboId: id,
							tableId: tid,
						})
					}
				}

				const activeCombos = await db
					.select()
					.from(rsvTableCombos)
					.where(
						and(
							eq(rsvTableCombos.locationId, locationId),
							isNull(rsvTableCombos.archivedAt),
						),
					)
					.all()
				if (activeCombos.length > 1) {
					const activeComboIds = activeCombos.map((c) => c.id)
					const allMembers = await db
						.select()
						.from(rsvTableComboMembers)
						.where(inArray(rsvTableComboMembers.comboId, activeComboIds))
						.all()
					const seenCanonicalKeys = new Set<string>()
					for (const ac of activeCombos) {
						const key = allMembers
							.filter((m) => m.comboId === ac.id)
							.map((m) => m.tableId)
							.sort()
							.join(',')
						if (seenCanonicalKeys.has(key)) {
							throw conflict(
								'duplicate_combination',
								'An active combination with the same member tables already exists',
							)
						}
						seenCanonicalKeys.add(key)
					}
				}
			}

			// Upsert floor elements if provided
			const elementsInput = payload.elements ?? payload.floorElements
			if (elementsInput) {
				const locAreas = await db
					.select()
					.from(rsvAreas)
					.where(eq(rsvAreas.locationId, locationId))
					.all()
				const locAreaIds = locAreas.map((a) => a.id)
				if (locAreaIds.length > 0) {
					await db
						.delete(rsvFloorElements)
						.where(inArray(rsvFloorElements.areaId, locAreaIds))
				}
				for (const el of elementsInput) {
					const id = el.id ?? createId('el')
					await db.insert(rsvFloorElements).values({
						id,
						areaId: el.areaId,
						kind: el.kind,
						label: el.label ?? null,
						x: el.x ?? 0,
						y: el.y ?? 0,
						w: el.w ?? el.width ?? 60,
						h: el.h ?? el.height ?? 20,
						rotation: el.rotation ?? 0,
					})
				}
			}

			const floorPlanVersion = await bumpFloorPlanVersion(
				db,
				locationId,
				actorId,
			)
			const reflowResult = await reflowFutureBookingsForLocation(
				db,
				locationId,
				{
					invalidatedTableIds,
				},
			)

			await writeSetupAudit(db, {
				actorId,
				locationId,
				action: 'floor_plan.save',
				entityKind: 'floor_plan',
				entityId: locationId,
				diff: { floorPlanVersion },
			})

			const floorPlan = await getFloorPlan(db, orgId, locationId)
			return {
				...floorPlan,
				floorPlanVersion,
				floor_plan_version: floorPlanVersion,
				...reflowResult,
			}
		},
		orgId,
	)
}

// ============================================================================
// Services
// ============================================================================

export async function listServicesForLocation(
	db: TenantDatabase,
	locationId: string,
	includeArchived = false,
) {
	const rows = await db
		.select()
		.from(rsvServices)
		.where(
			includeArchived
				? eq(rsvServices.locationId, locationId)
				: and(
						eq(rsvServices.locationId, locationId),
						isNull(rsvServices.archivedAt),
					),
		)
		.orderBy(asc(rsvServices.sort), asc(rsvServices.firstSeatingMin))
		.all()
	return rows.map(serializeService)
}

export async function createServiceForLocation(
	db: TenantDatabase,
	input: {
		actorId: string | null
		locationId: string
		name: string
		nameI18n?: Record<string, string>
		daysMask?: number
		daysOfWeek?: number[]
		firstSeatingMin?: number
		startMin?: number
		lastSeatingMin: number
		endMin: number
		intervalMin?: number | null
		effectiveFrom?: string | null
		effectiveTo?: string | null
		priority?: number
		specialDayId?: string | null
		onlineEnabled?: boolean
		onlineBookable?: boolean
		onlineFromMin?: number | null
		onlineToMin?: number | null
		maxParty?: number | null
		onlinePartyMax?: number | null
		onlineCapPerInterval?: number | null
		concurrentCoversCap?: number | null
		policyId?: string | null
		sectionLayoutId?: string | null
		allowOverrunPastEnd?: boolean
		colorToken?: string
		color?: string
		sort?: number
		sortOrder?: number
	},
) {
	return withSetupWrite(db, async (db) => {
		await ensureSettingsRowForLocation(db, input.locationId)
		const firstSeatingMin = input.firstSeatingMin ?? input.startMin ?? 0
		const lastSeatingMin = input.lastSeatingMin
		const endMin = input.endMin

		if (firstSeatingMin > lastSeatingMin || lastSeatingMin > endMin) {
			throw badRequest(
				'invalid_seating_order',
				'firstSeatingMin <= lastSeatingMin <= endMin is required',
			)
		}
		if (endMin - firstSeatingMin > 1440) {
			throw badRequest(
				'invalid_service_span',
				'Service span (endMin - firstSeatingMin) cannot exceed 1440 minutes',
			)
		}

		let daysMask = input.daysMask ?? 127
		if (input.daysMask === undefined && input.daysOfWeek) {
			daysMask = 0
			for (const d of input.daysOfWeek) {
				daysMask |= 1 << d
			}
		}

		const id = createId('srv')
		await db.insert(rsvServices).values({
			id,
			locationId: input.locationId,
			name: input.name.trim(),
			nameI18n: input.nameI18n ?? { en: input.name.trim() },
			daysMask,
			firstSeatingMin,
			lastSeatingMin,
			endMin,
			intervalMin: input.intervalMin ?? null,
			effectiveFrom: input.effectiveFrom ?? null,
			effectiveTo: input.effectiveTo ?? null,
			priority: input.priority ?? 0,
			specialDayId: input.specialDayId ?? null,
			onlineEnabled: input.onlineEnabled ?? input.onlineBookable ?? true,
			onlineFromMin: input.onlineFromMin ?? null,
			onlineToMin: input.onlineToMin ?? null,
			maxParty: input.maxParty ?? null,
			onlinePartyMax: input.onlinePartyMax ?? null,
			onlineCapPerInterval: input.onlineCapPerInterval ?? null,
			concurrentCoversCap: input.concurrentCoversCap ?? null,
			policyId: input.policyId ?? null,
			sectionLayoutId: input.sectionLayoutId ?? null,
			allowOverrunPastEnd: input.allowOverrunPastEnd ?? true,
			colorToken: input.colorToken ?? input.color ?? 'neutral',
			sort: input.sort ?? input.sortOrder ?? 0,
			archivedAt: null,
			version: 1,
		})

		await writeSetupAudit(db, {
			actorId: input.actorId,
			locationId: input.locationId,
			action: 'service.create',
			entityKind: 'service',
			entityId: id,
			diff: {
				name: input.name.trim(),
				firstSeatingMin,
				lastSeatingMin,
				endMin,
			},
		})

		const row = await db
			.select()
			.from(rsvServices)
			.where(eq(rsvServices.id, id))
			.get()
		return serializeService(row!)
	})
}

export async function updateServiceForLocation(
	db: TenantDatabase,
	serviceId: string,
	patch: {
		actorId: string | null
		locationId?: string
		name?: string
		nameI18n?: Record<string, string>
		daysMask?: number
		daysOfWeek?: number[]
		firstSeatingMin?: number
		startMin?: number
		lastSeatingMin?: number
		endMin?: number
		intervalMin?: number | null
		effectiveFrom?: string | null
		effectiveTo?: string | null
		priority?: number
		onlineEnabled?: boolean
		onlineBookable?: boolean
		onlineFromMin?: number | null
		onlineToMin?: number | null
		maxParty?: number | null
		onlinePartyMax?: number | null
		onlineCapPerInterval?: number | null
		concurrentCoversCap?: number | null
		policyId?: string | null
		sectionLayoutId?: string | null
		allowOverrunPastEnd?: boolean
		colorToken?: string
		color?: string
		sort?: number
		sortOrder?: number
		active?: boolean
		archived?: boolean
	},
) {
	return withSetupWrite(db, async (db) => {
		const existing = await db
			.select()
			.from(rsvServices)
			.where(eq(rsvServices.id, serviceId))
			.get()
		if (!existing) throw notFound('Service not found')
		if (patch.locationId && patch.locationId !== existing.locationId) {
			throw notFound('Service not found in location')
		}

		const firstSeatingMin =
			patch.firstSeatingMin ?? patch.startMin ?? existing.firstSeatingMin
		const lastSeatingMin = patch.lastSeatingMin ?? existing.lastSeatingMin
		const endMin = patch.endMin ?? existing.endMin
		if (firstSeatingMin > lastSeatingMin || lastSeatingMin > endMin) {
			throw badRequest(
				'invalid_seating_order',
				'firstSeatingMin <= lastSeatingMin <= endMin is required',
			)
		}
		if (endMin - firstSeatingMin > 1440) {
			throw badRequest(
				'invalid_service_span',
				'Service span (endMin - firstSeatingMin) cannot exceed 1440 minutes',
			)
		}

		let daysMask = patch.daysMask ?? existing.daysMask
		if (patch.daysMask === undefined && patch.daysOfWeek) {
			daysMask = 0
			for (const d of inputDaysOfWeek(patch.daysOfWeek)) {
				daysMask |= 1 << d
			}
		}

		const now = Date.now()
		const shouldArchive =
			patch.archived === true ||
			patch.active === false ||
			(patch.archived === undefined &&
				patch.active === undefined &&
				existing.archivedAt !== null)
		const nextArchivedAt = shouldArchive ? (existing.archivedAt ?? now) : null

		await db
			.update(rsvServices)
			.set({
				...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
				...(patch.nameI18n !== undefined ? { nameI18n: patch.nameI18n } : {}),
				daysMask,
				firstSeatingMin,
				lastSeatingMin,
				endMin,
				...(patch.intervalMin !== undefined
					? { intervalMin: patch.intervalMin }
					: {}),
				...(patch.effectiveFrom !== undefined
					? { effectiveFrom: patch.effectiveFrom }
					: {}),
				...(patch.effectiveTo !== undefined
					? { effectiveTo: patch.effectiveTo }
					: {}),
				...(patch.priority !== undefined ? { priority: patch.priority } : {}),
				...(patch.onlineEnabled !== undefined ||
				patch.onlineBookable !== undefined
					? {
							onlineEnabled:
								patch.onlineEnabled ??
								patch.onlineBookable ??
								existing.onlineEnabled,
						}
					: {}),
				...(patch.onlineFromMin !== undefined
					? { onlineFromMin: patch.onlineFromMin }
					: {}),
				...(patch.onlineToMin !== undefined
					? { onlineToMin: patch.onlineToMin }
					: {}),
				...(patch.maxParty !== undefined ? { maxParty: patch.maxParty } : {}),
				...(patch.onlinePartyMax !== undefined
					? { onlinePartyMax: patch.onlinePartyMax }
					: {}),
				...(patch.onlineCapPerInterval !== undefined
					? { onlineCapPerInterval: patch.onlineCapPerInterval }
					: {}),
				...(patch.concurrentCoversCap !== undefined
					? { concurrentCoversCap: patch.concurrentCoversCap }
					: {}),
				...(patch.policyId !== undefined ? { policyId: patch.policyId } : {}),
				...(patch.sectionLayoutId !== undefined
					? { sectionLayoutId: patch.sectionLayoutId }
					: {}),
				...(patch.allowOverrunPastEnd !== undefined
					? { allowOverrunPastEnd: patch.allowOverrunPastEnd }
					: {}),
				...(patch.colorToken !== undefined || patch.color !== undefined
					? {
							colorToken:
								patch.colorToken ?? patch.color ?? existing.colorToken,
						}
					: {}),
				...(patch.sort !== undefined || patch.sortOrder !== undefined
					? { sort: patch.sort ?? patch.sortOrder ?? existing.sort }
					: {}),
				archivedAt: nextArchivedAt,
				version: existing.version + 1,
			})
			.where(eq(rsvServices.id, serviceId))

		const reflowResult = await reflowFutureBookingsForLocation(
			db,
			existing.locationId,
		)
		const updated = await db
			.select()
			.from(rsvServices)
			.where(eq(rsvServices.id, serviceId))
			.get()
		return { service: serializeService(updated!), ...reflowResult }
	})
}

function inputDaysOfWeek(days: number[]): number[] {
	return days
}

export async function archiveServiceForLocation(
	db: TenantDatabase,
	serviceId: string,
	actorId: string | null,
	locationId?: string,
) {
	return withSetupWrite(db, async (db) => {
		const existing = await db
			.select()
			.from(rsvServices)
			.where(eq(rsvServices.id, serviceId))
			.get()
		if (!existing) throw notFound('Service not found')
		if (locationId && existing.locationId !== locationId) {
			throw notFound('Service not found in location')
		}

		const now = Date.now()
		await db
			.update(rsvServices)
			.set({
				archivedAt: now,
				version: existing.version + 1,
			})
			.where(eq(rsvServices.id, serviceId))

		const reflowResult = await reflowFutureBookingsForLocation(
			db,
			existing.locationId,
		)
		await writeSetupAudit(db, {
			actorId,
			locationId: existing.locationId,
			action: 'service.archive',
			entityKind: 'service',
			entityId: serviceId,
		})
		const updated = await db
			.select()
			.from(rsvServices)
			.where(eq(rsvServices.id, serviceId))
			.get()
		return { service: serializeService(updated!), ...reflowResult }
	})
}

// ============================================================================
// Turn Times
// ============================================================================

export async function listTurnTimesForLocation(
	db: TenantDatabase,
	locationId: string,
	serviceId?: string,
) {
	const conditions = [eq(rsvTurnTimes.locationId, locationId)]
	if (serviceId) conditions.push(eq(rsvTurnTimes.serviceId, serviceId))
	const rows = await db
		.select()
		.from(rsvTurnTimes)
		.where(and(...conditions))
		.orderBy(asc(rsvTurnTimes.partyMin))
		.all()
	return rows.map(serializeTurnTime)
}

export async function createTurnTimeForLocation(
	db: TenantDatabase,
	input: {
		actorId: string | null
		locationId: string
		serviceId?: string | null
		partyMin?: number
		partyMax?: number
		minParty?: number
		maxParty?: number
		minutes?: number
		turnMin?: number
		durationMin?: number
		daysMask?: number | null
	},
) {
	return withSetupWrite(db, async (db) => {
		const partyMin = input.partyMin ?? input.minParty ?? 1
		const partyMax = input.partyMax ?? input.maxParty ?? 2
		const minutes = input.minutes ?? input.turnMin ?? input.durationMin ?? 90
		const targetServiceId = input.serviceId ?? null
		const daysMask = input.daysMask ?? null

		if (partyMin < 1 || partyMax < partyMin || partyMax > 99) {
			throw badRequest(
				'invalid_party_range',
				'partyMin must be >= 1 and <= partyMax (<= 99)',
			)
		}
		if (minutes < 15 || minutes > 480) {
			throw badRequest(
				'invalid_turn_minutes',
				'Turn time minutes must be between 15 and 480',
			)
		}

		const existingBuckets = await db
			.select()
			.from(rsvTurnTimes)
			.where(
				and(
					eq(rsvTurnTimes.locationId, input.locationId),
					targetServiceId === null
						? isNull(rsvTurnTimes.serviceId)
						: eq(rsvTurnTimes.serviceId, targetServiceId),
				),
			)
			.all()
		for (const other of existingBuckets) {
			const partyOverlap =
				partyMin <= other.partyMax && partyMax >= other.partyMin
			const maskOverlap = ((daysMask ?? 127) & (other.daysMask ?? 127)) !== 0
			if (partyOverlap && maskOverlap) {
				throw badRequest(
					'overlapping_turn_time_bucket',
					`Turn time party range [${partyMin}, ${partyMax}] overlaps existing bucket [${other.partyMin}, ${other.partyMax}]`,
				)
			}
		}

		const id = createId('tt')
		await db.insert(rsvTurnTimes).values({
			id,
			locationId: input.locationId,
			serviceId: targetServiceId,
			partyMin,
			partyMax,
			minutes,
			daysMask,
		})
		const row = await db
			.select()
			.from(rsvTurnTimes)
			.where(eq(rsvTurnTimes.id, id))
			.get()
		return serializeTurnTime(row!)
	})
}

export async function updateTurnTimeForLocation(
	db: TenantDatabase,
	turnTimeId: string,
	patch: {
		actorId: string | null
		locationId?: string
		serviceId?: string | null
		partyMin?: number
		partyMax?: number
		minParty?: number
		maxParty?: number
		minutes?: number
		turnMin?: number
		durationMin?: number
		daysMask?: number | null
	},
) {
	return withSetupWrite(db, async (db) => {
		const existing = await db
			.select()
			.from(rsvTurnTimes)
			.where(eq(rsvTurnTimes.id, turnTimeId))
			.get()
		if (!existing) throw notFound('Turn time bucket not found')
		if (patch.locationId && patch.locationId !== existing.locationId) {
			throw notFound('Turn time bucket not found in location')
		}

		const partyMin = patch.partyMin ?? patch.minParty ?? existing.partyMin
		const partyMax = patch.partyMax ?? patch.maxParty ?? existing.partyMax
		const minutes =
			patch.minutes ?? patch.turnMin ?? patch.durationMin ?? existing.minutes
		const targetServiceId =
			patch.serviceId !== undefined ? patch.serviceId : existing.serviceId
		const daysMask =
			patch.daysMask !== undefined ? patch.daysMask : existing.daysMask

		if (partyMin < 1 || partyMax < partyMin || partyMax > 99) {
			throw badRequest(
				'invalid_party_range',
				'partyMin must be >= 1 and <= partyMax (<= 99)',
			)
		}
		if (minutes < 15 || minutes > 480) {
			throw badRequest(
				'invalid_turn_minutes',
				'Turn time minutes must be between 15 and 480',
			)
		}

		const existingBuckets = await db
			.select()
			.from(rsvTurnTimes)
			.where(
				and(
					eq(rsvTurnTimes.locationId, existing.locationId),
					targetServiceId === null
						? isNull(rsvTurnTimes.serviceId)
						: eq(rsvTurnTimes.serviceId, targetServiceId),
				),
			)
			.all()
		for (const other of existingBuckets) {
			if (other.id === turnTimeId) continue
			const partyOverlap =
				partyMin <= other.partyMax && partyMax >= other.partyMin
			const maskOverlap = ((daysMask ?? 127) & (other.daysMask ?? 127)) !== 0
			if (partyOverlap && maskOverlap) {
				throw badRequest(
					'overlapping_turn_time_bucket',
					`Turn time party range [${partyMin}, ${partyMax}] overlaps existing bucket [${other.partyMin}, ${other.partyMax}]`,
				)
			}
		}

		await db
			.update(rsvTurnTimes)
			.set({
				...(patch.serviceId !== undefined
					? { serviceId: patch.serviceId }
					: {}),
				partyMin,
				partyMax,
				minutes,
				...(patch.daysMask !== undefined ? { daysMask: patch.daysMask } : {}),
			})
			.where(eq(rsvTurnTimes.id, turnTimeId))
		const updated = await db
			.select()
			.from(rsvTurnTimes)
			.where(eq(rsvTurnTimes.id, turnTimeId))
			.get()
		return serializeTurnTime(updated!)
	})
}

export async function deleteTurnTimeForLocation(
	db: TenantDatabase,
	turnTimeId: string,
	ignoredActorId: string | null,
	locationId?: string,
) {
	return withSetupWrite(db, async (db) => {
		const existing = await db
			.select()
			.from(rsvTurnTimes)
			.where(eq(rsvTurnTimes.id, turnTimeId))
			.get()
		if (!existing) throw notFound('Turn time bucket not found')
		if (locationId && existing.locationId !== locationId) {
			throw notFound('Turn time bucket not found in location')
		}
		await db.delete(rsvTurnTimes).where(eq(rsvTurnTimes.id, turnTimeId))
		return { deleted: true, id: turnTimeId }
	})
}

// ============================================================================
// Pacing Rules
// ============================================================================

export async function listPacingRulesForLocation(
	db: TenantDatabase,
	locationId: string,
	serviceId?: string,
) {
	const services = await db
		.select()
		.from(rsvServices)
		.where(eq(rsvServices.locationId, locationId))
		.all()
	const serviceIds = serviceId
		? services.filter((s) => s.id === serviceId).map((s) => s.id)
		: services.map((s) => s.id)
	if (serviceIds.length === 0) return []
	const rows = await db
		.select()
		.from(rsvPacingRules)
		.where(inArray(rsvPacingRules.serviceId, serviceIds))
		.all()
	return rows.map(serializePacingRule)
}

export async function createPacingRuleForLocation(
	outerDb: TenantDatabase,
	input: {
		actorId: string | null
		locationId?: string
		serviceId: string
		fromMin?: number | null
		toMin?: number | null
		windowStartMin?: number | null
		windowEndMin?: number | null
		bucketMin?: number
		maxCovers?: number | null
		maxParties?: number | null
		maxCoversPerSlot?: number | null
		maxPartiesPerSlot?: number | null
		rollingMin?: number | null
		rollingMaxCovers?: number | null
		channel?: 'all' | 'online'
	},
) {
	return withSetupWrite(outerDb, async (db) => {
		const srv = await db
			.select()
			.from(rsvServices)
			.where(eq(rsvServices.id, input.serviceId))
			.get()
		if (!srv || (input.locationId && srv.locationId !== input.locationId)) {
			throw badRequest('invalid_service', 'Service does not exist in location')
		}

		const id = createId('pac')
		await db.insert(rsvPacingRules).values({
			id,
			serviceId: input.serviceId,
			fromMin: input.fromMin ?? input.windowStartMin ?? null,
			toMin: input.toMin ?? input.windowEndMin ?? null,
			bucketMin: input.bucketMin ?? 15,
			maxCovers: input.maxCovers ?? input.maxCoversPerSlot ?? null,
			maxParties: input.maxParties ?? input.maxPartiesPerSlot ?? null,
			rollingMin: input.rollingMin ?? null,
			rollingMaxCovers: input.rollingMaxCovers ?? null,
			channel: input.channel ?? 'all',
		})

		const reflowResult = await reflowFutureBookingsForLocation(
			db,
			srv.locationId,
		)
		const row = await db
			.select()
			.from(rsvPacingRules)
			.where(eq(rsvPacingRules.id, id))
			.get()
		const serialized = serializePacingRule(row!)
		return {
			pacingRule: serialized,
			rule: serialized,
			...reflowResult,
		}
	})
}

export async function updatePacingRuleForLocation(
	outerDb: TenantDatabase,
	ruleId: string,
	patch: {
		actorId: string | null
		locationId?: string
		fromMin?: number | null
		toMin?: number | null
		windowStartMin?: number | null
		windowEndMin?: number | null
		bucketMin?: number
		maxCovers?: number | null
		maxParties?: number | null
		maxCoversPerSlot?: number | null
		maxPartiesPerSlot?: number | null
		rollingMin?: number | null
		rollingMaxCovers?: number | null
		channel?: 'all' | 'online'
	},
) {
	return withSetupWrite(outerDb, async (db) => {
		const existing = await db
			.select()
			.from(rsvPacingRules)
			.where(eq(rsvPacingRules.id, ruleId))
			.get()
		if (!existing) throw notFound('Pacing rule not found')
		const srv = await db
			.select()
			.from(rsvServices)
			.where(eq(rsvServices.id, existing.serviceId))
			.get()
		if (!srv || (patch.locationId && srv.locationId !== patch.locationId)) {
			throw notFound('Pacing rule not found in location')
		}

		await db
			.update(rsvPacingRules)
			.set({
				...(patch.fromMin !== undefined || patch.windowStartMin !== undefined
					? { fromMin: patch.fromMin ?? patch.windowStartMin ?? null }
					: {}),
				...(patch.toMin !== undefined || patch.windowEndMin !== undefined
					? { toMin: patch.toMin ?? patch.windowEndMin ?? null }
					: {}),
				...(patch.bucketMin !== undefined
					? { bucketMin: patch.bucketMin }
					: {}),
				...(patch.maxCovers !== undefined ||
				patch.maxCoversPerSlot !== undefined
					? { maxCovers: patch.maxCovers ?? patch.maxCoversPerSlot ?? null }
					: {}),
				...(patch.maxParties !== undefined ||
				patch.maxPartiesPerSlot !== undefined
					? { maxParties: patch.maxParties ?? patch.maxPartiesPerSlot ?? null }
					: {}),
				...(patch.rollingMin !== undefined
					? { rollingMin: patch.rollingMin }
					: {}),
				...(patch.rollingMaxCovers !== undefined
					? { rollingMaxCovers: patch.rollingMaxCovers }
					: {}),
				...(patch.channel !== undefined ? { channel: patch.channel } : {}),
			})
			.where(eq(rsvPacingRules.id, ruleId))

		const reflowResult = await reflowFutureBookingsForLocation(
			db,
			srv.locationId,
		)
		const updated = await db
			.select()
			.from(rsvPacingRules)
			.where(eq(rsvPacingRules.id, ruleId))
			.get()
		const serialized = serializePacingRule(updated!)
		return {
			pacingRule: serialized,
			rule: serialized,
			...reflowResult,
		}
	})
}

export async function deletePacingRuleForLocation(
	outerDb: TenantDatabase,
	ruleId: string,
	ignoredActorId: string | null,
	locationId?: string,
) {
	return withSetupWrite(outerDb, async (db) => {
		const existing = await db
			.select()
			.from(rsvPacingRules)
			.where(eq(rsvPacingRules.id, ruleId))
			.get()
		if (!existing) throw notFound('Pacing rule not found')
		const srv = await db
			.select()
			.from(rsvServices)
			.where(eq(rsvServices.id, existing.serviceId))
			.get()
		if (!srv || (locationId && srv.locationId !== locationId)) {
			throw notFound('Pacing rule not found in location')
		}
		await db.delete(rsvPacingRules).where(eq(rsvPacingRules.id, ruleId))
		return { deleted: true, id: ruleId }
	})
}

// ============================================================================
// Service Availability Rules
// ============================================================================

export async function listServiceAvailabilityForLocation(
	db: TenantDatabase,
	locationId: string,
	serviceId?: string,
) {
	const services = await db
		.select()
		.from(rsvServices)
		.where(eq(rsvServices.locationId, locationId))
		.all()
	const serviceIds = serviceId
		? services.filter((s) => s.id === serviceId).map((s) => s.id)
		: services.map((s) => s.id)
	if (serviceIds.length === 0) return []
	const rows = await db
		.select()
		.from(rsvServiceAvailability)
		.where(inArray(rsvServiceAvailability.serviceId, serviceIds))
		.all()
	return rows.map(serializeServiceAvailability)
}

export async function upsertServiceAvailabilityForLocation(
	outerDb: TenantDatabase,
	input: {
		actorId: string | null
		locationId?: string
		serviceId: string
		areaId?: string | null
		tableId?: string | null
		comboId?: string | null
		combinationId?: string | null
		fromMin?: number | null
		toMin?: number | null
		mode: 'online' | 'staff_only' | 'walk_in_only' | 'unavailable'
	},
) {
	return withSetupWrite(outerDb, async (db) => {
		const srv = await db
			.select()
			.from(rsvServices)
			.where(eq(rsvServices.id, input.serviceId))
			.get()
		if (!srv || (input.locationId && srv.locationId !== input.locationId)) {
			throw badRequest('invalid_service', 'Service does not exist in location')
		}

		const areaId = input.areaId ?? null
		const tableId = input.tableId ?? null
		const comboId = input.comboId ?? input.combinationId ?? null
		const targetCount = (areaId ? 1 : 0) + (tableId ? 1 : 0) + (comboId ? 1 : 0)
		if (targetCount !== 1) {
			throw badRequest(
				'invalid_target',
				'Exactly one of areaId, tableId, or comboId is required',
			)
		}

		const existingRows = await db
			.select()
			.from(rsvServiceAvailability)
			.where(eq(rsvServiceAvailability.serviceId, input.serviceId))
			.all()
		const matching = existingRows.find(
			(r) =>
				r.areaId === areaId &&
				r.tableId === tableId &&
				r.comboId === comboId &&
				r.fromMin === (input.fromMin ?? null) &&
				r.toMin === (input.toMin ?? null),
		)

		if (matching) {
			await db
				.update(rsvServiceAvailability)
				.set({ mode: input.mode })
				.where(eq(rsvServiceAvailability.id, matching.id))
			const updated = await db
				.select()
				.from(rsvServiceAvailability)
				.where(eq(rsvServiceAvailability.id, matching.id))
				.get()
			return serializeServiceAvailability(updated!)
		}

		const id = createId('sa')
		await db.insert(rsvServiceAvailability).values({
			id,
			serviceId: input.serviceId,
			areaId,
			tableId,
			comboId,
			mode: input.mode,
			fromMin: input.fromMin ?? null,
			toMin: input.toMin ?? null,
		})
		const row = await db
			.select()
			.from(rsvServiceAvailability)
			.where(eq(rsvServiceAvailability.id, id))
			.get()
		return serializeServiceAvailability(row!)
	})
}

export async function deleteServiceAvailabilityForLocation(
	outerDb: TenantDatabase,
	id: string,
	ignoredActorId: string | null,
	locationId?: string,
) {
	return withSetupWrite(outerDb, async (db) => {
		const existing = await db
			.select()
			.from(rsvServiceAvailability)
			.where(eq(rsvServiceAvailability.id, id))
			.get()
		if (!existing) throw notFound('Service availability rule not found')
		const srv = await db
			.select()
			.from(rsvServices)
			.where(eq(rsvServices.id, existing.serviceId))
			.get()
		if (!srv || (locationId && srv.locationId !== locationId)) {
			throw notFound('Service availability rule not found in location')
		}
		await db
			.delete(rsvServiceAvailability)
			.where(eq(rsvServiceAvailability.id, id))
		return { deleted: true, id }
	})
}

// ============================================================================
// Special Days
// ============================================================================

function expandDateRange(fromDate: string, toDate: string): string[] {
	const dates: string[] = []
	let curr = fromDate
	let guard = 0
	while (curr <= toDate && guard < 370) {
		dates.push(curr)
		curr = addDays(curr, 1)
		guard++
	}
	return dates
}

export async function listSpecialDaysForLocation(
	db: TenantDatabase,
	locationId: string,
) {
	const rows = await db
		.select()
		.from(rsvSpecialDays)
		.where(eq(rsvSpecialDays.locationId, locationId))
		.orderBy(asc(rsvSpecialDays.fromDate))
		.all()
	if (rows.length === 0) return []

	const customServices = await db
		.select()
		.from(rsvServices)
		.where(
			and(
				eq(rsvServices.locationId, locationId),
				inArray(
					rsvServices.specialDayId,
					rows.map((r) => r.id),
				),
			),
		)
		.all()
	const servicesBySpecialDayId = new Map<
		string,
		Array<ReturnType<typeof serializeService>>
	>()
	for (const s of customServices) {
		if (!s.specialDayId) continue
		const list = servicesBySpecialDayId.get(s.specialDayId) ?? []
		list.push(serializeService(s))
		servicesBySpecialDayId.set(s.specialDayId, list)
	}

	return rows.map((row) => ({
		...serializeSpecialDay(row),
		services: servicesBySpecialDayId.get(row.id) ?? [],
	}))
}

export async function createSpecialDayForLocation(
	outerDb: TenantDatabase,
	input: {
		actorId: string | null
		locationId: string
		fromDate?: string
		toDate?: string
		businessDate?: string
		date?: string
		kind?: 'closed' | 'online_closed' | 'modified' | 'replace'
		type?: 'closed' | 'online_closed' | 'modified' | 'replace'
		serviceId?: string | null
		patch?: Record<string, unknown> | null
		name?: string | null
		label?: string | null
		publicNoteI18n?: Record<string, string> | null
		note?: string | null
		services?: Array<Record<string, unknown>> | null
		customServices?: Array<Record<string, unknown>> | null
	},
) {
	return withSetupWrite(outerDb, async (db) => {
		const singleDate = input.businessDate ?? input.date
		const fromDate = input.fromDate ?? singleDate
		const toDate = input.toDate ?? singleDate ?? fromDate
		if (!fromDate || !toDate || fromDate > toDate) {
			throw badRequest(
				'invalid_date_range',
				'fromDate and toDate (with fromDate <= toDate) are required',
			)
		}
		const kind = input.kind ?? input.type ?? 'closed'
		const id = createId('sd')
		const now = Date.now()

		await db.insert(rsvSpecialDays).values({
			id,
			locationId: input.locationId,
			fromDate,
			toDate,
			kind,
			serviceId: input.serviceId ?? null,
			patch: input.patch ?? null,
			name: input.name ?? input.label ?? null,
			publicNoteI18n:
				input.publicNoteI18n ?? (input.note ? { en: input.note } : null),
			createdBy: input.actorId,
			createdAt: now,
			version: 1,
		})

		const customServicesInput = input.services ?? input.customServices ?? []
		const createdServices: Array<ReturnType<typeof serializeService>> = []
		for (const s of customServicesInput) {
			const srv = await createServiceForLocation(db, {
				actorId: input.actorId,
				locationId: input.locationId,
				specialDayId: id,
				name: String(s.name ?? 'Special Service'),
				daysMask: typeof s.daysMask === 'number' ? s.daysMask : 127,
				firstSeatingMin: Number(
					s.firstSeatingMin ?? s.first_seating_min ?? s.startMin ?? 1020,
				),
				lastSeatingMin: Number(s.lastSeatingMin ?? s.last_seating_min ?? 1260),
				endMin: Number(s.endMin ?? s.end_min ?? 1380),
				intervalMin:
					typeof s.intervalMin === 'number'
						? s.intervalMin
						: typeof s.interval_min === 'number'
							? s.interval_min
							: null,
				onlineEnabled:
					typeof s.onlineEnabled === 'boolean'
						? s.onlineEnabled
						: typeof s.online_enabled === 'boolean'
							? s.online_enabled
							: true,
			})
			createdServices.push(srv)
		}

		const affectedDates = expandDateRange(fromDate, toDate)
		const reflowResult = await reflowFutureBookingsForLocation(
			db,
			input.locationId,
			{
				affectedDates,
			},
		)
		const row = await db
			.select()
			.from(rsvSpecialDays)
			.where(eq(rsvSpecialDays.id, id))
			.get()
		return {
			specialDay: {
				...serializeSpecialDay(row!),
				services: createdServices,
			},
			...reflowResult,
		}
	})
}

export async function updateSpecialDayForLocation(
	outerDb: TenantDatabase,
	specialDayId: string,
	patch: {
		actorId: string | null
		locationId?: string
		fromDate?: string
		toDate?: string
		businessDate?: string
		date?: string
		kind?: 'closed' | 'online_closed' | 'modified' | 'replace'
		type?: 'closed' | 'online_closed' | 'modified' | 'replace'
		serviceId?: string | null
		patch?: Record<string, unknown> | null
		name?: string | null
		label?: string | null
		publicNoteI18n?: Record<string, string> | null
	},
) {
	return withSetupWrite(outerDb, async (db) => {
		const existing = await db
			.select()
			.from(rsvSpecialDays)
			.where(eq(rsvSpecialDays.id, specialDayId))
			.get()
		if (!existing) throw notFound('Special day not found')
		if (patch.locationId && existing.locationId !== patch.locationId) {
			throw notFound('Special day not found in location')
		}

		const singleDate = patch.businessDate ?? patch.date
		const fromDate = patch.fromDate ?? singleDate ?? existing.fromDate
		const toDate = patch.toDate ?? singleDate ?? existing.toDate

		await db
			.update(rsvSpecialDays)
			.set({
				fromDate,
				toDate,
				...(patch.kind !== undefined || patch.type !== undefined
					? { kind: patch.kind ?? patch.type ?? existing.kind }
					: {}),
				...(patch.serviceId !== undefined
					? { serviceId: patch.serviceId }
					: {}),
				...(patch.patch !== undefined ? { patch: patch.patch } : {}),
				...(patch.name !== undefined || patch.label !== undefined
					? { name: patch.name ?? patch.label ?? null }
					: {}),
				...(patch.publicNoteI18n !== undefined
					? { publicNoteI18n: patch.publicNoteI18n }
					: {}),
				version: existing.version + 1,
			})
			.where(eq(rsvSpecialDays.id, specialDayId))

		const affectedDates = [
			...new Set([
				...expandDateRange(existing.fromDate, existing.toDate),
				...expandDateRange(fromDate, toDate),
			]),
		]
		const reflowResult = await reflowFutureBookingsForLocation(
			db,
			existing.locationId,
			{
				affectedDates,
			},
		)
		const updated = await db
			.select()
			.from(rsvSpecialDays)
			.where(eq(rsvSpecialDays.id, specialDayId))
			.get()
		return {
			specialDay: serializeSpecialDay(updated!),
			...reflowResult,
		}
	})
}

export async function deleteSpecialDayForLocation(
	outerDb: TenantDatabase,
	specialDayId: string,
	ignoredActorId: string | null,
	locationId?: string,
) {
	return withSetupWrite(outerDb, async (db) => {
		const existing = await db
			.select()
			.from(rsvSpecialDays)
			.where(eq(rsvSpecialDays.id, specialDayId))
			.get()
		if (!existing) throw notFound('Special day not found')
		if (locationId && existing.locationId !== locationId) {
			throw notFound('Special day not found in location')
		}
		await db.delete(rsvSpecialDays).where(eq(rsvSpecialDays.id, specialDayId))
		const affectedDates = expandDateRange(existing.fromDate, existing.toDate)
		await reflowFutureBookingsForLocation(db, existing.locationId, {
			affectedDates,
		})
		return { deleted: true, id: specialDayId }
	})
}

// ============================================================================
// Table & Area Blocks
// ============================================================================

export async function listBlocksForLocation(
	db: TenantDatabase,
	locationId: string,
	businessDate?: string,
) {
	const conditions = [eq(rsvBlocks.locationId, locationId)]
	if (businessDate) conditions.push(eq(rsvBlocks.businessDate, businessDate))
	const rows = await db
		.select()
		.from(rsvBlocks)
		.where(and(...conditions))
		.orderBy(asc(rsvBlocks.startAt))
		.all()
	return rows.map(serializeBlock)
}

export async function createBlockForLocation(
	outerDb: TenantDatabase,
	input: {
		actorId: string | null
		locationId: string
		areaId?: string | null
		tableId?: string | null
		businessDate: string
		startMin?: number
		endMin?: number
		startAt?: number
		endAt?: number
		reason?: string | null
		note?: string | null
	},
) {
	return withSetupWrite(outerDb, async (db) => {
		const hasArea = Boolean(input.areaId)
		const hasTable = Boolean(input.tableId)
		if (hasArea === hasTable) {
			throw badRequest(
				'invalid_block_target',
				'Block must target either a tableId or an areaId (not both)',
			)
		}

		const settings = await ensureSettingsRowForLocation(db, input.locationId)
		const tz = isValidTimeZone(settings.timeZone) ? settings.timeZone : 'UTC'

		let startAt = input.startAt
		let endAt = input.endAt
		if (startAt === undefined && input.startMin !== undefined) {
			startAt = localToInstant(input.businessDate, input.startMin, tz)
		}
		if (endAt === undefined && input.endMin !== undefined) {
			endAt = localToInstant(input.businessDate, input.endMin, tz)
		}
		if (startAt === undefined || endAt === undefined || endAt <= startAt) {
			throw badRequest('invalid_block_window', 'endAt must be > startAt')
		}

		let targetTableIds: string[] = []
		if (input.tableId) {
			const tbl = await db
				.select()
				.from(rsvTables)
				.where(
					and(
						eq(rsvTables.id, input.tableId),
						eq(rsvTables.locationId, input.locationId),
					),
				)
				.get()
			if (!tbl) throw badRequest('invalid_table', 'Table not found in location')
			targetTableIds = [tbl.id]
		} else if (input.areaId) {
			const area = await db
				.select()
				.from(rsvAreas)
				.where(
					and(
						eq(rsvAreas.id, input.areaId),
						eq(rsvAreas.locationId, input.locationId),
					),
				)
				.get()
			if (!area) throw badRequest('invalid_area', 'Area not found in location')
			const areaTables = await db
				.select()
				.from(rsvTables)
				.where(
					and(eq(rsvTables.areaId, input.areaId), isNull(rsvTables.archivedAt)),
				)
				.all()
			targetTableIds = areaTables.map((t) => t.id)
		}

		const now = Date.now()
		const id = createId('blk')
		await db.insert(rsvBlocks).values({
			id,
			locationId: input.locationId,
			areaId: input.areaId ?? null,
			tableId: input.tableId ?? null,
			businessDate: input.businessDate,
			startAt,
			endAt,
			reason: input.reason ?? null,
			note: input.note ?? null,
			createdBy: input.actorId,
			createdAt: now,
		})

		// Before inserting block occupancies into `rsv_table_occupancies`,
		// deactivate any overlapping SOFT reservation occupancies on `targetTableIds`
		// so `trg_rsv_occupancies_no_overlap_insert` allows the block occupancy and
		// `reflowFutureBookingsForLocation` can reassign those soft reservations.
		const preDeactivatedOriginalTables = new Map<string, string[]>()
		if (targetTableIds.length > 0) {
			const overlappingOccs = await db
				.select()
				.from(rsvTableOccupancies)
				.where(
					and(
						eq(rsvTableOccupancies.locationId, input.locationId),
						inArray(rsvTableOccupancies.tableId, targetTableIds),
						eq(rsvTableOccupancies.active, true),
						lte(rsvTableOccupancies.startAt, endAt - 1),
						gte(rsvTableOccupancies.endAt, startAt + 1),
					),
				)
				.all()

			const overlappingResIds = [
				...new Set(
					overlappingOccs
						.filter((o) => o.kind === 'reservation' && o.reservationId)
						.map((o) => o.reservationId!),
				),
			]

			if (overlappingResIds.length > 0) {
				const resRows = await db
					.select()
					.from(rsvReservations)
					.where(inArray(rsvReservations.id, overlappingResIds))
					.all()

				for (const r of resRows) {
					if (
						r.assignment === 'soft' &&
						SOFT_REFLOWABLE_STATUSES.has(r.status)
					) {
						const allResOccs = await db
							.select()
							.from(rsvTableOccupancies)
							.where(
								and(
									eq(rsvTableOccupancies.reservationId, r.id),
									eq(rsvTableOccupancies.active, true),
								),
							)
							.all()
						preDeactivatedOriginalTables.set(
							r.id,
							allResOccs.map((o) => o.tableId),
						)
						if (allResOccs.length > 0) {
							await db
								.update(rsvTableOccupancies)
								.set({ active: false })
								.where(
									inArray(
										rsvTableOccupancies.id,
										allResOccs.map((o) => o.id),
									),
								)
						}
						if (r.comboId) {
							await db
								.update(rsvReservations)
								.set({ comboId: null, updatedAt: now })
								.where(eq(rsvReservations.id, r.id))
						}
					}
				}
			}

			// Expand block into rsv_table_occupancies for each target table
			for (const tid of targetTableIds) {
				const remainingOverlap = await db
					.select()
					.from(rsvTableOccupancies)
					.where(
						and(
							eq(rsvTableOccupancies.tableId, tid),
							eq(rsvTableOccupancies.active, true),
							eq(rsvTableOccupancies.overbook, false),
							lte(rsvTableOccupancies.startAt, endAt - 1),
							gte(rsvTableOccupancies.endAt, startAt + 1),
						),
					)
					.get()

				await db.insert(rsvTableOccupancies).values({
					id: createId('occ'),
					locationId: input.locationId,
					tableId: tid,
					kind: 'block',
					blockId: id,
					startAt,
					endAt,
					active: true,
					overbook: Boolean(remainingOverlap),
					createdAt: now,
				})
			}
		}

		await bumpDayVersion(db, input.locationId, input.businessDate)
		const reflowResult = await reflowFutureBookingsForLocation(
			db,
			input.locationId,
			{
				affectedDates: [input.businessDate],
				invalidatedTableIds: targetTableIds,
				preDeactivatedOriginalTables,
			},
		)

		await writeSetupAudit(db, {
			actorId: input.actorId,
			locationId: input.locationId,
			action: 'block.create',
			entityKind: 'block',
			entityId: id,
			diff: {
				businessDate: input.businessDate,
				tableId: input.tableId ?? null,
				areaId: input.areaId ?? null,
			},
		})

		const row = await db
			.select()
			.from(rsvBlocks)
			.where(eq(rsvBlocks.id, id))
			.get()
		return {
			block: serializeBlock(row!),
			...reflowResult,
		}
	})
}

export async function deleteBlockForLocation(
	outerDb: TenantDatabase,
	blockId: string,
	actorId: string | null,
	locationId?: string,
) {
	return withSetupWrite(outerDb, async (db) => {
		const existing = await db
			.select()
			.from(rsvBlocks)
			.where(eq(rsvBlocks.id, blockId))
			.get()
		if (!existing) throw notFound('Block not found')
		if (locationId && existing.locationId !== locationId) {
			throw notFound('Block not found in location')
		}

		await db
			.update(rsvTableOccupancies)
			.set({ active: false })
			.where(eq(rsvTableOccupancies.blockId, blockId))
		await db.delete(rsvBlocks).where(eq(rsvBlocks.id, blockId))

		await bumpDayVersion(db, existing.locationId, existing.businessDate)
		await writeSetupAudit(db, {
			actorId,
			locationId: existing.locationId,
			action: 'block.delete',
			entityKind: 'block',
			entityId: blockId,
		})
		return { deleted: true, id: blockId }
	})
}

// ============================================================================
// Section Layouts (Server Sections)
// ============================================================================

export interface SectionInput {
	id?: string
	name: string
	colorToken?: string
	color_token?: string
	sort?: number
	sortOrder?: number
	tableIds?: string[]
	table_ids?: string[]
}

export interface SerializedSection {
	id: string
	layoutId: string
	layout_id: string
	name: string
	colorToken: string
	color_token: string
	sort: number
	sortOrder: number
	tableIds: string[]
	table_ids: string[]
}

export interface SerializedSectionLayout {
	id: string
	locationId: string
	location_id: string
	name: string
	archivedAt: number | null
	archived_at: number | null
	sections: SerializedSection[]
}

async function validateAndNormalizeSections(
	db: TenantDatabase,
	locationId: string,
	sections: SectionInput[],
): Promise<
	Array<{
		id: string
		name: string
		colorToken: string
		sort: number
		tableIds: string[]
	}>
> {
	const seenTables = new Set<string>()
	const allRequestedTables = new Set<string>()
	const normalized: Array<{
		id: string
		name: string
		colorToken: string
		sort: number
		tableIds: string[]
	}> = []

	for (let idx = 0; idx < sections.length; idx++) {
		const sec = sections[idx]!
		const name = sec.name?.trim()
		if (!name) {
			throw badRequest('invalid_section', 'Section name is required')
		}
		const rawTableIds = sec.tableIds ?? sec.table_ids ?? []
		const dedupedInSection = [...new Set(rawTableIds)]
		for (const tid of dedupedInSection) {
			if (seenTables.has(tid)) {
				throw conflict(
					'table_in_multiple_sections',
					`Table ${tid} is assigned to multiple sections in the same layout`,
				)
			}
			seenTables.add(tid)
			allRequestedTables.add(tid)
		}
		normalized.push({
			id: sec.id?.trim() || createId('sec'),
			name,
			colorToken: sec.colorToken ?? sec.color_token ?? 'slate',
			sort: sec.sort ?? sec.sortOrder ?? idx,
			tableIds: dedupedInSection,
		})
	}

	if (allRequestedTables.size > 0) {
		const validTables = await db
			.select()
			.from(rsvTables)
			.where(
				and(
					eq(rsvTables.locationId, locationId),
					inArray(rsvTables.id, [...allRequestedTables]),
					isNull(rsvTables.archivedAt),
				),
			)
			.all()
		if (validTables.length !== allRequestedTables.size) {
			throw badRequest(
				'invalid_table',
				'One or more tables do not belong to this location or are archived',
			)
		}
	}

	return normalized
}

async function hydrateSectionLayout(
	db: TenantDatabase,
	layout: typeof rsvSectionLayouts.$inferSelect,
): Promise<SerializedSectionLayout> {
	const secRows = await db
		.select()
		.from(rsvSections)
		.where(eq(rsvSections.layoutId, layout.id))
		.orderBy(asc(rsvSections.sort), asc(rsvSections.id))
		.all()

	const tableRows = await db
		.select()
		.from(rsvSectionTables)
		.where(eq(rsvSectionTables.layoutId, layout.id))
		.all()

	const tablesBySection = new Map<string, string[]>()
	for (const row of tableRows) {
		const list = tablesBySection.get(row.sectionId) ?? []
		list.push(row.tableId)
		tablesBySection.set(row.sectionId, list)
	}

	return {
		id: layout.id,
		locationId: layout.locationId,
		location_id: layout.locationId,
		name: layout.name,
		archivedAt: layout.archivedAt,
		archived_at: layout.archivedAt,
		sections: secRows.map((s) => {
			const tids = tablesBySection.get(s.id) ?? []
			return {
				id: s.id,
				layoutId: s.layoutId,
				layout_id: s.layoutId,
				name: s.name,
				colorToken: s.colorToken,
				color_token: s.colorToken,
				sort: s.sort,
				sortOrder: s.sort,
				tableIds: tids,
				table_ids: tids,
			}
		}),
	}
}

export async function listSectionLayoutsForLocation(
	db: TenantDatabase,
	locationId: string,
): Promise<SerializedSectionLayout[]> {
	const layouts = await db
		.select()
		.from(rsvSectionLayouts)
		.where(
			and(
				eq(rsvSectionLayouts.locationId, locationId),
				isNull(rsvSectionLayouts.archivedAt),
			),
		)
		.orderBy(asc(rsvSectionLayouts.name), asc(rsvSectionLayouts.id))
		.all()

	const results: SerializedSectionLayout[] = []
	for (const layout of layouts) {
		results.push(await hydrateSectionLayout(db, layout))
	}
	return results
}

export async function createSectionLayoutForLocation(
	outerDb: TenantDatabase,
	input: {
		locationId: string
		actorId: string | null
		name: string
		serviceId?: string | null
		isDefault?: boolean
		sections: SectionInput[]
	},
): Promise<{ layout: SerializedSectionLayout }> {
	return withSetupWrite(outerDb, async (db) => {
		const name = input.name?.trim()
		if (!name) {
			throw badRequest('invalid_name', 'Layout name is required')
		}

		const normalizedSections = await validateAndNormalizeSections(
			db,
			input.locationId,
			input.sections ?? [],
		)

		const layoutId = createId('secl')
		await db.insert(rsvSectionLayouts).values({
			id: layoutId,
			locationId: input.locationId,
			name,
			archivedAt: null,
		})

		for (const sec of normalizedSections) {
			await db.insert(rsvSections).values({
				id: sec.id,
				layoutId,
				name: sec.name,
				colorToken: sec.colorToken,
				sort: sec.sort,
			})
			for (const tableId of sec.tableIds) {
				await db.insert(rsvSectionTables).values({
					sectionId: sec.id,
					tableId,
					layoutId,
				})
			}
		}

		if (input.serviceId) {
			await db
				.update(rsvServices)
				.set({ sectionLayoutId: layoutId })
				.where(
					and(
						eq(rsvServices.id, input.serviceId),
						eq(rsvServices.locationId, input.locationId),
					),
				)
		}

		await writeSetupAudit(db, {
			actorId: input.actorId,
			locationId: input.locationId,
			action: 'section_layout.create',
			entityKind: 'section_layout',
			entityId: layoutId,
			diff: {
				name,
				sectionCount: normalizedSections.length,
			},
		})

		const row = await db
			.select()
			.from(rsvSectionLayouts)
			.where(eq(rsvSectionLayouts.id, layoutId))
			.get()

		return {
			layout: await hydrateSectionLayout(db, row!),
		}
	})
}

export async function updateSectionLayoutForLocation(
	outerDb: TenantDatabase,
	layoutId: string,
	input: {
		locationId?: string
		actorId: string | null
		name?: string
		serviceId?: string | null
		isDefault?: boolean
		sections?: SectionInput[]
	},
): Promise<{ layout: SerializedSectionLayout }> {
	return withSetupWrite(outerDb, async (db) => {
		const existing = await db
			.select()
			.from(rsvSectionLayouts)
			.where(eq(rsvSectionLayouts.id, layoutId))
			.get()
		if (!existing || existing.archivedAt !== null) {
			throw notFound('Section layout not found')
		}
		if (input.locationId && existing.locationId !== input.locationId) {
			throw notFound('Section layout not found in location')
		}

		const nextName =
			input.name !== undefined ? input.name.trim() : existing.name
		if (!nextName) {
			throw badRequest('invalid_name', 'Layout name is required')
		}

		if (nextName !== existing.name) {
			await db
				.update(rsvSectionLayouts)
				.set({ name: nextName })
				.where(eq(rsvSectionLayouts.id, layoutId))
		}

		if (input.sections !== undefined) {
			const normalizedSections = await validateAndNormalizeSections(
				db,
				existing.locationId,
				input.sections,
			)

			await db
				.delete(rsvSectionTables)
				.where(eq(rsvSectionTables.layoutId, layoutId))
			await db.delete(rsvSections).where(eq(rsvSections.layoutId, layoutId))

			for (const sec of normalizedSections) {
				await db.insert(rsvSections).values({
					id: sec.id,
					layoutId,
					name: sec.name,
					colorToken: sec.colorToken,
					sort: sec.sort,
				})
				for (const tableId of sec.tableIds) {
					await db.insert(rsvSectionTables).values({
						sectionId: sec.id,
						tableId,
						layoutId,
					})
				}
			}
		}

		if (input.serviceId) {
			await db
				.update(rsvServices)
				.set({ sectionLayoutId: layoutId })
				.where(
					and(
						eq(rsvServices.id, input.serviceId),
						eq(rsvServices.locationId, existing.locationId),
					),
				)
		}

		await writeSetupAudit(db, {
			actorId: input.actorId,
			locationId: existing.locationId,
			action: 'section_layout.update',
			entityKind: 'section_layout',
			entityId: layoutId,
			diff: {
				name: nextName,
			},
		})

		const updated = await db
			.select()
			.from(rsvSectionLayouts)
			.where(eq(rsvSectionLayouts.id, layoutId))
			.get()

		return {
			layout: await hydrateSectionLayout(db, updated!),
		}
	})
}

export async function deleteSectionLayoutForLocation(
	outerDb: TenantDatabase,
	layoutId: string,
	actorId: string | null,
	locationId?: string,
): Promise<{ deleted: true; id: string }> {
	return withSetupWrite(outerDb, async (db) => {
		const existing = await db
			.select()
			.from(rsvSectionLayouts)
			.where(eq(rsvSectionLayouts.id, layoutId))
			.get()
		if (!existing || existing.archivedAt !== null) {
			throw notFound('Section layout not found')
		}
		if (locationId && existing.locationId !== locationId) {
			throw notFound('Section layout not found in location')
		}

		const now = Date.now()
		await db
			.update(rsvSectionLayouts)
			.set({ archivedAt: now })
			.where(eq(rsvSectionLayouts.id, layoutId))
		await db
			.delete(rsvSectionTables)
			.where(eq(rsvSectionTables.layoutId, layoutId))

		await writeSetupAudit(db, {
			actorId,
			locationId: existing.locationId,
			action: 'section_layout.delete',
			entityKind: 'section_layout',
			entityId: layoutId,
		})

		return { deleted: true, id: layoutId }
	})
}
