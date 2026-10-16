import {
	RESERVATIONS_PERMISSIONS,
	setupAreaInputSchema,
	setupBlockInputSchema,
	setupComboInputSchema,
	setupFloorElementInputSchema,
	setupLocationSettingsPatchSchema,
	setupPacingRuleInputSchema,
	setupServiceAvailabilityInputSchema,
	setupServiceInputSchema,
	setupSpecialDayInputSchema,
	setupTableInputSchema,
	setupTurnTimeInputSchema,
} from '@repo/reservations'
import {
	getTenantDb,
	rsvAreas,
	rsvBlocks,
	rsvFloorElements,
	rsvLocationSettings,
	rsvPacingRules,
	rsvSectionLayouts,
	rsvServiceAvailability,
	rsvServices,
	rsvSpecialDays,
	rsvTableCombos,
	rsvTables,
	rsvTurnTimes,
	type TenantDatabase,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { type Context, Hono } from 'hono'
import { z } from 'zod'
import { badRequest, handleRouteError, json, notFound } from '../lib/http.ts'
import {
	filterReservationsLocations,
	requireReservationsLocation,
} from '../lib/reservations-auth.ts'
import {
	ensureActiveOrgInNodeRegion,
	getRsvAuth,
	rsvGuard,
} from '../lib/reservations-guard.ts'
import {
	archiveAreaForLocation,
	archiveServiceForLocation,
	archiveTableForLocation,
	createAreaForLocation,
	createBlockForLocation,
	createComboForLocation,
	createFloorElementForLocation,
	createPacingRuleForLocation,
	createSectionLayoutForLocation,
	createServiceForLocation,
	createSpecialDayForLocation,
	createTableForLocation,
	createTurnTimeForLocation,
	deleteBlockForLocation,
	deleteComboForLocation,
	deleteFloorElementForLocation,
	deletePacingRuleForLocation,
	deleteSectionLayoutForLocation,
	deleteServiceAvailabilityForLocation,
	deleteSpecialDayForLocation,
	deleteTurnTimeForLocation,
	detectLocationConflicts,
	getFloorPlan,
	getLocationSettingsWithContext,
	listAreasForLocation,
	listBlocksForLocation,
	listCombosForLocation,
	listFloorElementsForLocation,
	listPacingRulesForLocation,
	listSectionLayoutsForLocation,
	listServiceAvailabilityForLocation,
	listServicesForLocation,
	listSpecialDaysForLocation,
	listTablesForLocation,
	listTurnTimesForLocation,
	rederiveLocationTimes,
	saveFloorPlan,
	updateAreaForLocation,
	updateComboForLocation,
	updateLocationSettings,
	updatePacingRuleForLocation,
	updateSectionLayoutForLocation,
	updateServiceForLocation,
	updateSpecialDayForLocation,
	updateTableForLocation,
	updateTurnTimeForLocation,
	upsertServiceAvailabilityForLocation,
	validateLocationSetup,
} from '../services/rsv-setup-service.js'

const I18N_MAP_KEYS = new Set([
	'nameI18n',
	'name_i18n',
	'publicNoteI18n',
	'public_note_i18n',
	'largePartyNoteI18n',
	'large_party_note_i18n',
])

function snakeToCamel(key: string): string {
	return key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())
}

function camelToSnake(key: string): string {
	return key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)
}

function normalizeInputKeys(value: unknown, parentKey?: string): unknown {
	if (Array.isArray(value)) {
		return value.map((item) => normalizeInputKeys(item))
	}
	if (value && typeof value === 'object') {
		if (parentKey && I18N_MAP_KEYS.has(parentKey)) {
			return value
		}
		const out: Record<string, unknown> = {}
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			const camelKey = snakeToCamel(k)
			const normalizedVal = normalizeInputKeys(v, camelKey)
			if (out[camelKey] === undefined) {
				out[camelKey] = normalizedVal
			}
		}
		if (out.combinations !== undefined && out.combos === undefined) {
			out.combos = out.combinations
		}
		return out
	}
	return value
}

/**
 * Formats a ZodError into a 400 response with field paths and issue codes only,
 * never echoing any rejected input values (VAL-SETUP-030).
 */
function setupValidationResponse(error: z.ZodError): Response {
	const fieldSet = new Set<string>()
	for (const issue of error.issues) {
		const pathStr = issue.path.join('.')
		if (pathStr.length > 0) {
			fieldSet.add(pathStr)
			fieldSet.add(camelToSnake(pathStr))
		}
	}
	const issues = error.issues.slice(0, 25).map((issue) => ({
		path: issue.path.join('.'),
		code: issue.code,
	}))
	return json(
		{
			error: 'invalid',
			message: 'Invalid request',
			fields: [...fieldSet],
			issues,
		},
		400,
	)
}

async function readNormalizedBody(
	c: Context,
): Promise<Record<string, unknown>> {
	let raw: unknown
	try {
		raw = await c.req.json()
	} catch {
		throw badRequest('invalid_json', 'Request body must be valid JSON')
	}
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		throw badRequest('invalid_body', 'Request body must be a JSON object')
	}
	return normalizeInputKeys(raw) as Record<string, unknown>
}

function parseSchemaOrThrow<T extends z.ZodTypeAny>(
	schema: T,
	input: unknown,
): z.infer<T> {
	const parsed = schema.safeParse(input)
	if (!parsed.success) {
		throw parsed.error
	}
	return parsed.data
}

function assertAllowedLocation(c: Context, locationId: string): string {
	const ctx = getRsvAuth(c)
	const check = requireReservationsLocation(ctx, locationId)
	if (!check.ok) {
		throw check.response
	}
	return check.locationId
}

/**
 * Enforces location access on any explicit locationId in path, query, or body
 * BEFORE body schema validation so cross-location tokens always get 403.
 */
function checkExplicitLocations(
	c: Context,
	body?: Record<string, unknown>,
): string | undefined {
	const paramLoc = c.req.param('locationId')
	const queryLoc = c.req.query('locationId') ?? c.req.query('location_id')
	const bodyLoc =
		typeof body?.locationId === 'string' && body.locationId.trim()
			? body.locationId.trim()
			: undefined

	if (paramLoc) assertAllowedLocation(c, paramLoc)
	if (queryLoc) assertAllowedLocation(c, queryLoc)
	if (bodyLoc) assertAllowedLocation(c, bodyLoc)

	return paramLoc ?? queryLoc ?? bodyLoc
}

function requireLocationId(c: Context, body?: Record<string, unknown>): string {
	const locId = checkExplicitLocations(c, body)
	if (!locId) {
		throw badRequest('invalid', 'locationId is required', {
			fields: ['locationId', 'location_id'],
		})
	}
	return locId
}

async function getServiceOrThrow(db: TenantDatabase, serviceId: string) {
	const svc = await db
		.select()
		.from(rsvServices)
		.where(eq(rsvServices.id, serviceId))
		.get()
	if (!svc) throw notFound('Service not found')
	return svc
}

async function requireServiceLocationAccess(
	c: Context,
	db: TenantDatabase,
	serviceId: string,
) {
	const svc = await getServiceOrThrow(db, serviceId)
	assertAllowedLocation(c, svc.locationId)
	return svc
}

const setupAreaUpdateSchema = setupAreaInputSchema.partial()
const setupTableUpdateSchema = setupTableInputSchema.partial()
const setupComboUpdateSchema = setupComboInputSchema.partial()
const setupServiceUpdateSchema = setupServiceInputSchema.partial()
const setupTurnTimeUpdateSchema = setupTurnTimeInputSchema.partial()
const setupPacingRuleUpdateSchema = setupPacingRuleInputSchema.partial()
const setupServiceAvailabilityUpdateSchema =
	setupServiceAvailabilityInputSchema.partial()
const setupSpecialDayUpdateSchema = setupSpecialDayInputSchema.partial()

