import {
	and,
	asc,
	count,
	db,
	desc,
	Discount,
	DiscountCode,
	eq,
	inArray,
	isNull,
	ne,
	User,
} from '@repo/database'
import {
	type DiscountDefinition,
	DISCOUNT_NAME_MAX,
	discountDefinitionSchema,
	type DiscountStatus,
	normalizeDiscountCode,
} from '@repo/discounts'
import { type CodeInput, type StoredCode } from './editor-model.ts'

/**
 * Control-plane reads and writes for discounts. Definitions live in D1 as one
 * row each, with the nested parts as JSON columns that `discountDefinitionSchema`
 * validates. Every save bumps `version` and compares `expectedVersion`.
 */

type DiscountRow = typeof Discount.$inferSelect

/**
 * The most discounts an organization keeps that are not archived, and the most
 * unarchived codes. They match what `GET /resources/order-context` can carry
 * (`order-context.server.ts` keeps the oldest and drops the rest), so nothing
 * an operator saves is silently left out of ordering.
 */
export const MAX_DISCOUNTS_PER_ORG = 500
export const MAX_CODES_PER_ORG = 2000

async function countLiveDiscounts(organizationId: string): Promise<number> {
	const [row] = await db
		.select({ n: count() })
		.from(Discount)
		.where(
			and(
				eq(Discount.organizationId, organizationId),
				ne(Discount.status, 'archived'),
			),
		)
	return Number(row?.n ?? 0)
}

/** Unarchived codes of the organization, not counting one discount's own. */
async function countLiveCodes(
	organizationId: string,
	exceptDiscountId: string | null,
): Promise<number> {
	const [row] = await db
		.select({ n: count() })
		.from(DiscountCode)
		.where(
			and(
				eq(DiscountCode.organizationId, organizationId),
				isNull(DiscountCode.archivedAt),
				exceptDiscountId
					? ne(DiscountCode.discountId, exceptDiscountId)
					: undefined,
			),
		)
	return Number(row?.n ?? 0)
}

/** Whether `codes` more codes still fit under the organization's cap. */
async function codesFit(
	organizationId: string,
	exceptDiscountId: string | null,
	codes: number,
): Promise<boolean> {
	if (codes === 0) return true
	return (
		(await countLiveCodes(organizationId, exceptDiscountId)) + codes <=
		MAX_CODES_PER_ORG
	)
}

export type StoredDiscount = {
	id: string
	version: number
	definition: DiscountDefinition
	createdAt: Date
	updatedAt: Date
}

function parseJson(value: string | null): unknown {
	if (value === null) return null
	try {
		return JSON.parse(value) as unknown
	} catch {
		return undefined
	}
}

/** The row as a validated definition, or null when a column no longer parses. */
export function definitionFromRow(row: DiscountRow): DiscountDefinition | null {
	const parsed = discountDefinitionSchema.safeParse({
		name: row.name,
		internalName: row.internalName,
		description: row.description,
		status: row.status,
		application: row.application,
		valueType: row.valueType,
		percentBp: row.percentBp,
		amountMinor: row.amountMinor,
		currency: row.currency,
		maxDiscountMinor: row.maxDiscountMinor,
		target: parseJson(row.target),
		requirement: parseJson(row.requirement),
		quantityRule: parseJson(row.quantityRule),
		maxDiscountedUnits: row.maxDiscountedUnits,
		minSubtotalMinor: row.minSubtotalMinor,
		locationIds: parseJson(row.locationIds),
		channels: parseJson(row.channels),
		fulfillments: parseJson(row.fulfillments),
		includeDrops: row.includeDrops,
		schedule: parseJson(row.schedule),
		startsAt: row.startsAt,
		endsAt: row.endsAt,
		eligibility: row.eligibility,
		totalLimit: row.totalLimit,
		perCustomerLimit: parseJson(row.perCustomerLimit),
		combinable: row.combinable,
		// Null and missing both mean "the switch decides".
		combinesWith: parseJson(row.combinesWith) ?? undefined,
		tiers: parseJson(row.tiers),
		maxDeliveryFeeMinor: row.maxDeliveryFeeMinor,
		priority: row.priority,
		promoteOnMenu: row.promoteOnMenu,
		requireApproval: row.requireApproval,
	})
	return parsed.success ? parsed.data : null
}

