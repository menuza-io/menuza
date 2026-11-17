import {
	AUDIENCE_LIMITS,
	audienceDefinitionSchema,
	floorAudienceCount,
	READY_MADE_AUDIENCES,
	type AudienceCounts,
	type AudienceDefinition,
	type AudienceErrorCode,
} from '@repo/common/marketing-audiences'
import {
	customers,
	marketingAudiences,
	marketingCampaigns,
	marketingJourneys,
	marketingSettings,
	type TenantDatabase,
	type TenantTransaction,
} from '@repo/tenant-db'
import { and, count, eq, inArray, ne, sql } from 'drizzle-orm'
import { loadBroadcastAudience } from './marketing-audience.ts'
import { compileAudience } from './marketing-audience-rules.ts'

/**
 * Saved audiences (#98): CRUD, counts, and the send-time lookup. Definitions
 * hold numbers and ids only. Counts never carry a guest, and any count below
 * the floor is returned as `null` ("fewer than 5").
 */

export type AudienceResult<T> =
	{ ok: true; value: T } | { ok: false; error: AudienceErrorCode }

const fail = (
	error: AudienceErrorCode,
): { ok: false; error: AudienceErrorCode } => ({
	ok: false,
	error,
})

export type AudienceRecord = {
	id: string
	name: string
	definition: AudienceDefinition
	version: number
	systemKey: string | null
	createdAt: number
	updatedAt: number
}

function parseDefinition(raw: unknown): AudienceDefinition | null {
	try {
		const value = typeof raw === 'string' ? JSON.parse(raw) : raw
		const parsed = audienceDefinitionSchema.safeParse(value)
		return parsed.success ? parsed.data : null
	} catch {
		return null
	}
}

function toRecord(
	row: typeof marketingAudiences.$inferSelect,
): AudienceRecord | null {
	const definition = parseDefinition(row.definition)
	if (!definition) return null
	return {
		id: row.id,
		name: row.name,
		definition,
		version: row.version,
		systemKey: row.systemKey,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	}
}

const SEEDED_KEY = 'audiences_seeded'

/**
 * The ready-made audiences, added once on the first visit. An operator may edit
 * or delete them; a deleted one is never added back.
 */
export async function ensureReadyMadeAudiences(db: TenantDatabase) {
	const seeded = await db
		.select({ key: marketingSettings.key })
		.from(marketingSettings)
		.where(eq(marketingSettings.key, SEEDED_KEY))
		.get()
	if (seeded) return
	for (const audience of READY_MADE_AUDIENCES) {
		await db
			.insert(marketingAudiences)
			.values({
				name: audience.name,
				definition: audience.definition,
				systemKey: audience.key,
			})
			.onConflictDoNothing()
	}
	await db
		.insert(marketingSettings)
		.values({ key: SEEDED_KEY, value: true })
		.onConflictDoNothing()
}

export async function listAudiences(db: TenantDatabase) {
	await ensureReadyMadeAudiences(db)
	const rows = await db
		.select()
		.from(marketingAudiences)
		.orderBy(marketingAudiences.name)
		.all()
	return rows.flatMap((row) => {
		const record = toRecord(row)
		return record ? [record] : []
	})
}

export async function getAudience(
	db: TenantDatabase | TenantTransaction,
	id: string,
): Promise<AudienceRecord | null> {
	const row = await db
		.select()
		.from(marketingAudiences)
		.where(eq(marketingAudiences.id, id))
		.get()
	return row ? toRecord(row) : null
}

/** Drizzle wraps the driver error: the constraint message is on `cause`. */
export function isUniqueViolation(error: unknown, depth = 0): boolean {
	if (!(error instanceof Error) || depth > 4) return false
	return (
		error.message.includes('UNIQUE constraint failed') ||
		error.message.includes('SQLITE_CONSTRAINT_UNIQUE') ||
		isUniqueViolation(error.cause, depth + 1)
	)
}

export async function createAudience(
	db: TenantDatabase,
	input: { name: string; definition: AudienceDefinition; createdBy?: string },
): Promise<AudienceResult<AudienceRecord>> {
	const [existing] = await db.select({ n: count() }).from(marketingAudiences)
	if ((existing?.n ?? 0) >= AUDIENCE_LIMITS.audiences)
		return fail('audience_limit')
	try {
		const [row] = await db
			.insert(marketingAudiences)
			.values({
				name: input.name,
				definition: input.definition,
				createdBy: input.createdBy ?? null,
			})
			.returning()
		const record = row ? toRecord(row) : null
		return record ? { ok: true, value: record } : fail('invalid_audience')
	} catch (error) {
		if (isUniqueViolation(error)) return fail('audience_name_taken')
		throw error
	}
}