const floorPlanPutPayloadSchema = z.object({
	expectedFloorPlanVersion: z.number().int().min(1).optional(),
	expectedVersion: z.number().int().min(1).optional(),
	floorPlanVersion: z.number().int().min(1).optional(),
	archiveMissingTables: z.boolean().optional(),
	areas: z
		.array(
			setupAreaInputSchema.omit({ locationId: true }).extend({
				id: z.string().min(1).max(64).optional(),
				locationId: z.string().min(1).max(64).optional(),
				archived: z.boolean().optional(),
				archivedAt: z.number().int().nullable().optional(),
			}),
		)
		.optional(),
	tables: z
		.array(
			setupTableInputSchema.omit({ locationId: true }).extend({
				id: z.string().min(1).max(64).optional(),
				locationId: z.string().min(1).max(64).optional(),
				archived: z.boolean().optional(),
				archivedAt: z.number().int().nullable().optional(),
			}),
		)
		.optional(),
	combos: z
		.array(
			setupComboInputSchema.omit({ locationId: true }).extend({
				id: z.string().min(1).max(64).optional(),
				locationId: z.string().min(1).max(64).optional(),
				archived: z.boolean().optional(),
				archivedAt: z.number().int().nullable().optional(),
			}),
		)
		.optional(),
	elements: z
		.array(
			setupFloorElementInputSchema.omit({ locationId: true }).extend({
				id: z.string().min(1).max(64).optional(),
				locationId: z.string().min(1).max(64).optional(),
			}),
		)
		.optional(),
	floorElements: z
		.array(
			setupFloorElementInputSchema.omit({ locationId: true }).extend({
				id: z.string().min(1).max(64).optional(),
				locationId: z.string().min(1).max(64).optional(),
			}),
		)
		.optional(),
})

export const operatorReservationsSetupRoutes = new Hono()

const readSetupGuard = rsvGuard({
	scope: 'setup',
	grant: RESERVATIONS_PERMISSIONS.READ_RESERVATION_SETTINGS,
})

const writeSetupGuard = rsvGuard({
	scope: 'setup',
	grant: RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION_SETTINGS,
	write: true,
})

function wrapHandler(
	handler: (c: Context) => Promise<Response>,
): (c: Context) => Promise<Response> {
	return async (c: Context) => {
		try {
			const ctx = getRsvAuth(c)
			const orgErr = await ensureActiveOrgInNodeRegion(ctx)
			if (orgErr) return orgErr
			return await handler(c)
		} catch (err) {
			if (err instanceof Response) {
				return err
			}
			if (err instanceof z.ZodError) {
				return setupValidationResponse(err)
			}
			return handleRouteError(err)
		}
	}
}

// ============================================================================
// Setup Overview
// ============================================================================

operatorReservationsSetupRoutes.get(
	'/overview',
	readSetupGuard,
	wrapHandler(async (c) => {
		const ctx = getRsvAuth(c)
		const targetLoc = checkExplicitLocations(c)
		const db = await getTenantDb(ctx.orgId)
		const [locations, areas, tables, combos, services, turnTimes] =
			await Promise.all([
				db.select().from(rsvLocationSettings),
				db.select().from(rsvAreas),
				db.select().from(rsvTables),
				db.select().from(rsvTableCombos),
				db.select().from(rsvServices),
				db.select().from(rsvTurnTimes),
			])

		const filterLoc = <T extends { locationId: string }>(rows: T[]) => {
			const scoped = filterReservationsLocations(ctx, rows)
			return targetLoc
				? scoped.filter((row) => row.locationId === targetLoc)
				: scoped
		}

		return json({
			ok: true,
			orgId: ctx.orgId,
			locations: filterLoc(locations),
			areas: filterLoc(areas),
			tables: filterLoc(tables),
			combos: filterLoc(combos),
			services: filterLoc(services),
			turnTimes: filterLoc(turnTimes),
		})
	}),
)

// ============================================================================
// Location Settings (GET / PUT / PATCH / POST)
// ============================================================================

const getSettingsHandler = wrapHandler(async (c) => {
	const ctx = getRsvAuth(c)
	const locationId = requireLocationId(c)
	const db = await getTenantDb(ctx.orgId)
	const settings = await getLocationSettingsWithContext(
		db,
		ctx.orgId,
		locationId,
	)
	return json({
		ok: true,
		orgId: ctx.orgId,
		...settings,
		settings,
	})
})

const updateSettingsHandler = wrapHandler(async (c) => {
	const ctx = getRsvAuth(c)
	const body = await readNormalizedBody(c)
	const locationId = requireLocationId(c, body)
	const parsed = parseSchemaOrThrow(setupLocationSettingsPatchSchema, body)
	const db = await getTenantDb(ctx.orgId)
	const updated = await updateLocationSettings(
		db,
		ctx.orgId,
		locationId,
		ctx.userId,
		{
			expectedVersion: parsed.expectedVersion,
			enabled: parsed.enabled,
			onlineEnabled: parsed.onlineEnabled,
			waitlistEnabled: parsed.waitlistEnabled,
			waitlistOnline: parsed.waitlistOnline,
			notifyMeEnabled: parsed.notifyMeEnabled,
			timeZone: parsed.timeZone,
			currency: parsed.currency,
			dayStartMin: parsed.dayStartMin,
			intervalMin: parsed.intervalMin,
			horizonDays: parsed.horizonDays,
			releaseLocalMin: parsed.releaseLocalMin,
			minNoticeMin: parsed.minNoticeMin,
			sameDayCutoffMin: parsed.sameDayCutoffMin,
			onlinePartyMin: parsed.onlinePartyMin ?? parsed.minParty,
			onlinePartyMax: parsed.onlinePartyMax ?? parsed.maxOnlineParty,
			partyMax: parsed.partyMax ?? parsed.maxParty,
			largePartyMode: parsed.largePartyMode as
				'contact' | 'request' | 'disabled' | 'call_only' | undefined,
			largePartyNoteI18n: parsed.largePartyNoteI18n,
			requestHoldsCapacity: parsed.requestHoldsCapacity,
			requestDeadlineHours: parsed.requestDeadlineHours,
			contactPhone: parsed.contactPhone,
			publicNoteI18n: parsed.publicNoteI18n,
			seatingPrefMode: (parsed.seatingPrefMode ??
				parsed.seatingPreferenceMode) as
				'off' | 'preferred' | 'strict' | 'preference' | undefined,
			holdMinutes:
				parsed.holdMinutes ??
				(parsed.holdTtlSec !== undefined
					? Math.max(1, Math.round(parsed.holdTtlSec / 60))
					: undefined),
			paymentHoldMinutes: parsed.paymentHoldMinutes,
			voiceHoldMinutes: parsed.voiceHoldMinutes,
			voiceMode: parsed.voiceMode,
			freezeMin: parsed.freezeMin ?? parsed.assignmentFreezeMin,
			lateGraceMin: parsed.lateGraceMin ?? parsed.graceMin,
			autoNoShowAfterMin:
				parsed.autoNoShowAfterMin !== undefined
					? parsed.autoNoShowAfterMin
					: parsed.autoNoShowMin,
			maxActivePerPhone: parsed.maxActivePerPhone,
			blockSamePhoneOverlap: parsed.blockSamePhoneOverlap,
			guestModifyCutoffMin:
				parsed.guestModifyCutoffMin ?? parsed.modifyCutoffMin,
			contactStatusesEnabled: parsed.contactStatusesEnabled,
			courseStatusesEnabled: parsed.courseStatusesEnabled,
			defaultPolicyId: parsed.defaultPolicyId,
			waitlistResponseMin: parsed.waitlistResponseMin,
			waitlistMaxParties: parsed.waitlistMaxParties,
		},
	)
	return json({
		ok: true,
		orgId: ctx.orgId,
		...updated,
		settings: updated,
	})
})

operatorReservationsSetupRoutes.get(
	'/locations/:locationId/settings',
	readSetupGuard,
	getSettingsHandler,
)
operatorReservationsSetupRoutes.get(
	'/settings',
	readSetupGuard,
	getSettingsHandler,
)
operatorReservationsSetupRoutes.put(
	'/locations/:locationId/settings',
	writeSetupGuard,
	updateSettingsHandler,
)
operatorReservationsSetupRoutes.patch(
	'/locations/:locationId/settings',
	writeSetupGuard,
	updateSettingsHandler,
)
operatorReservationsSetupRoutes.post(
	'/locations/:locationId/settings',
	writeSetupGuard,
	updateSettingsHandler,
)
operatorReservationsSetupRoutes.put(
	'/settings',
	writeSetupGuard,
	updateSettingsHandler,
)
operatorReservationsSetupRoutes.post(
	'/settings',
	writeSetupGuard,
	updateSettingsHandler,
)