function jsonOrNull(value: unknown): string | null {
	return value === null ? null : JSON.stringify(value)
}

function columnsFor(definition: DiscountDefinition) {
	return {
		name: definition.name,
		internalName: definition.internalName,
		description: definition.description,
		status: definition.status,
		application: definition.application,
		valueType: definition.valueType,
		percentBp: definition.percentBp,
		amountMinor: definition.amountMinor,
		currency: definition.currency,
		maxDiscountMinor: definition.maxDiscountMinor,
		target: JSON.stringify(definition.target),
		requirement: jsonOrNull(definition.requirement),
		quantityRule: JSON.stringify(definition.quantityRule),
		maxDiscountedUnits: definition.maxDiscountedUnits,
		minSubtotalMinor: definition.minSubtotalMinor,
		locationIds: jsonOrNull(definition.locationIds),
		channels: JSON.stringify(definition.channels),
		fulfillments: JSON.stringify(definition.fulfillments),
		includeDrops: definition.includeDrops,
		schedule: jsonOrNull(definition.schedule),
		startsAt: definition.startsAt,
		endsAt: definition.endsAt,
		eligibility: definition.eligibility,
		totalLimit: definition.totalLimit,
		perCustomerLimit: jsonOrNull(definition.perCustomerLimit),
		combinable: definition.combinable,
		combinesWith: definition.combinesWith
			? JSON.stringify(definition.combinesWith)
			: null,
		tiers: jsonOrNull(definition.tiers ?? null),
		maxDeliveryFeeMinor: definition.maxDeliveryFeeMinor ?? null,
		priority: definition.priority,
		promoteOnMenu: definition.promoteOnMenu,
		requireApproval: definition.requireApproval,
	}
}

export type DiscountListEntry = {
	id: string
	version: number
	/** Null when the stored row no longer validates (shown as needing a fix). */
	definition: DiscountDefinition | null
	name: string
	status: string
	application: string
	updatedAt: string
	codes: StoredCode[]
}

export async function listDiscounts(
	organizationId: string,
): Promise<DiscountListEntry[]> {
	const [rows, codes] = await Promise.all([
		db
			.select()
			.from(Discount)
			.where(eq(Discount.organizationId, organizationId))
			.orderBy(desc(Discount.updatedAt)),
		db
			.select()
			.from(DiscountCode)
			.where(
				and(
					eq(DiscountCode.organizationId, organizationId),
					isNull(DiscountCode.archivedAt),
				),
			)
			.orderBy(asc(DiscountCode.createdAt)),
	])
	return rows.map((row) => ({
		id: row.id,
		version: row.version,
		definition: definitionFromRow(row),
		name: row.name,
		status: row.status,
		application: row.application,
		updatedAt: row.updatedAt.toISOString(),
		codes: codes
			.filter((code) => code.discountId === row.id)
			.map((code) => ({
				id: code.id,
				code: code.code,
				maxUses: code.maxUses,
			})),
	}))
}

/** Display name for the operator who created the discount, if still known. */
export async function getDiscountCreatedBy(
	createdById: string | null,
): Promise<{ name: string } | null> {
	if (!createdById) return null
	const [user] = await db
		.select({ name: User.name, username: User.username })
		.from(User)
		.where(eq(User.id, createdById))
		.limit(1)
	const name = user?.name || user?.username
	return name ? { name } : null
}

export async function getDiscount(
	organizationId: string,
	discountId: string,
): Promise<{
	stored: StoredDiscount | null
	row: DiscountRow
	codes: StoredCode[]
} | null> {
	const [row] = await db
		.select()
		.from(Discount)
		.where(
			and(
				eq(Discount.id, discountId),
				eq(Discount.organizationId, organizationId),
			),
		)
		.limit(1)
	if (!row) return null
	const codes = await db
		.select()
		.from(DiscountCode)
		.where(
			and(
				eq(DiscountCode.discountId, row.id),
				eq(DiscountCode.organizationId, organizationId),
				isNull(DiscountCode.archivedAt),
			),
		)
		.orderBy(asc(DiscountCode.createdAt))
	const definition = definitionFromRow(row)
	return {
		stored: definition
			? {
					id: row.id,
					version: row.version,
					definition,
					createdAt: row.createdAt,
					updatedAt: row.updatedAt,
				}
			: null,
		row,
		codes: codes.map((code) => ({
			id: code.id,
			code: code.code,
			maxUses: code.maxUses,
		})),
	}
}