export async function updateAudience(
	db: TenantDatabase,
	id: string,
	input: {
		name: string
		definition: AudienceDefinition
		expectedVersion?: number
	},
): Promise<AudienceResult<AudienceRecord>> {
	const current = await db
		.select({ version: marketingAudiences.version })
		.from(marketingAudiences)
		.where(eq(marketingAudiences.id, id))
		.get()
	if (!current) return fail('audience_not_found')
	if (
		input.expectedVersion !== undefined &&
		input.expectedVersion !== current.version
	) {
		return fail('audience_version_changed')
	}
	try {
		// One compare-and-set on the version that was read.
		const [row] = await db
			.update(marketingAudiences)
			.set({
				name: input.name,
				definition: input.definition,
				version: current.version + 1,
				updatedAt: Date.now(),
			})
			.where(
				and(
					eq(marketingAudiences.id, id),
					eq(marketingAudiences.version, current.version),
				),
			)
			.returning()
		if (!row) return fail('audience_version_changed')
		const record = toRecord(row)
		return record ? { ok: true, value: record } : fail('invalid_audience')
	} catch (error) {
		if (isUniqueViolation(error)) return fail('audience_name_taken')
		throw error
	}
}

function ruleAudienceId(raw: unknown): string | null {
	try {
		const rules = typeof raw === 'string' ? JSON.parse(raw) : raw
		const id = (rules as { audienceId?: unknown } | null)?.audienceId
		return typeof id === 'string' ? id : null
	} catch {
		return null
	}
}

/** Where an audience is used: broadcasts not yet finished, and automations that are not archived. */
export async function audienceUsage(db: TenantDatabase, id: string) {
	const campaigns = await db
		.select({
			id: marketingCampaigns.id,
			name: marketingCampaigns.name,
			segmentationRules: marketingCampaigns.segmentationRules,
		})
		.from(marketingCampaigns)
		.where(
			inArray(marketingCampaigns.status, ['Draft', 'Scheduled', 'Processing']),
		)
		.all()
	const journeys = await db
		.select({
			id: marketingJourneys.id,
			name: marketingJourneys.name,
			nodes: marketingJourneys.nodes,
		})
		.from(marketingJourneys)
		.where(ne(marketingJourneys.status, 'archived'))
		.all()
	return {
		broadcasts: campaigns
			.filter((c) => ruleAudienceId(c.segmentationRules) === id)
			.map((c) => ({ id: c.id, name: c.name })),
		automations: journeys
			.filter((j) => nodesUseAudience(j.nodes, id))
			.map((j) => ({ id: j.id, name: j.name })),
	}
}

/** Condition nodes that ask "guest is in audience X" keep the id in `value`. */
export function nodesUseAudience(rawNodes: unknown, id: string): boolean {
	try {
		const nodes = typeof rawNodes === 'string' ? JSON.parse(rawNodes) : rawNodes
		if (!Array.isArray(nodes)) return false
		return nodes.some((node) => {
			const data = node as { type?: string; data?: Record<string, unknown> }
			return (
				data.type === 'condition' &&
				data.data?.field === 'audience' &&
				data.data?.value === id
			)
		})
	} catch {
		return false
	}
}

export async function deleteAudience(
	db: TenantDatabase,
	id: string,
): Promise<AudienceResult<null>> {
	const record = await getAudience(db, id)
	if (!record) return fail('audience_not_found')
	const usage = await audienceUsage(db, id)
	if (usage.broadcasts.length > 0 || usage.automations.length > 0) {
		return fail('audience_in_use')
	}
	await db.delete(marketingAudiences).where(eq(marketingAudiences.id, id))
	return { ok: true, value: null }
}

/** Counts for a definition: everyone matching, and who may be emailed or texted now. Floored. */
export async function countAudience(
	db: TenantDatabase,
	definition: AudienceDefinition,
	now: number = Date.now(),
): Promise<AudienceCounts> {
	const where = compileAudience(definition, now)
	const [size] = await db
		.select({ n: count() })
		.from(customers)
		.where(sql`${where}`)
	const [email, sms] = await Promise.all([
		loadBroadcastAudience(db, { channel: 'email', audienceWhere: where }),
		loadBroadcastAudience(db, { channel: 'sms', audienceWhere: where }),
	])
	return {
		size: floorAudienceCount(size?.n ?? 0),
		email: floorAudienceCount(email.length),
		sms: floorAudienceCount(sms.length),
	}
}

/**
 * The condition a send uses for a saved audience, read now (membership is
 * never cached across sends). `null`: the audience is gone, so nothing may be
 * sent to it (the caller fails the send rather than widening it to everyone).
 */
export async function resolveAudienceWhere(
	db: TenantDatabase | TenantTransaction,
	audienceId: string,
	now: number = Date.now(),
) {
	const record = await getAudience(db, audienceId)
	if (!record) return null
	return { where: compileAudience(record.definition, now), record }
}

/** Whether one guest is in a saved audience now (the automation condition). */
export async function customerInAudience(
	db: TenantDatabase | TenantTransaction,
	audienceId: string,
	customerId: string,
	now: number = Date.now(),
): Promise<boolean | null> {
	const resolved = await resolveAudienceWhere(db, audienceId, now)
	if (!resolved) return null
	const row = await db
		.select({ id: customers.id })
		.from(customers)
		.where(and(eq(customers.id, customerId), sql`${resolved.where}`))
		.get()
	return Boolean(row)
}