// ============================================================================
// Floor Plan (GET / PUT / POST)
// ============================================================================

const getFloorPlanHandler = wrapHandler(async (c) => {
	const ctx = getRsvAuth(c)
	const locationId = requireLocationId(c)
	const db = await getTenantDb(ctx.orgId)
	const plan = await getFloorPlan(db, ctx.orgId, locationId)
	return json(plan)
})

const saveFloorPlanHandler = wrapHandler(async (c) => {
	const ctx = getRsvAuth(c)
	const body = await readNormalizedBody(c)
	const locationId = requireLocationId(c, body)
	const parsed = parseSchemaOrThrow(floorPlanPutPayloadSchema, body)
	const db = await getTenantDb(ctx.orgId)
	const result = await saveFloorPlan(
		db,
		ctx.orgId,
		locationId,
		parsed,
		ctx.userId,
	)
	return json(result)
})

operatorReservationsSetupRoutes.get(
	'/locations/:locationId/floor-plan',
	readSetupGuard,
	getFloorPlanHandler,
)
operatorReservationsSetupRoutes.get(
	'/floor-plan',
	readSetupGuard,
	getFloorPlanHandler,
)
operatorReservationsSetupRoutes.put(
	'/locations/:locationId/floor-plan',
	writeSetupGuard,
	saveFloorPlanHandler,
)
operatorReservationsSetupRoutes.post(
	'/locations/:locationId/floor-plan',
	writeSetupGuard,
	saveFloorPlanHandler,
)
operatorReservationsSetupRoutes.put(
	'/floor-plan',
	writeSetupGuard,
	saveFloorPlanHandler,
)
operatorReservationsSetupRoutes.post(
	'/floor-plan',
	writeSetupGuard,
	saveFloorPlanHandler,
)

// ============================================================================
// Dining Areas CRUD
// ============================================================================

const listAreasHandler = wrapHandler(async (c) => {
	const ctx = getRsvAuth(c)
	const locationId = requireLocationId(c)
	const includeArchived =
		c.req.query('includeArchived') === 'true' ||
		c.req.query('include_archived') === 'true'
	const db = await getTenantDb(ctx.orgId)
	const areas = await listAreasForLocation(db, locationId, includeArchived)
	return json({ locationId, areas })
})

const createAreaHandler = wrapHandler(async (c) => {
	const ctx = getRsvAuth(c)
	const body = await readNormalizedBody(c)
	const locationId = requireLocationId(c, body)
	const parsed = parseSchemaOrThrow(setupAreaInputSchema, {
		...body,
		locationId,
	})
	const db = await getTenantDb(ctx.orgId)
	const res = await createAreaForLocation(db, {
		actorId: ctx.userId,
		...parsed,
		locationId,
	})
	return json({ ...res.area, ...res }, 201)
})

const updateAreaHandler = wrapHandler(async (c) => {
	const ctx = getRsvAuth(c)
	const body = await readNormalizedBody(c)
	checkExplicitLocations(c, body)
	const areaId = c.req.param('id')!
	const db = await getTenantDb(ctx.orgId)
	const current = await db
		.select()
		.from(rsvAreas)
		.where(eq(rsvAreas.id, areaId))
		.get()
	if (!current) throw notFound('Area not found')
	assertAllowedLocation(c, current.locationId)
	const parsed = parseSchemaOrThrow(setupAreaUpdateSchema, body)
	const res = await updateAreaForLocation(db, areaId, {
		actorId: ctx.userId,
		...parsed,
	})
	return json({ ...res.area, ...res })
})

const deleteAreaHandler = wrapHandler(async (c) => {
	const ctx = getRsvAuth(c)
	checkExplicitLocations(c)
	const areaId = c.req.param('id')!
	const db = await getTenantDb(ctx.orgId)
	const current = await db
		.select()
		.from(rsvAreas)
		.where(eq(rsvAreas.id, areaId))
		.get()
	if (!current) throw notFound('Area not found')
	assertAllowedLocation(c, current.locationId)
	const res = await archiveAreaForLocation(
		db,
		areaId,
		ctx.userId,
		current.locationId,
	)
	return json({ ...res.area, ...res })
})

operatorReservationsSetupRoutes.get('/areas', readSetupGuard, listAreasHandler)
operatorReservationsSetupRoutes.get(
	'/locations/:locationId/areas',
	readSetupGuard,
	listAreasHandler,
)
operatorReservationsSetupRoutes.post(
	'/areas',
	writeSetupGuard,
	createAreaHandler,
)
operatorReservationsSetupRoutes.post(
	'/locations/:locationId/areas',
	writeSetupGuard,
	createAreaHandler,
)
operatorReservationsSetupRoutes.put(
	'/areas/:id',
	writeSetupGuard,
	updateAreaHandler,
)
operatorReservationsSetupRoutes.patch(
	'/areas/:id',
	writeSetupGuard,
	updateAreaHandler,
)
operatorReservationsSetupRoutes.put(
	'/locations/:locationId/areas/:id',
	writeSetupGuard,
	updateAreaHandler,
)
operatorReservationsSetupRoutes.patch(
	'/locations/:locationId/areas/:id',
	writeSetupGuard,
	updateAreaHandler,
)
operatorReservationsSetupRoutes.delete(
	'/areas/:id',
	writeSetupGuard,
	deleteAreaHandler,
)
operatorReservationsSetupRoutes.delete(
	'/locations/:locationId/areas/:id',
	writeSetupGuard,
	deleteAreaHandler,
)

// ============================================================================
// Tables CRUD
// ============================================================================

const listTablesHandler = wrapHandler(async (c) => {
	const ctx = getRsvAuth(c)
	const locationId = requireLocationId(c)
	const areaId = c.req.query('areaId') ?? c.req.query('area_id') ?? undefined
	const includeArchived =
		c.req.query('includeArchived') === 'true' ||
		c.req.query('include_archived') === 'true'
	const db = await getTenantDb(ctx.orgId)
	const tables = await listTablesForLocation(db, locationId, {
		areaId,
		includeArchived,
	})
	return json({ locationId, tables })
})

const createTableHandler = wrapHandler(async (c) => {
	const ctx = getRsvAuth(c)
	const body = await readNormalizedBody(c)
	const locationId = requireLocationId(c, body)
	const parsed = parseSchemaOrThrow(setupTableInputSchema, {
		...body,
		locationId,
	})
	const db = await getTenantDb(ctx.orgId)
	const res = await createTableForLocation(db, {
		actorId: ctx.userId,
		...parsed,
		locationId,
	})
	return json({ ...res.table, ...res }, 201)
})

const updateTableHandler = wrapHandler(async (c) => {
	const ctx = getRsvAuth(c)
	const body = await readNormalizedBody(c)
	checkExplicitLocations(c, body)
	const tableId = c.req.param('id')!
	const db = await getTenantDb(ctx.orgId)
	const current = await db
		.select()
		.from(rsvTables)
		.where(eq(rsvTables.id, tableId))
		.get()
	if (!current) throw notFound('Table not found')
	assertAllowedLocation(c, current.locationId)
	const parsed = parseSchemaOrThrow(setupTableUpdateSchema, body)
	const res = await updateTableForLocation(db, tableId, {
		actorId: ctx.userId,
		...parsed,
	})
	return json({ ...res.table, ...res })
})

const deleteTableHandler = wrapHandler(async (c) => {
	const ctx = getRsvAuth(c)
	checkExplicitLocations(c)
	const tableId = c.req.param('id')!
	const db = await getTenantDb(ctx.orgId)
	const current = await db
		.select()
		.from(rsvTables)
		.where(eq(rsvTables.id, tableId))
		.get()
	if (!current) throw notFound('Table not found')
	assertAllowedLocation(c, current.locationId)
	const res = await archiveTableForLocation(
		db,
		tableId,
		ctx.userId,
		current.locationId,
	)
	return json({ ...res.table, ...res })
})