export type SaveFailure =
	| { ok: false; reason: 'stale' }
	| { ok: false; reason: 'not_found' }
	| { ok: false; reason: 'code_taken'; codeIndexes: number[] }
	| { ok: false; reason: 'no_codes' }
	| { ok: false; reason: 'archived' }
	/** The organization already has `MAX_DISCOUNTS_PER_ORG` discounts that are not archived. */
	| { ok: false; reason: 'too_many_discounts' }
	/** The organization already has `MAX_CODES_PER_ORG` unarchived codes. */
	| { ok: false; reason: 'too_many_codes' }

export type SaveSuccess = { ok: true; id: string; version: number }

const CODE_LOOKUP_CHUNK = 50

/** Indexes of `codes` another unarchived discount in the org already uses. */
async function takenCodeIndexes(
	organizationId: string,
	discountId: string | null,
	codes: readonly CodeInput[],
): Promise<number[]> {
	if (codes.length === 0) return []
	const normalized = codes.map((code) => normalizeDiscountCode(code.code))
	// D1 binds at most 100 parameters per statement.
	const rows: Array<{ normalizedCode: string; discountId: string }> = []
	for (let start = 0; start < normalized.length; start += CODE_LOOKUP_CHUNK) {
		rows.push(
			...(await db
				.select({
					normalizedCode: DiscountCode.normalizedCode,
					discountId: DiscountCode.discountId,
				})
				.from(DiscountCode)
				.where(
					and(
						eq(DiscountCode.organizationId, organizationId),
						isNull(DiscountCode.archivedAt),
						inArray(
							DiscountCode.normalizedCode,
							normalized.slice(start, start + CODE_LOOKUP_CHUNK),
						),
						discountId ? ne(DiscountCode.discountId, discountId) : undefined,
					),
				)),
		)
	}
	const taken = new Set(rows.map((row) => row.normalizedCode))
	return normalized.flatMap((value, index) => (taken.has(value) ? [index] : []))
}

function isUniqueViolation(error: unknown): boolean {
	const seen = new Set<unknown>()
	let current: unknown = error
	while (current && typeof current === 'object' && !seen.has(current)) {
		seen.add(current)
		if (/UNIQUE constraint failed/i.test(String((current as Error).message))) {
			return true
		}
		current = (current as { cause?: unknown }).cause
	}
	return false
}

/**
 * A code the editor has not saved yet has no id. Match it to the stored row
 * with the same normalized code so a second save updates that row instead of
 * archiving it and inserting a new one (which would reset its use count).
 */
export function reuseCodeIds(
	existing: ReadonlyArray<{ id: string; normalizedCode: string }>,
	codes: readonly CodeInput[],
): CodeInput[] {
	const claimed = new Set<string>()
	for (const code of codes) {
		if (code.id) claimed.add(code.id)
	}
	return codes.map((code) => {
		if (code.id) return code
		const normalized = normalizeDiscountCode(code.code)
		const match = existing.find(
			(row) => row.normalizedCode === normalized && !claimed.has(row.id),
		)
		if (!match) return code
		claimed.add(match.id)
		return { ...code, id: match.id }
	})
}

type Undo = () => Promise<void>

/** Run the undo steps newest first. One failing step must not stop the rest. */
async function runUndo(steps: readonly Undo[]) {
	for (const step of [...steps].reverse()) {
		try {
			await step()
		} catch {
			// Best effort: the original error is the one worth reporting.
		}
	}
}

/**
 * Make the discount's active codes match `codes`. D1 has no transaction here,
 * so the order is what keeps a failure harmless: new codes go in before any
 * old one is archived, a failure undoes what this call did, and the codes the
 * operator already had stay live until the new ones exist.
 */