operatorReservationsSetupRoutes.get(
	'/tables',
	readSetupGuard,
	listTablesHandler,
)
operatorReservationsSetupRoutes.get(
	'/locations/:locationId/tables',
	readSetupGuard,
	listTablesHandler,
)
operatorReservationsSetupRoutes.post(
	'/tables',
	writeSetupGuard,
	createTableHandler,
)
operatorReservationsSetupRoutes.post(
	'/locations/:locationId/tables',
	writeSetupGuard,
	createTableHandler,
)
operatorReservationsSetupRoutes.put(
	'/tables/:id',
	writeSetupGuard,
	updateTableHandler,
)
operatorReservationsSetupRoutes.patch(
	'/tables/:id',
	writeSetupGuard,
	updateTableHandler,
)
operatorReservationsSetupRoutes.put(
	'/locations/:locationId/tables/:id',
	writeSetupGuard,
	updateTableHandler,
)
operatorReservationsSetupRoutes.patch(
	'/locations/:locationId/tables/:id',
	writeSetupGuard,
	updateTableHandler,
)
operatorReservationsSetupRoutes.delete(
	'/tables/:id',
	writeSetupGuard,
	deleteTableHandler,
)
operatorReservationsSetupRoutes.delete(
	'/locations/:locationId/tables/:id',
	writeSetupGuard,
	deleteTableHandler,
)

// ============================================================================
// Table Combinations CRUD
// ============================================================================

const listCombosHandler = wrapHandler(async (c) => {
	const ctx = getRsvAuth(c)
	const locationId = requireLocationId(c)
	const includeArchived =
		c.req.query('includeArchived') === 'true' ||
		c.req.query('include_archived') === 'true'
	const db = await getTenantDb(ctx.orgId)
	const combos = await listCombosForLocation(db, locationId, includeArchived)
	return json({ locationId, combos, combinations: combos })
})

const createComboHandler = wrapHandler(async (c) => {
	const ctx = getRsvAuth(c)
	const body = await readNormalizedBody(c)
	const locationId = requireLocationId(c, body)
	const parsed = parseSchemaOrThrow(setupComboInputSchema, {
		...body,
		locationId,
	})
	const db = await getTenantDb(ctx.orgId)
	const res = await createComboForLocation(db, {
		actorId: ctx.userId,
		...parsed,
		locationId,
	})
	return json({ ...res.combo, ...res }, 201)
})

const updateComboHandler = wrapHandler(async (c) => {
	const ctx = getRsvAuth(c)
	const body = await readNormalizedBody(c)
	checkExplicitLocations(c, body)
	const comboId = c.req.param('id')!
	const db = await getTenantDb(ctx.orgId)
	const current = await db
		.select()
		.from(rsvTableCombos)
		.where(eq(rsvTableCombos.id, comboId))
		.get()
	if (!current) throw notFound('Combination not found')
	assertAllowedLocation(c, current.locationId)
	const parsed = parseSchemaOrThrow(setupComboUpdateSchema, body)
	const res = await updateComboForLocation(db, comboId, {
		actorId: ctx.userId,
		...parsed,
	})
	return json({ ...res.combo, ...res })
})

const deleteComboHandler = wrapHandler(async (c) => {
	const ctx = getRsvAuth(c)
	checkExplicitLocations(c)
	const comboId = c.req.param('id')!
	const db = await getTenantDb(ctx.orgId)
	const current = await db
		.select()
		.from(rsvTableCombos)
		.where(eq(rsvTableCombos.id, comboId))
		.get()
	if (!current) throw notFound('Combination not found')
	assertAllowedLocation(c, current.locationId)
	const res = await deleteComboForLocation(
		db,
		comboId,
		ctx.userId,
		current.locationId,
	)
	return json(res)
})

operatorReservationsSetupRoutes.get(
	'/combos',
	readSetupGuard,
	listCombosHandler,
)
operatorReservationsSetupRoutes.get(
	'/combinations',
	readSetupGuard,
	listCombosHandler,
)
operatorReservationsSetupRoutes.get(
	'/locations/:locationId/combos',
	readSetupGuard,
	listCombosHandler,
)
operatorReservationsSetupRoutes.get(
	'/locations/:locationId/combinations',
	readSetupGuard,
	listCombosHandler,
)
operatorReservationsSetupRoutes.post(
	'/combos',
	writeSetupGuard,
	createComboHandler,
)
operatorReservationsSetupRoutes.post(
	'/combinations',
	writeSetupGuard,
	createComboHandler,
)
operatorReservationsSetupRoutes.post(
	'/locations/:locationId/combos',
	writeSetupGuard,
	createComboHandler,
)
operatorReservationsSetupRoutes.post(
	'/locations/:locationId/combinations',
	writeSetupGuard,
	createComboHandler,
)
operatorReservationsSetupRoutes.put(
	'/combos/:id',
	writeSetupGuard,
	updateComboHandler,
)
operatorReservationsSetupRoutes.patch(
	'/combos/:id',
	writeSetupGuard,
	updateComboHandler,
)
operatorReservationsSetupRoutes.put(
	'/combinations/:id',
	writeSetupGuard,
	updateComboHandler,
)
operatorReservationsSetupRoutes.patch(
	'/combinations/:id',
	writeSetupGuard,
	updateComboHandler,
)
operatorReservationsSetupRoutes.put(
	'/locations/:locationId/combos/:id',
	writeSetupGuard,
	updateComboHandler,
)
operatorReservationsSetupRoutes.delete(
	'/combos/:id',
	writeSetupGuard,
	deleteComboHandler,
)
operatorReservationsSetupRoutes.delete(
	'/combinations/:id',
	writeSetupGuard,
	deleteComboHandler,
)
operatorReservationsSetupRoutes.delete(
	'/locations/:locationId/combos/:id',
	writeSetupGuard,
	deleteComboHandler,
)

// ============================================================================
// Floor Elements CRUD
// ============================================================================

const listElementsHandler = wrapHandler(async (c) => {
	const ctx = getRsvAuth(c)
	const locationId = requireLocationId(c)
	const areaId = c.req.query('areaId') ?? c.req.query('area_id') ?? undefined
	const db = await getTenantDb(ctx.orgId)
	const elements = await listFloorElementsForLocation(db, locationId, areaId)
	return json({ locationId, elements })
})

const createElementHandler = wrapHandler(async (c) => {
	const ctx = getRsvAuth(c)
	const body = await readNormalizedBody(c)
	const locationId = requireLocationId(c, body)
	const parsed = parseSchemaOrThrow(setupFloorElementInputSchema, {
		...body,
		locationId,
	})
	const db = await getTenantDb(ctx.orgId)
	const res = await createFloorElementForLocation(db, {
		actorId: ctx.userId,
		...parsed,
		locationId,
	})
	return json({ ...res.element, ...res }, 201)
})

const deleteElementHandler = wrapHandler(async (c) => {
	const ctx = getRsvAuth(c)
	checkExplicitLocations(c)
	const elementId = c.req.param('id')!
	const db = await getTenantDb(ctx.orgId)
	const el = await db
		.select()
		.from(rsvFloorElements)
		.where(eq(rsvFloorElements.id, elementId))
		.get()
	if (!el) throw notFound('Floor element not found')
	const area = await db
		.select()
		.from(rsvAreas)
		.where(eq(rsvAreas.id, el.areaId))
		.get()
	if (!area) throw notFound('Floor element not found')
	assertAllowedLocation(c, area.locationId)
	const res = await deleteFloorElementForLocation(
		db,
		elementId,
		ctx.userId,
		area.locationId,
	)
	return json(res)
})

operatorReservationsSetupRoutes.get(
	'/elements',
	readSetupGuard,
	listElementsHandler,
)
operatorReservationsSetupRoutes.get(
	'/floor-elements',
	readSetupGuard,
	listElementsHandler,
)
operatorReservationsSetupRoutes.get(
	'/locations/:locationId/elements',
	readSetupGuard,
	listElementsHandler,
)
operatorReservationsSetupRoutes.post(
	'/elements',
	writeSetupGuard,
	createElementHandler,
)
operatorReservationsSetupRoutes.post(
	'/floor-elements',
	writeSetupGuard,
	createElementHandler,
)
operatorReservationsSetupRoutes.post(
	'/locations/:locationId/elements',
	writeSetupGuard,
	createElementHandler,
)
operatorReservationsSetupRoutes.delete(
	'/elements/:id',
	writeSetupGuard,
	deleteElementHandler,
)
operatorReservationsSetupRoutes.delete(
	'/floor-elements/:id',
	writeSetupGuard,
	deleteElementHandler,
)
operatorReservationsSetupRoutes.delete(
	'/locations/:locationId/elements/:id',
	writeSetupGuard,
	deleteElementHandler,
)

// ============================================================================
// Services CRUD
// ============================================================================

const listServicesHandler = wrapHandler(async (c) => {
	const ctx = getRsvAuth(c)
	const locationId = requireLocationId(c)
	const includeArchived =
		c.req.query('includeArchived') === 'true' ||
		c.req.query('include_archived') === 'true'
	const db = await getTenantDb(ctx.orgId)
	const services = await listServicesForLocation(
		db,
		locationId,
		includeArchived,
	)
	return json({ locationId, services })
})

const createServiceHandler = wrapHandler(async (c) => {
	const ctx = getRsvAuth(c)
	const body = await readNormalizedBody(c)
	const locationId = requireLocationId(c, body)
	const parsed = parseSchemaOrThrow(setupServiceInputSchema, {
		...body,
		locationId,
	})
	const db = await getTenantDb(ctx.orgId)
	const service = await createServiceForLocation(db, {
		actorId: ctx.userId,
		...parsed,
		locationId,
	})
	return json({ ...service, service }, 201)
})

const updateServiceHandler = wrapHandler(async (c) => {
	const ctx = getRsvAuth(c)
	const body = await readNormalizedBody(c)
	checkExplicitLocations(c, body)
	const serviceId = c.req.param('id')!
	const db = await getTenantDb(ctx.orgId)
	const current = await getServiceOrThrow(db, serviceId)
	assertAllowedLocation(c, current.locationId)
	const parsed = parseSchemaOrThrow(setupServiceUpdateSchema, body)
	const result = await updateServiceForLocation(db, serviceId, {
		actorId: ctx.userId,
		...parsed,
	})
	return json({ ...result.service, ...result })
})

const deleteServiceHandler = wrapHandler(async (c) => {
	const ctx = getRsvAuth(c)
	checkExplicitLocations(c)
	const serviceId = c.req.param('id')!
	const db = await getTenantDb(ctx.orgId)
	const current = await getServiceOrThrow(db, serviceId)
	assertAllowedLocation(c, current.locationId)
	const result = await archiveServiceForLocation(
		db,
		serviceId,
		ctx.userId,
		current.locationId,
	)
	return json({ ...result.service, ...result })
})

operatorReservationsSetupRoutes.get(
	'/services',
	readSetupGuard,
	listServicesHandler,
)
operatorReservationsSetupRoutes.get(
	'/locations/:locationId/services',
	readSetupGuard,
	listServicesHandler,
)
operatorReservationsSetupRoutes.post(
	'/services',
	writeSetupGuard,
	createServiceHandler,
)
operatorReservationsSetupRoutes.post(
	'/locations/:locationId/services',
	writeSetupGuard,
	createServiceHandler,
)
operatorReservationsSetupRoutes.put(
	'/services/:id',
	writeSetupGuard,
	updateServiceHandler,
)
operatorReservationsSetupRoutes.patch(
	'/services/:id',
	writeSetupGuard,
	updateServiceHandler,
)
operatorReservationsSetupRoutes.put(
	'/locations/:locationId/services/:id',
	writeSetupGuard,
	updateServiceHandler,
)
operatorReservationsSetupRoutes.patch(
	'/locations/:locationId/services/:id',
	writeSetupGuard,
	updateServiceHandler,
)
operatorReservationsSetupRoutes.delete(
	'/services/:id',
	writeSetupGuard,
	deleteServiceHandler,
)
operatorReservationsSetupRoutes.delete(
	'/locations/:locationId/services/:id',
	writeSetupGuard,
	deleteServiceHandler,
)

// ============================================================================
// Turn Times CRUD
// ============================================================================

const listTurnTimesHandler = wrapHandler(async (c) => {
	const ctx = getRsvAuth(c)
	const locationId = requireLocationId(c)
	const serviceId =
		c.req.query('serviceId') ?? c.req.query('service_id') ?? undefined
	const db = await getTenantDb(ctx.orgId)
	const turnTimes = await listTurnTimesForLocation(db, locationId, serviceId)
	return json({
		locationId,
		turnTimes,
		turn_times: turnTimes,
		turnTimeBuckets: turnTimes,
	})
})

const createTurnTimeHandler = wrapHandler(async (c) => {
	const ctx = getRsvAuth(c)
	const body = await readNormalizedBody(c)
	const locationId = requireLocationId(c, body)
	const parsed = parseSchemaOrThrow(setupTurnTimeInputSchema, {
		...body,
		locationId,
	})
	const db = await getTenantDb(ctx.orgId)
	const turnTime = await createTurnTimeForLocation(db, {
		actorId: ctx.userId,
		...parsed,
		locationId,
	})
	return json({ ...turnTime, turnTime, bucket: turnTime }, 201)
})

const updateTurnTimeHandler = wrapHandler(async (c) => {
	const ctx = getRsvAuth(c)
	const body = await readNormalizedBody(c)
	checkExplicitLocations(c, body)
	const turnTimeId = c.req.param('id')!
	const db = await getTenantDb(ctx.orgId)
	const current = await db
		.select()
		.from(rsvTurnTimes)
		.where(eq(rsvTurnTimes.id, turnTimeId))
		.get()
	if (!current) throw notFound('Turn time bucket not found')
	assertAllowedLocation(c, current.locationId)
	const parsed = parseSchemaOrThrow(setupTurnTimeUpdateSchema, body)
	const turnTime = await updateTurnTimeForLocation(db, turnTimeId, {
		actorId: ctx.userId,
		...parsed,
	})
	return json({ ...turnTime, turnTime, bucket: turnTime })
})

const deleteTurnTimeHandler = wrapHandler(async (c) => {
	const ctx = getRsvAuth(c)
	checkExplicitLocations(c)
	const turnTimeId = c.req.param('id')!
	const db = await getTenantDb(ctx.orgId)
	const current = await db
		.select()
		.from(rsvTurnTimes)
		.where(eq(rsvTurnTimes.id, turnTimeId))
		.get()
	if (!current) throw notFound('Turn time bucket not found')
	assertAllowedLocation(c, current.locationId)
	const result = await deleteTurnTimeForLocation(
		db,
		turnTimeId,
		ctx.userId,
		current.locationId,
	)
	return json(result)
})

operatorReservationsSetupRoutes.get(
	'/turn-times',
	readSetupGuard,
	listTurnTimesHandler,
)
operatorReservationsSetupRoutes.get(
	'/locations/:locationId/turn-times',
	readSetupGuard,
	listTurnTimesHandler,
)
operatorReservationsSetupRoutes.post(
	'/turn-times',
	writeSetupGuard,
	createTurnTimeHandler,
)
operatorReservationsSetupRoutes.post(
	'/locations/:locationId/turn-times',
	writeSetupGuard,
	createTurnTimeHandler,
)
operatorReservationsSetupRoutes.put(
	'/turn-times/:id',
	writeSetupGuard,
	updateTurnTimeHandler,
)
operatorReservationsSetupRoutes.patch(
	'/turn-times/:id',
	writeSetupGuard,
	updateTurnTimeHandler,
)
operatorReservationsSetupRoutes.put(
	'/locations/:locationId/turn-times/:id',
	writeSetupGuard,
	updateTurnTimeHandler,
)
operatorReservationsSetupRoutes.delete(
	'/turn-times/:id',
	writeSetupGuard,
	deleteTurnTimeHandler,
)
operatorReservationsSetupRoutes.delete(
	'/locations/:locationId/turn-times/:id',
	writeSetupGuard,
	deleteTurnTimeHandler,
)

// ============================================================================
// Pacing Rules CRUD
// ============================================================================