async function syncCodes(
	organizationId: string,
	discountId: string,
	codes: readonly CodeInput[],
) {
	const existing = await db
		.select()
		.from(DiscountCode)
		.where(
			and(
				eq(DiscountCode.discountId, discountId),
				eq(DiscountCode.organizationId, organizationId),
				isNull(DiscountCode.archivedAt),
			),
		)
	const resolved = reuseCodeIds(existing, codes)
	const keep = new Map(
		resolved.flatMap((code) => (code.id ? [[code.id, code] as const] : [])),
	)
	const existingIds = new Set(existing.map((row) => row.id))
	const removed = existing.filter((row) => !keep.has(row.id))
	const changed: Array<{
		row: (typeof existing)[number]
		next: CodeInput
		normalized: string
	}> = []
	for (const row of existing) {
		const next = keep.get(row.id)
		if (!next) continue
		const normalized = normalizeDiscountCode(next.code)
		if (
			row.code !== next.code ||
			row.normalizedCode !== normalized ||
			row.maxUses !== next.maxUses
		) {
			changed.push({ row, next, normalized })
		}
	}
	const fresh = resolved.filter(
		(code) => !(code.id && existingIds.has(code.id)),
	)

	const undo: Undo[] = []
	const archive = async (rows: ReadonlyArray<{ id: string }>) => {
		if (rows.length === 0) return
		const ids = rows.map((row) => row.id)
		await db
			.update(DiscountCode)
			.set({ archivedAt: new Date() })
			.where(inArray(DiscountCode.id, ids))
		undo.push(async () => {
			await db
				.update(DiscountCode)
				.set({ archivedAt: null })
				.where(inArray(DiscountCode.id, ids))
		})
	}
	try {
		// A removed code whose value a rename or a new code wants must go first:
		// the unique index holds the value until it is archived. Every other
		// removed code waits until the new ones are safely in.
		const wanted = new Set([
			...changed.map((item) => item.normalized),
			...fresh.map((code) => normalizeDiscountCode(code.code)),
		])
		const early = removed.filter((row) => wanted.has(row.normalizedCode))
		await archive(early)

		// Swapping two codes (A to B and B to A) would collide on the unique
		// index one row at a time. Park every renamed row on a placeholder first;
		// no real code contains a colon.
		if (changed.length > 0) {
			undo.push(async () => {
				for (const item of changed) {
					await db
						.update(DiscountCode)
						.set({ normalizedCode: `parked:${item.row.id}` })
						.where(eq(DiscountCode.id, item.row.id))
				}
				for (const item of changed) {
					await db
						.update(DiscountCode)
						.set({
							code: item.row.code,
							normalizedCode: item.row.normalizedCode,
							maxUses: item.row.maxUses,
						})
						.where(eq(DiscountCode.id, item.row.id))
				}
			})
		}
		for (const item of changed) {
			await db
				.update(DiscountCode)
				.set({ normalizedCode: `parked:${item.row.id}` })
				.where(eq(DiscountCode.id, item.row.id))
		}
		for (const item of changed) {
			await db
				.update(DiscountCode)
				.set({
					code: item.next.code,
					normalizedCode: item.normalized,
					maxUses: item.next.maxUses,
				})
				.where(eq(DiscountCode.id, item.row.id))
		}

		for (const code of fresh) {
			const [inserted] = await db
				.insert(DiscountCode)
				.values({
					organizationId,
					discountId,
					code: code.code,
					normalizedCode: normalizeDiscountCode(code.code),
					maxUses: code.maxUses,
				})
				.returning({ id: DiscountCode.id })
			if (inserted) {
				undo.push(async () => {
					await db.delete(DiscountCode).where(eq(DiscountCode.id, inserted.id))
				})
			}
		}

		await archive(removed.filter((row) => !early.includes(row)))
	} catch (error) {
		await runUndo(undo)
		throw error
	}
}

/** Indexes of codes that repeat an earlier one in the same save. */
function repeatedCodeIndexes(codes: readonly CodeInput[]): number[] {
	const seen = new Set<string>()
	return codes.flatMap((code, index) => {
		const normalized = normalizeDiscountCode(code.code)
		if (seen.has(normalized)) return [index]
		seen.add(normalized)
		return []
	})
}

/** Columns that a failed update puts back: everything the editor writes. */
function restorableColumns(row: DiscountRow) {
	const {
		id: _id,
		organizationId: _organizationId,
		createdById: _createdById,
		createdAt: _createdAt,
		updatedAt: _updatedAt,
		...columns
	} = row
	return columns
}