const listPacingHandler = wrapHandler(async (c) => {
	const ctx = getRsvAuth(c)
	checkExplicitLocations(c)
	const serviceId = c.req.query('serviceId') ?? c.req.query('service_id')
	const db = await getTenantDb(ctx.orgId)
	if (serviceId) {
		const svc = await requireServiceLocationAccess(c, db, serviceId)
		const pacingRules = await listPacingRulesForLocation(
			db,
			svc.locationId,
			serviceId,
		)
		return json({
			locationId: svc.locationId,
			pacingRules,
			pacing_rules: pacingRules,
			rules: pacingRules,
		})
	}
	const locationId = requireLocationId(c)
	const pacingRules = await listPacingRulesForLocation(db, locationId)
	return json({
		locationId,
		pacingRules,
		pacing_rules: pacingRules,
		rules: pacingRules,
	})
})

const createPacingHandler = wrapHandler(async (c) => {
	const ctx = getRsvAuth(c)
	const body = await readNormalizedBody(c)
	checkExplicitLocations(c, body)
	const db = await getTenantDb(ctx.orgId)
	if (typeof body.serviceId === 'string' && body.serviceId.trim()) {
		await requireServiceLocationAccess(c, db, body.serviceId.trim())
	}
	const parsed = parseSchemaOrThrow(setupPacingRuleInputSchema, body)
	await requireServiceLocationAccess(c, db, parsed.serviceId)
	const res = await createPacingRuleForLocation(db, {
		actorId: ctx.userId,
		...parsed,
	})
	return json({ ...res.pacingRule, ...res }, 201)
})

const updatePacingHandler = wrapHandler(async (c) => {
	const ctx = getRsvAuth(c)
	const body = await readNormalizedBody(c)
	checkExplicitLocations(c, body)
	const ruleId = c.req.param('id')!
	const db = await getTenantDb(ctx.orgId)
	const current = await db
		.select()
		.from(rsvPacingRules)
		.where(eq(rsvPacingRules.id, ruleId))
		.get()
	if (!current) throw notFound('Pacing rule not found')
	await requireServiceLocationAccess(c, db, current.serviceId)
	const parsed = parseSchemaOrThrow(setupPacingRuleUpdateSchema, body)
	const res = await updatePacingRuleForLocation(db, ruleId, {
		actorId: ctx.userId,
		...parsed,
	})
	return json({ ...res.pacingRule, ...res })
})

const deletePacingHandler = wrapHandler(async (c) => {
	const ctx = getRsvAuth(c)
	checkExplicitLocations(c)
	const ruleId = c.req.param('id')!
	const db = await getTenantDb(ctx.orgId)
	const current = await db
		.select()
		.from(rsvPacingRules)
		.where(eq(rsvPacingRules.id, ruleId))
		.get()
	if (!current) throw notFound('Pacing rule not found')
	await requireServiceLocationAccess(c, db, current.serviceId)
	const result = await deletePacingRuleForLocation(db, ruleId, ctx.userId)
	return json(result)
})

operatorReservationsSetupRoutes.get(
	'/pacing',
	readSetupGuard,
	listPacingHandler,
)
operatorReservationsSetupRoutes.get(
	'/pacing-rules',
	readSetupGuard,
	listPacingHandler,
)
operatorReservationsSetupRoutes.get(
	'/locations/:locationId/pacing',
	readSetupGuard,
	listPacingHandler,
)
operatorReservationsSetupRoutes.get(
	'/locations/:locationId/pacing-rules',
	readSetupGuard,
	listPacingHandler,
)
operatorReservationsSetupRoutes.post(
	'/pacing',
	writeSetupGuard,
	createPacingHandler,
)
operatorReservationsSetupRoutes.post(
	'/pacing-rules',
	writeSetupGuard,
	createPacingHandler,
)
operatorReservationsSetupRoutes.post(
	'/locations/:locationId/pacing',
	writeSetupGuard,
	createPacingHandler,
)
operatorReservationsSetupRoutes.post(
	'/locations/:locationId/pacing-rules',
	writeSetupGuard,
	createPacingHandler,
)
operatorReservationsSetupRoutes.put(
	'/pacing/:id',
	writeSetupGuard,
	updatePacingHandler,
)
operatorReservationsSetupRoutes.patch(
	'/pacing/:id',
	writeSetupGuard,
	updatePacingHandler,
)
operatorReservationsSetupRoutes.put(
	'/pacing-rules/:id',
	writeSetupGuard,
	updatePacingHandler,
)
operatorReservationsSetupRoutes.patch(
	'/pacing-rules/:id',
	writeSetupGuard,
	updatePacingHandler,
)
operatorReservationsSetupRoutes.delete(
	'/pacing/:id',
	writeSetupGuard,
	deletePacingHandler,
)
operatorReservationsSetupRoutes.delete(
	'/pacing-rules/:id',
	writeSetupGuard,
	deletePacingHandler,
)

// ============================================================================
// Service Availability CRUD
// ============================================================================

const listServiceAvailabilityHandler = wrapHandler(async (c) => {
	const ctx = getRsvAuth(c)
	checkExplicitLocations(c)
	const serviceId = c.req.query('serviceId') ?? c.req.query('service_id')
	const db = await getTenantDb(ctx.orgId)
	if (serviceId) {
		const svc = await requireServiceLocationAccess(c, db, serviceId)
		const items = await listServiceAvailabilityForLocation(
			db,
			svc.locationId,
			serviceId,
		)
		return json({
			locationId: svc.locationId,
			serviceAvailability: items,
			service_availability: items,
			rules: items,
			items,
		})
	}
	const locationId = requireLocationId(c)
	const items = await listServiceAvailabilityForLocation(db, locationId)
	return json({
		locationId,
		serviceAvailability: items,
		service_availability: items,
		rules: items,
		items,
	})
})

const createServiceAvailabilityHandler = wrapHandler(async (c) => {
	const ctx = getRsvAuth(c)
	const body = await readNormalizedBody(c)
	checkExplicitLocations(c, body)
	const db = await getTenantDb(ctx.orgId)
	if (typeof body.serviceId === 'string' && body.serviceId.trim()) {
		await requireServiceLocationAccess(c, db, body.serviceId.trim())
	}
	const parsed = parseSchemaOrThrow(setupServiceAvailabilityInputSchema, body)
	await requireServiceLocationAccess(c, db, parsed.serviceId)
	const item = await upsertServiceAvailabilityForLocation(db, {
		actorId: ctx.userId,
		...parsed,
	})
	return json({ ...item, serviceAvailability: item, rule: item, item }, 201)
})

const updateServiceAvailabilityHandler = wrapHandler(async (c) => {
	const ctx = getRsvAuth(c)
	const body = await readNormalizedBody(c)
	checkExplicitLocations(c, body)
	const id = c.req.param('id')!
	const db = await getTenantDb(ctx.orgId)
	const current = await db
		.select()
		.from(rsvServiceAvailability)
		.where(eq(rsvServiceAvailability.id, id))
		.get()
	if (!current) throw notFound('Service availability rule not found')
	await requireServiceLocationAccess(c, db, current.serviceId)
	const parsed = parseSchemaOrThrow(setupServiceAvailabilityUpdateSchema, body)
	if (parsed.mode) {
		await db
			.update(rsvServiceAvailability)
			.set({
				mode: parsed.mode,
				...(parsed.fromMin !== undefined ? { fromMin: parsed.fromMin } : {}),
				...(parsed.toMin !== undefined ? { toMin: parsed.toMin } : {}),
			})
			.where(eq(rsvServiceAvailability.id, id))
	}
	const updated = await db
		.select()
		.from(rsvServiceAvailability)
		.where(eq(rsvServiceAvailability.id, id))
		.get()
	return json({ ...updated, serviceAvailability: updated, rule: updated })
})

const deleteServiceAvailabilityHandler = wrapHandler(async (c) => {
	const ctx = getRsvAuth(c)
	checkExplicitLocations(c)
	const id = c.req.param('id')!
	const db = await getTenantDb(ctx.orgId)
	const current = await db
		.select()
		.from(rsvServiceAvailability)
		.where(eq(rsvServiceAvailability.id, id))
		.get()
	if (!current) throw notFound('Service availability rule not found')
	await requireServiceLocationAccess(c, db, current.serviceId)
	const result = await deleteServiceAvailabilityForLocation(db, id, ctx.userId)
	return json(result)
})

operatorReservationsSetupRoutes.get(
	'/service-availability',
	readSetupGuard,
	listServiceAvailabilityHandler,
)
operatorReservationsSetupRoutes.get(
	'/locations/:locationId/service-availability',
	readSetupGuard,
	listServiceAvailabilityHandler,
)
operatorReservationsSetupRoutes.post(
	'/service-availability',
	writeSetupGuard,
	createServiceAvailabilityHandler,
)
operatorReservationsSetupRoutes.put(
	'/service-availability',
	writeSetupGuard,
	createServiceAvailabilityHandler,
)
operatorReservationsSetupRoutes.post(
	'/locations/:locationId/service-availability',
	writeSetupGuard,
	createServiceAvailabilityHandler,
)
operatorReservationsSetupRoutes.put(
	'/locations/:locationId/service-availability',
	writeSetupGuard,
	createServiceAvailabilityHandler,
)
operatorReservationsSetupRoutes.put(
	'/service-availability/:id',
	writeSetupGuard,
	updateServiceAvailabilityHandler,
)
operatorReservationsSetupRoutes.patch(
	'/service-availability/:id',
	writeSetupGuard,
	updateServiceAvailabilityHandler,
)
operatorReservationsSetupRoutes.delete(
	'/service-availability/:id',
	writeSetupGuard,
	deleteServiceAvailabilityHandler,
)

// ============================================================================
// Special Days CRUD
// ============================================================================

const listSpecialDaysHandler = wrapHandler(async (c) => {
	const ctx = getRsvAuth(c)
	const locationId = requireLocationId(c)
	const db = await getTenantDb(ctx.orgId)
	const specialDays = await listSpecialDaysForLocation(db, locationId)
	return json({
		locationId,
		specialDays,
		special_days: specialDays,
	})
})

const createSpecialDayHandler = wrapHandler(async (c) => {
	const ctx = getRsvAuth(c)
	const body = await readNormalizedBody(c)
	const locationId = requireLocationId(c, body)
	const parsed = parseSchemaOrThrow(setupSpecialDayInputSchema, {
		...body,
		locationId,
		toDate: body.toDate ?? body.fromDate ?? body.businessDate ?? body.date,
		fromDate: body.fromDate ?? body.businessDate ?? body.date,
	})
	const db = await getTenantDb(ctx.orgId)
	const result = await createSpecialDayForLocation(db, {
		actorId: ctx.userId,
		...parsed,
		locationId,
	})
	return json({ ...result.specialDay, ...result }, 201)
})

const updateSpecialDayHandler = wrapHandler(async (c) => {
	const ctx = getRsvAuth(c)
	const body = await readNormalizedBody(c)
	checkExplicitLocations(c, body)
	const id = c.req.param('id')!
	const db = await getTenantDb(ctx.orgId)
	const current = await db
		.select()
		.from(rsvSpecialDays)
		.where(eq(rsvSpecialDays.id, id))
		.get()
	if (!current) throw notFound('Special day not found')
	assertAllowedLocation(c, current.locationId)
	const parsed = parseSchemaOrThrow(setupSpecialDayUpdateSchema, body)
	const result = await updateSpecialDayForLocation(db, id, {
		actorId: ctx.userId,
		...parsed,
	})
	return json({ ...result.specialDay, ...result })
})

const deleteSpecialDayHandler = wrapHandler(async (c) => {
	const ctx = getRsvAuth(c)
	checkExplicitLocations(c)
	const id = c.req.param('id')!
	const db = await getTenantDb(ctx.orgId)
	const current = await db
		.select()
		.from(rsvSpecialDays)
		.where(eq(rsvSpecialDays.id, id))
		.get()
	if (!current) throw notFound('Special day not found')
	assertAllowedLocation(c, current.locationId)
	const result = await deleteSpecialDayForLocation(
		db,
		id,
		ctx.userId,
		current.locationId,
	)
	return json(result)
})

operatorReservationsSetupRoutes.get(
	'/special-days',
	readSetupGuard,
	listSpecialDaysHandler,
)
operatorReservationsSetupRoutes.get(
	'/locations/:locationId/special-days',
	readSetupGuard,
	listSpecialDaysHandler,
)
operatorReservationsSetupRoutes.post(
	'/special-days',
	writeSetupGuard,
	createSpecialDayHandler,
)
operatorReservationsSetupRoutes.post(
	'/locations/:locationId/special-days',
	writeSetupGuard,
	createSpecialDayHandler,
)
operatorReservationsSetupRoutes.put(
	'/special-days/:id',
	writeSetupGuard,
	updateSpecialDayHandler,
)
operatorReservationsSetupRoutes.patch(
	'/special-days/:id',
	writeSetupGuard,
	updateSpecialDayHandler,
)
operatorReservationsSetupRoutes.put(
	'/locations/:locationId/special-days/:id',
	writeSetupGuard,
	updateSpecialDayHandler,
)
operatorReservationsSetupRoutes.delete(
	'/special-days/:id',
	writeSetupGuard,
	deleteSpecialDayHandler,
)
operatorReservationsSetupRoutes.delete(
	'/locations/:locationId/special-days/:id',
	writeSetupGuard,
	deleteSpecialDayHandler,
)

// ============================================================================
// Table & Area Blocks CRUD
// ============================================================================

const listBlocksHandler = wrapHandler(async (c) => {
	const ctx = getRsvAuth(c)
	const locationId = requireLocationId(c)
	const date =
		c.req.query('date') ??
		c.req.query('businessDate') ??
		c.req.query('business_date') ??
		undefined
	const db = await getTenantDb(ctx.orgId)
	const blocks = await listBlocksForLocation(db, locationId, date)
	return json({ locationId, blocks })
})

const createBlockHandler = wrapHandler(async (c) => {
	const ctx = getRsvAuth(c)
	const body = await readNormalizedBody(c)
	const locationId = requireLocationId(c, body)
	const parsed = parseSchemaOrThrow(setupBlockInputSchema, {
		...body,
		locationId,
	})
	const db = await getTenantDb(ctx.orgId)
	const result = await createBlockForLocation(db, {
		actorId: ctx.userId,
		...parsed,
		locationId,
	})
	return json({ ...result.block, ...result }, 201)
})

const deleteBlockHandler = wrapHandler(async (c) => {
	const ctx = getRsvAuth(c)
	checkExplicitLocations(c)
	const blockId = c.req.param('id')!
	const db = await getTenantDb(ctx.orgId)
	const current = await db
		.select()
		.from(rsvBlocks)
		.where(eq(rsvBlocks.id, blockId))
		.get()
	if (!current) throw notFound('Block not found')
	assertAllowedLocation(c, current.locationId)
	const result = await deleteBlockForLocation(
		db,
		blockId,
		ctx.userId,
		current.locationId,
	)
	return json(result)
})

operatorReservationsSetupRoutes.get(
	'/blocks',
	readSetupGuard,
	listBlocksHandler,
)
operatorReservationsSetupRoutes.get(
	'/locations/:locationId/blocks',
	readSetupGuard,
	listBlocksHandler,
)
operatorReservationsSetupRoutes.post(
	'/blocks',
	writeSetupGuard,
	createBlockHandler,
)
operatorReservationsSetupRoutes.post(
	'/locations/:locationId/blocks',
	writeSetupGuard,
	createBlockHandler,
)
operatorReservationsSetupRoutes.delete(
	'/blocks/:id',
	writeSetupGuard,
	deleteBlockHandler,
)
operatorReservationsSetupRoutes.delete(
	'/locations/:locationId/blocks/:id',
	writeSetupGuard,
	deleteBlockHandler,
)

// ============================================================================
// Validation, Conflicts, and Rederive Times
// ============================================================================

const validateSetupHandler = wrapHandler(async (c) => {
	const ctx = getRsvAuth(c)
	const locationId = requireLocationId(c)
	const db = await getTenantDb(ctx.orgId)
	const result = await validateLocationSetup(db, ctx.orgId, locationId)
	return json({
		locationId,
		...result,
	})
})

operatorReservationsSetupRoutes.get(
	'/locations/:locationId/validation',
	readSetupGuard,
	validateSetupHandler,
)
operatorReservationsSetupRoutes.get(
	'/locations/:locationId/validate',
	readSetupGuard,
	validateSetupHandler,
)
operatorReservationsSetupRoutes.get(
	'/validation',
	readSetupGuard,
	validateSetupHandler,
)
operatorReservationsSetupRoutes.get(
	'/validate',
	readSetupGuard,
	validateSetupHandler,
)