export async function createDiscount(input: {
	organizationId: string
	userId: string
	definition: DiscountDefinition
	codes: readonly CodeInput[]
}): Promise<SaveSuccess | SaveFailure> {
	if (
		(await countLiveDiscounts(input.organizationId)) >= MAX_DISCOUNTS_PER_ORG
	) {
		return { ok: false, reason: 'too_many_discounts' }
	}
	if (!(await codesFit(input.organizationId, null, input.codes.length))) {
		return { ok: false, reason: 'too_many_codes' }
	}
	// Check every code before writing anything, so a clash never leaves a row
	// behind that a retry would then duplicate.
	const taken = [
		...(await takenCodeIndexes(input.organizationId, null, input.codes)),
		...repeatedCodeIndexes(input.codes),
	]
	if (taken.length > 0) {
		return { ok: false, reason: 'code_taken', codeIndexes: [...new Set(taken)] }
	}
	const [row] = await db
		.insert(Discount)
		.values({
			organizationId: input.organizationId,
			createdById: input.userId,
			version: 1,
			...columnsFor(input.definition),
		})
		.returning({ id: Discount.id })
	if (!row) throw new Error('The discount was not saved.')
	try {
		await syncCodes(input.organizationId, row.id, input.codes)
	} catch (error) {
		// Nothing is atomic on D1: take the half-made discount back out.
		try {
			await db.delete(DiscountCode).where(eq(DiscountCode.discountId, row.id))
			await db.delete(Discount).where(eq(Discount.id, row.id))
		} catch {
			// Report the save failure, not the cleanup.
		}
		if (isUniqueViolation(error)) {
			return { ok: false, reason: 'code_taken', codeIndexes: [] }
		}
		throw error
	}
	return { ok: true, id: row.id, version: 1 }
}

export async function updateDiscount(input: {
	organizationId: string
	discountId: string
	expectedVersion: number
	definition: DiscountDefinition
	codes: readonly CodeInput[]
}): Promise<SaveSuccess | SaveFailure> {
	const scope = and(
		eq(Discount.id, input.discountId),
		eq(Discount.organizationId, input.organizationId),
	)
	const [previous] = await db.select().from(Discount).where(scope).limit(1)
	if (!previous) return { ok: false, reason: 'not_found' }
	if (previous.version !== input.expectedVersion) {
		return { ok: false, reason: 'stale' }
	}
	// An archived discount has released its codes; saving would attach live
	// ones to it. Restore it first.
	if (previous.status === 'archived') return { ok: false, reason: 'archived' }
	if (
		!(await codesFit(
			input.organizationId,
			input.discountId,
			input.codes.length,
		))
	) {
		return { ok: false, reason: 'too_many_codes' }
	}

	const taken = [
		...(await takenCodeIndexes(
			input.organizationId,
			input.discountId,
			input.codes,
		)),
		...repeatedCodeIndexes(input.codes),
	]
	if (taken.length > 0) {
		return { ok: false, reason: 'code_taken', codeIndexes: [...new Set(taken)] }
	}

	const nextVersion = input.expectedVersion + 1
	// The version compare is the lock: only one concurrent save wins it.
	const updated = await db
		.update(Discount)
		.set({ ...columnsFor(input.definition), version: nextVersion })
		.where(and(scope, eq(Discount.version, input.expectedVersion)))
		.returning({ id: Discount.id })
	if (updated.length === 0) {
		const [current] = await db
			.select({ version: Discount.version })
			.from(Discount)
			.where(scope)
			.limit(1)
		return { ok: false, reason: current ? 'stale' : 'not_found' }
	}
	try {
		await syncCodes(input.organizationId, input.discountId, input.codes)
	} catch (error) {
		// Put the rules and the version back, unless someone saved since.
		try {
			await db
				.update(Discount)
				.set(restorableColumns(previous))
				.where(and(scope, eq(Discount.version, nextVersion)))
		} catch {
			// Report the save failure, not the cleanup.
		}
		if (isUniqueViolation(error)) {
			return { ok: false, reason: 'code_taken', codeIndexes: [] }
		}
		throw error
	}
	return { ok: true, id: input.discountId, version: nextVersion }
}