const conflictsSetupHandler = wrapHandler(async (c) => {
	const ctx = getRsvAuth(c)
	const locationId = requireLocationId(c)
	const dateParam =
		c.req.query('date') ??
		c.req.query('businessDate') ??
		c.req.query('business_date') ??
		undefined
	const fromParam = c.req.query('from') ?? c.req.query('fromDate') ?? undefined
	const toParam = c.req.query('to') ?? c.req.query('toDate') ?? undefined
	const db = await getTenantDb(ctx.orgId)
	const result = await detectLocationConflicts(db, locationId, {
		date: dateParam,
		from: fromParam,
		to: toParam,
	})
	return json({
		locationId,
		...result,
	})
})

operatorReservationsSetupRoutes.get(
	'/locations/:locationId/conflicts',
	readSetupGuard,
	conflictsSetupHandler,
)
operatorReservationsSetupRoutes.get(
	'/conflicts',
	readSetupGuard,
	conflictsSetupHandler,
)

const rederiveTimesHandler = wrapHandler(async (c) => {
	const ctx = getRsvAuth(c)
	let body: Record<string, unknown> = {}
	const rawText = await c.req.text()
	if (rawText.trim().length > 0) {
		try {
			const parsedJson = JSON.parse(rawText) as unknown
			if (
				parsedJson &&
				typeof parsedJson === 'object' &&
				!Array.isArray(parsedJson)
			) {
				body = normalizeInputKeys(parsedJson) as Record<string, unknown>
			}
		} catch {
			throw badRequest('invalid_json', 'Request body must be valid JSON')
		}
	}
	const locationId = requireLocationId(c, body)
	const timeZone =
		typeof body.timeZone === 'string' && body.timeZone.trim()
			? body.timeZone.trim()
			: undefined
	const db = await getTenantDb(ctx.orgId)
	const result = await rederiveLocationTimes(
		db,
		ctx.orgId,
		locationId,
		ctx.userId,
		timeZone,
	)
	return json({
		locationId,
		...result,
	})
})

operatorReservationsSetupRoutes.post(
	'/locations/:locationId/rederive-times',
	writeSetupGuard,
	rederiveTimesHandler,
)
operatorReservationsSetupRoutes.post(
	'/rederive-times',
	writeSetupGuard,
	rederiveTimesHandler,
)

// ============================================================================
// Section Layouts CRUD
// ============================================================================

const setupSectionLayoutSchema = z.object({
	locationId: z.string().min(1),
	name: z.string().trim().min(1),
	serviceId: z.string().nullable().optional(),
	isDefault: z.boolean().optional(),
	sections: z
		.array(
			z.object({
				id: z.string().optional(),
				name: z.string().trim().min(1),
				colorToken: z.string().optional(),
				sort: z.number().int().optional(),
				sortOrder: z.number().int().optional(),
				tableIds: z.array(z.string()).optional(),
			}),
		)
		.default([]),
})

const setupSectionLayoutPatchSchema = z.object({
	name: z.string().trim().min(1).optional(),
	serviceId: z.string().nullable().optional(),
	isDefault: z.boolean().optional(),
	sections: z
		.array(
			z.object({
				id: z.string().optional(),
				name: z.string().trim().min(1),
				colorToken: z.string().optional(),
				sort: z.number().int().optional(),
				sortOrder: z.number().int().optional(),
				tableIds: z.array(z.string()).optional(),
			}),
		)
		.optional(),
})

const listSectionLayoutsHandler = wrapHandler(async (c) => {
	const ctx = getRsvAuth(c)
	const locationId = requireLocationId(c)
	const db = await getTenantDb(ctx.orgId)
	const layouts = await listSectionLayoutsForLocation(db, locationId)
	return json({ locationId, layouts, sectionLayouts: layouts })
})

const createSectionLayoutHandler = wrapHandler(async (c) => {
	const ctx = getRsvAuth(c)
	const body = await readNormalizedBody(c)
	const locationId = requireLocationId(c, body)
	const parsed = parseSchemaOrThrow(setupSectionLayoutSchema, {
		...body,
		locationId,
	})
	const db = await getTenantDb(ctx.orgId)
	const res = await createSectionLayoutForLocation(db, {
		actorId: ctx.userId,
		...parsed,
	})
	return json({ ...res.layout, ...res }, 201)
})

const updateSectionLayoutHandler = wrapHandler(async (c) => {
	const ctx = getRsvAuth(c)
	checkExplicitLocations(c)
	const layoutId = c.req.param('id')!
	const body = await readNormalizedBody(c)
	const db = await getTenantDb(ctx.orgId)
	const current = await db
		.select()
		.from(rsvSectionLayouts)
		.where(eq(rsvSectionLayouts.id, layoutId))
		.get()
	if (!current || current.archivedAt !== null) {
		throw notFound('Section layout not found')
	}
	assertAllowedLocation(c, current.locationId)
	const parsed = parseSchemaOrThrow(setupSectionLayoutPatchSchema, body)
	const res = await updateSectionLayoutForLocation(db, layoutId, {
		actorId: ctx.userId,
		locationId: current.locationId,
		...parsed,
	})
	return json({ ...res.layout, ...res })
})

const deleteSectionLayoutHandler = wrapHandler(async (c) => {
	const ctx = getRsvAuth(c)
	checkExplicitLocations(c)
	const layoutId = c.req.param('id')!
	const db = await getTenantDb(ctx.orgId)
	const current = await db
		.select()
		.from(rsvSectionLayouts)
		.where(eq(rsvSectionLayouts.id, layoutId))
		.get()
	if (!current || current.archivedAt !== null) {
		throw notFound('Section layout not found')
	}
	assertAllowedLocation(c, current.locationId)
	const res = await deleteSectionLayoutForLocation(
		db,
		layoutId,
		ctx.userId,
		current.locationId,
	)
	return json(res)
})

operatorReservationsSetupRoutes.get(
	'/locations/:locationId/sections',
	readSetupGuard,
	listSectionLayoutsHandler,
)
operatorReservationsSetupRoutes.get(
	'/sections/layouts',
	readSetupGuard,
	listSectionLayoutsHandler,
)
operatorReservationsSetupRoutes.get(
	'/sections',
	readSetupGuard,
	listSectionLayoutsHandler,
)
operatorReservationsSetupRoutes.post(
	'/locations/:locationId/sections',
	writeSetupGuard,
	createSectionLayoutHandler,
)
operatorReservationsSetupRoutes.post(
	'/sections/layouts',
	writeSetupGuard,
	createSectionLayoutHandler,
)
operatorReservationsSetupRoutes.post(
	'/sections',
	writeSetupGuard,
	createSectionLayoutHandler,
)
operatorReservationsSetupRoutes.put(
	'/locations/:locationId/sections/:id',
	writeSetupGuard,
	updateSectionLayoutHandler,
)
operatorReservationsSetupRoutes.patch(
	'/locations/:locationId/sections/:id',
	writeSetupGuard,
	updateSectionLayoutHandler,
)
operatorReservationsSetupRoutes.put(
	'/sections/layouts/:id',
	writeSetupGuard,
	updateSectionLayoutHandler,
)
operatorReservationsSetupRoutes.patch(
	'/sections/layouts/:id',
	writeSetupGuard,
	updateSectionLayoutHandler,
)
operatorReservationsSetupRoutes.put(
	'/sections/:id',
	writeSetupGuard,
	updateSectionLayoutHandler,
)
operatorReservationsSetupRoutes.patch(
	'/sections/:id',
	writeSetupGuard,
	updateSectionLayoutHandler,
)
operatorReservationsSetupRoutes.delete(
	'/locations/:locationId/sections/:id',
	writeSetupGuard,
	deleteSectionLayoutHandler,
)
operatorReservationsSetupRoutes.delete(
	'/sections/layouts/:id',
	writeSetupGuard,
	deleteSectionLayoutHandler,
)
operatorReservationsSetupRoutes.delete(
	'/sections/:id',
	writeSetupGuard,
	deleteSectionLayoutHandler,
)