/** The way a stored discount applies, or null when it does not exist. */
export async function getDiscountApplication(
	organizationId: string,
	discountId: string,
): Promise<{
	application: string
	currency: string | null
	locationIds: string[] | null
} | null> {
	const [row] = await db
		.select({
			application: Discount.application,
			currency: Discount.currency,
			locationIds: Discount.locationIds,
		})
		.from(Discount)
		.where(
			and(
				eq(Discount.id, discountId),
				eq(Discount.organizationId, organizationId),
			),
		)
		.limit(1)
	if (!row) return null
	return {
		application: row.application,
		currency: row.currency,
		locationIds: parseJson(row.locationIds) as string[] | null,
	}
}

/**
 * A paused copy of a discount: the same rules, a new name, no codes (codes are
 * unique per organization, so a copy cannot keep them).
 */
export async function duplicateDiscount(input: {
	organizationId: string
	userId: string
	discountId: string
	copyName: (name: string) => string
}): Promise<SaveSuccess | SaveFailure> {
	const loaded = await getDiscount(input.organizationId, input.discountId)
	if (!loaded?.stored) return { ok: false, reason: 'not_found' }
	const { definition } = loaded.stored
	const name = input.copyName(definition.name).slice(0, DISCOUNT_NAME_MAX)
	return createDiscount({
		organizationId: input.organizationId,
		userId: input.userId,
		definition: { ...definition, name, status: 'paused' },
		codes: [],
	})
}

/** Pause, resume or archive. Counts as a save: bumps the version. */
export async function setDiscountStatus(input: {
	organizationId: string
	discountId: string
	expectedVersion: number
	status: DiscountStatus
}): Promise<SaveSuccess | SaveFailure> {
	if (input.status !== 'archived') {
		// Restoring an archived discount makes it live again: it counts toward the cap.
		const [current] = await db
			.select({ status: Discount.status })
			.from(Discount)
			.where(
				and(
					eq(Discount.id, input.discountId),
					eq(Discount.organizationId, input.organizationId),
				),
			)
			.limit(1)
		if (
			current?.status === 'archived' &&
			(await countLiveDiscounts(input.organizationId)) >= MAX_DISCOUNTS_PER_ORG
		) {
			return { ok: false, reason: 'too_many_discounts' }
		}
	}
	if (input.status === 'active') {
		// A coupon discount with no codes would go live and never apply.
		const [row] = await db
			.select({ application: Discount.application })
			.from(Discount)
			.where(
				and(
					eq(Discount.id, input.discountId),
					eq(Discount.organizationId, input.organizationId),
				),
			)
			.limit(1)
		if (row?.application === 'code') {
			const [code] = await db
				.select({ id: DiscountCode.id })
				.from(DiscountCode)
				.where(
					and(
						eq(DiscountCode.discountId, input.discountId),
						eq(DiscountCode.organizationId, input.organizationId),
						isNull(DiscountCode.archivedAt),
					),
				)
				.limit(1)
			if (!code) return { ok: false, reason: 'no_codes' }
		}
	}
	const updated = await db
		.update(Discount)
		.set({ status: input.status, version: input.expectedVersion + 1 })
		.where(
			and(
				eq(Discount.id, input.discountId),
				eq(Discount.organizationId, input.organizationId),
				eq(Discount.version, input.expectedVersion),
			),
		)
		.returning({ id: Discount.id })
	if (updated.length === 0) {
		const [exists] = await db
			.select({ id: Discount.id })
			.from(Discount)
			.where(
				and(
					eq(Discount.id, input.discountId),
					eq(Discount.organizationId, input.organizationId),
				),
			)
			.limit(1)
		return { ok: false, reason: exists ? 'stale' : 'not_found' }
	}
	if (input.status === 'archived') {
		// Archived discounts free their codes for reuse.
		await db
			.update(DiscountCode)
			.set({ archivedAt: new Date() })
			.where(
				and(
					eq(DiscountCode.discountId, input.discountId),
					isNull(DiscountCode.archivedAt),
				),
			)
	}
	return { ok: true, id: input.discountId, version: input.expectedVersion + 1 }
}
