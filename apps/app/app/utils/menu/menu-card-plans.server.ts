import { createHmac, timingSafeEqual } from 'node:crypto'
import { createId } from '@paralleldrive/cuid2'
import { auditService, AuditAction } from '@repo/audit'
import {
	and,
	db,
	eq,
	inArray,
	MenuCheckDismissal,
	or,
	OrganizationMenu,
	OrganizationMenuCategory,
	OrganizationMenuCategoryAssignment,
	OrganizationMenuItem,
	OrganizationMenuItemCategoryAssignment,
	OrganizationMenuItemModifierGroupAssignment,
	OrganizationMenuLocationOverride,
	OrganizationMenuModifierGroup,
	OrganizationMenuModifierGroupOptionAssignment,
	OrganizationMenuOption,
	OrganizationMenuPosLink,
	sql,
} from '@repo/database'
import { ENV } from 'varlock/env'
import { purgeOrganizationSiteCache } from '#app/utils/sites/kv-cache.server.ts'
import {
	emptyKind,
	type MenuCardContext,
	type MenuCardDraft,
	type MenuCardKindImpl,
	type MenuCardPlanResult,
} from './menu-card-kinds.ts'
import {
	isNewRecordRef,
	isStructureCardKind,
	MENU_CARD_KINDS,
	MENU_CARD_MAX_OPS,
	MENU_CARD_UNDO_MAX_AGE_MS,
	MENU_CARDS_PER_REQUEST,
	MENU_POLISH_CARD_KINDS,
	MENU_STRUCTURE_CARD_KINDS,
	MenuCardOpsSchema,
	NEW_RECORD_PREFIX,
	recordsTouchedByOps,
	type MenuCardApplyInput,
	type MenuCardEntityType,
	type MenuCardError,
	type MenuCardKind,
	type MenuCardLink,
	type MenuCardLinkRef,
	type MenuCardOp,
	type MenuCardRef,
	type MenuCardUndo,
} from './menu-cards.ts'
import { loadMenuGraph } from './menu-graph.server.ts'
import { graphRecord, type MenuGraph } from './menu-graph.ts'
import { posOwnedViolation } from './menu-pos-owned.ts'
import { POLISH_CARD_KINDS_IMPL } from './polish-suggestions.ts'
import { type MenuSnapshotContent } from './snapshot-types.ts'
import {
	assertRestoreLockFree,
	createMenuSnapshot,
	loadMenuSnapshotContent,
	MenuSnapshotError,
	pruneMenuSnapshotsForOrganization,
	reviveDates,
} from './snapshot.server.ts'
import { STRUCTURE_CARD_KINDS_IMPL } from './structure-suggestions.ts'

/**
 * The review-card engine: detect cards, and apply or undo one. Every kind
 * plugs in through `MenuCardKindImpl`; this file holds the rules they all
 * share.
 *
 * Accept: load the menu, refuse `stale_suggestion` when any record on the
 * card changed (or is gone), refuse when the card is no longer detected,
 * re-plan from the current menu, refuse a plan that writes outside the
 * card's refs, uses a column it may not (`MenuCardOpsSchema`: allergens,
 * calories and dietary flags can never be written) or a field a POS owns,
 * take a menu snapshot (`before_suggestion`), then write every op in one
 * `db.batch` (atomic on D1 and libsql; `db.transaction` is not atomic on
 * D1). Every touched record gets the same new `updatedAt`.
 *
 * The batch starts with a guard statement per table that raises (rolling the
 * whole batch back) when any listed record's `updatedAt` is no longer the one
 * read, so a concurrent edit is never overwritten: `stale_suggestion`.
 *
 * Undo goes through that snapshot: on each touched record it puts back only
 * the columns Accept wrote (listed in the signed manifest) and the links
 * Accept changed, and deletes what Accept created (with its location
 * overrides, POS links and dismissals), again in one guarded batch. It
 * refuses `stale_suggestion` when any of them changed after Accept, so it
 * never overwrites a later edit. A manifest expires after 24 hours.
 */

const KIND_IMPLS: Record<MenuCardKind, MenuCardKindImpl> = {
	...Object.fromEntries(MENU_CARD_KINDS.map((kind) => [kind, emptyKind(kind)])),
	...POLISH_CARD_KINDS_IMPL,
	...STRUCTURE_CARD_KINDS_IMPL,
} as Record<MenuCardKind, MenuCardKindImpl>

const testOverrides = new Map<MenuCardKind, MenuCardKindImpl>()

/** Tests only: replace a kind (null restores the real one). */
export function setMenuCardKindForTests(
	kind: MenuCardKind,
	impl: MenuCardKindImpl | null,
) {
	if (impl) testOverrides.set(kind, impl)
	else testOverrides.delete(kind)
}

export function menuCardKindImpl(kind: MenuCardKind): MenuCardKindImpl {
	return testOverrides.get(kind) ?? KIND_IMPLS[kind]
}

export class MenuCardApplyError extends Error {
	constructor(readonly code: MenuCardError) {
		super(code)
		this.name = 'MenuCardApplyError'
	}
}

const refKey = (type: string, id: string) => `${type}:${id}`

function sameTime(a: string, b: string): boolean {
	const left = Date.parse(a)
	const right = Date.parse(b)
	return Number.isFinite(left) && left === right
}

/** Kinds that run for an organization, in display order. */
export function enabledCardKinds(structureEnabled: boolean): MenuCardKind[] {
	return [
		...MENU_POLISH_CARD_KINDS,
		...(structureEnabled ? MENU_STRUCTURE_CARD_KINDS : []),
	]
}

/**
 * Check a plan against the card it came from: valid ops only, every
 * existing record it writes or copies listed in `refs` and present, every
 * `new:` id created earlier in the plan, and no POS-owned field.
 */
export function validateCardPlan(
	graph: MenuGraph,
	refs: readonly Pick<MenuCardRef, 'type' | 'id'>[],
	ops: readonly MenuCardOp[],
): MenuCardError | null {
	if (ops.length > MENU_CARD_MAX_OPS) return 'plan_too_large'
	const parsed = MenuCardOpsSchema.safeParse(ops)
	if (!parsed.success) return 'invalid_plan'
	const allowed = new Set(refs.map((ref) => refKey(ref.type, ref.id)))
	const { touched, copiedFrom } = recordsTouchedByOps(ops)
	for (const record of [...touched, ...copiedFrom]) {
		if (!allowed.has(refKey(record.type, record.id))) return 'invalid_plan'
		if (!graphRecord(graph, record.type, record.id)) return 'stale_suggestion'
	}
	const created = new Set<string>()
	for (const op of ops) {
		const ids: string[] =
			op.op === 'update'
				? [op.id]
				: op.op === 'insert'
					? []
					: [op.parentId, op.childId]
		for (const id of ids) {
			if (isNewRecordRef(id) && !created.has(id.slice(NEW_RECORD_PREFIX.length)))
				return 'invalid_plan'
		}
		if (op.op === 'insert') {
			if (created.has(op.tempId)) return 'invalid_plan'
			created.add(op.tempId)
		}
		if (op.op === 'update' && isNewRecordRef(op.id)) return 'invalid_plan'
	}
	if (posOwnedViolation(graph, ops)) return 'pos_owned'
	return null
}

function planCard(
	graph: MenuGraph,
	ctx: MenuCardContext,
	card: Pick<MenuCardApplyInput, 'kind' | 'id' | 'params' | 'optionId' | 'input'>,
): MenuCardPlanResult {
	try {
		return menuCardKindImpl(card.kind).plan(
			graph,
			{
				id: card.id,
				params: card.params,
				optionId: card.optionId,
				input: card.input,
			},
			ctx,
		)
	} catch (error) {
		console.error('menu cards: plan failed', {
			kind: card.kind,
			error: error instanceof Error ? error.message : 'unknown',
		})
		return { ok: false, error: 'not_applicable' }
	}
}

/**
 * Every card the menu has now, for the enabled kinds, in a stable order.
 * A card whose default fix would be refused (a POS-owned field, an invalid
 * plan) is dropped, so it is never shown. One card per kind and record.
 */
export function detectMenuCards(
	graph: MenuGraph,
	ctx: MenuCardContext,
	options: { structureEnabled: boolean; kinds?: readonly MenuCardKind[] },
): MenuCardDraft[] {
	const kinds = options.kinds ?? enabledCardKinds(options.structureEnabled)
	const out: MenuCardDraft[] = []
	const seen = new Set<string>()
	for (const kind of kinds) {
		if (isStructureCardKind(kind) && !options.structureEnabled) continue
		let drafts: MenuCardDraft[]
		try {
			drafts = menuCardKindImpl(kind).detect(graph, ctx)
		} catch (error) {
			console.error('menu cards: detect failed', {
				kind,
				error: error instanceof Error ? error.message : 'unknown',
			})
			continue
		}
		for (const draft of drafts) {
			if (draft.kind !== kind) continue
			const unique = `${kind}:${draft.primary.id}`
			if (seen.has(unique) || seen.has(draft.id)) continue
			const plan = planCard(graph, ctx, {
				kind,
				id: draft.id,
				params: draft.params,
				optionId: draft.defaultOptionId,
			})
			// Cards needing a typed value (a price) plan only once it is typed.
			const needsInput =
				!plan.ok &&
				plan.error === 'invalid_input' &&
				Boolean(
					draft.options?.find((option) => option.id === draft.defaultOptionId)
						?.input,
				)
			if (!plan.ok && !needsInput) continue
			// A plan too big for one card stays visible: Accept answers with
			// `plan_too_large` instead of the card silently disappearing.
			if (plan.ok) {
				const invalid = validateCardPlan(graph, draft.refs, plan.ops)
				if (invalid && invalid !== 'plan_too_large') continue
			}
			seen.add(unique)
			seen.add(draft.id)
			out.push(draft)
		}
	}
	return out
}

/** The records a card's default fix hides, for the #90 "Used in" lists. */
export function cardHiddenRecords(
	graph: MenuGraph,
	ctx: MenuCardContext,
	draft: MenuCardDraft,
): Array<{ type: 'item' | 'category'; id: string }> {
	const plan = planCard(graph, ctx, {
		kind: draft.kind,
		id: draft.id,
		params: draft.params,
		optionId: draft.defaultOptionId,
	})
	if (!plan.ok) return []
	const hidden: Array<{ type: 'item' | 'category'; id: string }> = []
	for (const op of plan.ops) {
		if (op.op !== 'update') continue
		if (op.entity !== 'item' && op.entity !== 'category') continue
		if (op.set.availabilityStatus === 'hidden')
			hidden.push({ type: op.entity, id: op.id })
	}
	return hidden
}

// --- Tables -----------------------------------------------------------------

const ENTITY_TABLES = {
	item: OrganizationMenuItem,
	category: OrganizationMenuCategory,
	modifier_group: OrganizationMenuModifierGroup,
	option: OrganizationMenuOption,
	menu: OrganizationMenu,
} as const

const ENTITY_CONTENT: Record<MenuCardEntityType, keyof MenuSnapshotContent> = {
	item: 'items',
	category: 'categories',
	modifier_group: 'modifierGroups',
	option: 'options',
	menu: 'menus',
}

const LINK_TABLES = {
	menu_category: {
		table: OrganizationMenuCategoryAssignment,
		parent: OrganizationMenuCategoryAssignment.menuId,
		child: OrganizationMenuCategoryAssignment.categoryId,
		parentKey: 'menuId',
		childKey: 'categoryId',
		content: 'menuCategoryAssignments',
	},
	item_category: {
		table: OrganizationMenuItemCategoryAssignment,
		parent: OrganizationMenuItemCategoryAssignment.categoryId,
		child: OrganizationMenuItemCategoryAssignment.itemId,
		parentKey: 'categoryId',
		childKey: 'itemId',
		content: 'itemCategoryAssignments',
	},
	item_modifier_group: {
		table: OrganizationMenuItemModifierGroupAssignment,
		parent: OrganizationMenuItemModifierGroupAssignment.itemId,
		child: OrganizationMenuItemModifierGroupAssignment.modifierGroupId,
		parentKey: 'itemId',
		childKey: 'modifierGroupId',
		content: 'itemModifierGroupAssignments',
	},
	group_option: {
		table: OrganizationMenuModifierGroupOptionAssignment,
		parent: OrganizationMenuModifierGroupOptionAssignment.modifierGroupId,
		child: OrganizationMenuModifierGroupOptionAssignment.optionId,
		parentKey: 'modifierGroupId',
		childKey: 'optionId',
		content: 'modifierGroupOptionAssignments',
	},
} as const

const LINK_END_TYPES: Record<
	MenuCardLink,
	{ parent: MenuCardEntityType; child: MenuCardEntityType }
> = {
	menu_category: { parent: 'menu', child: 'category' },
	item_category: { parent: 'category', child: 'item' },
	item_modifier_group: { parent: 'item', child: 'modifier_group' },
	group_option: { parent: 'modifier_group', child: 'option' },
}

type Statement = { readonly _: unknown } & object
 
type AnyTable = any

function entityWhere(type: MenuCardEntityType, id: string, organizationId: string) {
	const table = ENTITY_TABLES[type] as AnyTable
	return and(eq(table.id, id), eq(table.organizationId, organizationId))
}

/** `db.batch` on both drivers; the statements run atomically. */
async function runBatch(statements: Statement[]) {
	if (statements.length === 0) return
	await (
		db as unknown as { batch: (queries: Statement[]) => Promise<unknown> }
	).batch(statements)
}

/** Refs per guard statement: 2 binds each plus the organization stays < 100. */
const GUARD_CHUNK = 40

/**
 * Statements that make a batch refuse when any record changed after the
 * caller read it. Each is a SELECT that counts the records still carrying
 * the expected `updatedAt` and, when one does not, evaluates
 * `abs(-9223372036854775808)`: SQLite raises "integer overflow", the whole
 * batch rolls back (a libsql batch and a D1 batch are both one transaction)
 * and `runGuardedBatch` answers `stale_suggestion`. Put these FIRST in the
 * batch, so a concurrent edit between our read and our write is never lost.
 */
function guardStatements(
	organizationId: string,
	refs: readonly Pick<MenuCardRef, 'type' | 'id' | 'updatedAt'>[],
): Statement[] {
	const byType = new Map<MenuCardEntityType, Map<string, number>>()
	for (const ref of refs) {
		const at = Date.parse(ref.updatedAt)
		if (!Number.isFinite(at)) throw new MenuCardApplyError('stale_suggestion')
		const ids = byType.get(ref.type) ?? new Map<string, number>()
		ids.set(ref.id, at)
		byType.set(ref.type, ids)
	}
	const statements: Statement[] = []
	for (const [type, ids] of byType) {
		const table = ENTITY_TABLES[type] as AnyTable
		const entries = [...ids.entries()]
		for (let start = 0; start < entries.length; start += GUARD_CHUNK) {
			const chunk = entries.slice(start, start + GUARD_CHUNK)
			const matches = or(
				...chunk.map(([id, at]) =>
					and(eq(table.id, id), eq(table.updatedAt, new Date(at))),
				),
			)
			statements.push(
				db.run(
					sql`SELECT CASE WHEN (SELECT count(*) FROM ${table} WHERE ${and(
						eq(table.organizationId, organizationId),
						matches,
					)}) = ${sql.raw(String(chunk.length))} THEN 0 ELSE abs(-9223372036854775808) END`,
				) as unknown as Statement,
			)
		}
	}
	return statements
}

function isGuardFailure(error: unknown): boolean {
	let current: unknown = error
	for (let depth = 0; current && depth < 5; depth += 1) {
		const message = current instanceof Error ? current.message : String(current)
		if (/integer overflow/i.test(message)) return true
		current = (current as { cause?: unknown }).cause
	}
	return false
}

/** Run a guarded batch; a failed guard means `stale_suggestion`. */
async function runGuardedBatch(
	organizationId: string,
	expected: readonly Pick<MenuCardRef, 'type' | 'id' | 'updatedAt'>[],
	statements: Statement[],
) {
	try {
		await runBatch([...guardStatements(organizationId, expected), ...statements])
	} catch (error) {
		if (isGuardFailure(error)) throw new MenuCardApplyError('stale_suggestion')
		throw error
	}
}

const REFERENCE_TYPE: Record<MenuCardEntityType, string> = {
	item: 'item',
	category: 'category',
	modifier_group: 'modifier_group',
	option: 'modifier_option',
	menu: 'menu',
}

/**
 * The org-scoped deletes of `deleteMenuEntityReferences` (cleanup.server.ts)
 * as batch statements: location overrides, POS links and health dismissals
 * have no foreign key to the record.
 */
function referenceDeleteStatements(
	organizationId: string,
	type: MenuCardEntityType,
	id: string,
): Statement[] {
	const entityType = REFERENCE_TYPE[type]
	return [
		db
			.delete(OrganizationMenuLocationOverride)
			.where(
				and(
					eq(OrganizationMenuLocationOverride.organizationId, organizationId),
					eq(OrganizationMenuLocationOverride.entityType, entityType),
					eq(OrganizationMenuLocationOverride.entityId, id),
				),
			) as Statement,
		db
			.delete(OrganizationMenuPosLink)
			.where(
				and(
					eq(OrganizationMenuPosLink.organizationId, organizationId),
					eq(OrganizationMenuPosLink.entityType, entityType),
					eq(OrganizationMenuPosLink.localId, id),
				),
			) as Statement,
		db
			.delete(MenuCheckDismissal)
			.where(
				and(
					eq(MenuCheckDismissal.organizationId, organizationId),
					eq(MenuCheckDismissal.entityId, id),
				),
			) as Statement,
	]
}

function untilDate(value: string | null | undefined): Date | null | undefined {
	if (value === undefined) return undefined
	if (value === null) return null
	const parsed = new Date(value)
	return Number.isNaN(parsed.getTime()) ? null : parsed
}

/** Op values to column values (ISO dates to `Date`). */
function columnValues(set: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = { ...set }
	if ('unavailableUntil' in out) {
		out.unavailableUntil = untilDate(out.unavailableUntil as string | null)
	}
	return out
}

type Built = {
	statements: Statement[]
	/** `fields`: the columns an update op wrote (none for a link end). */
	touched: Array<{ type: MenuCardEntityType; id: string; fields: string[] }>
	created: Array<{ type: MenuCardEntityType; id: string }>
	links: MenuCardLinkRef[]
}

/** Turn validated ops into statements (nothing runs yet). Exported for tests. */
export function buildStatements(
	ops: readonly MenuCardOp[],
	content: MenuSnapshotContent,
	organizationId: string,
	now: Date,
): Built {
	const statements: Statement[] = []
	const ids = new Map<string, string>()
	const resolve = (id: string) =>
		isNewRecordRef(id) ? ids.get(id.slice(NEW_RECORD_PREFIX.length))! : id
	const touched = new Map<
		string,
		{ type: MenuCardEntityType; id: string; fields: Set<string> }
	>()
	const stamped = new Set<string>()
	const created: Built['created'] = []
	const links = new Map<string, MenuCardLinkRef>()
	const touch = (type: MenuCardEntityType, id: string) => {
		if (created.some((row) => row.id === id)) return
		const key = refKey(type, id)
		if (!touched.has(key)) touched.set(key, { type, id, fields: new Set() })
	}

	for (const op of ops) {
		switch (op.op) {
			case 'update': {
				const table = ENTITY_TABLES[op.entity] as AnyTable
				statements.push(
					db
						.update(table)
						.set({ ...columnValues(op.set), updatedAt: now })
						.where(entityWhere(op.entity, op.id, organizationId)) as Statement,
				)
				touch(op.entity, op.id)
				stamped.add(refKey(op.entity, op.id))
				const fields = touched.get(refKey(op.entity, op.id))?.fields
				for (const field of Object.keys(op.set)) fields?.add(field)
				break
			}
			case 'insert': {
				const id = createId()
				ids.set(op.tempId, id)
				const values = columnValues(op.values)
				let row: Record<string, unknown>
				if (op.entity === 'item' || (op.entity === 'option' && op.copyFrom)) {
					const source = (
						content[ENTITY_CONTENT[op.entity]] as Array<{ id: string }>
					).find((entry) => entry.id === op.copyFrom)
					if (!source) throw new MenuCardApplyError('stale_suggestion')
					// Safety data (allergens, dietary flags, calories), tax and
					// photos are copied verbatim from the source.
					row = { ...reviveDates(source as Record<string, unknown>), ...values }
				} else {
					row = { ...values }
				}
				row = {
					...row,
					id,
					organizationId,
					createdAt: now,
					updatedAt: now,
				}
				statements.push(
					db.insert(ENTITY_TABLES[op.entity] as AnyTable).values(row) as Statement,
				)
				created.push({ type: op.entity, id })
				break
			}
			case 'assign': {
				const spec = LINK_TABLES[op.link]
				const parentId = resolve(op.parentId)
				const childId = resolve(op.childId)
				const extra: Record<string, unknown> = {}
				for (const key of [
					'position',
					'priceOverride',
					'priceWholeOverride',
					'priceLeftOverride',
					'priceRightOverride',
					'isDefault',
				] as const) {
					if (key in op && (op as Record<string, unknown>)[key] !== undefined)
						extra[key] = (op as Record<string, unknown>)[key]
				}
				const insert = db.insert(spec.table as AnyTable).values({
					id: createId(),
					[spec.parentKey]: parentId,
					[spec.childKey]: childId,
					position: 0,
					...extra,
				})
				statements.push(
					(Object.keys(extra).length > 0
						? insert.onConflictDoUpdate({
								target: [spec.parent, spec.child],
								set: extra,
							})
						: insert.onConflictDoNothing()) as Statement,
				)
				links.set(`${op.link}:${parentId}:${childId}`, {
					link: op.link,
					parentId,
					childId,
				})
				touch(LINK_END_TYPES[op.link].parent, parentId)
				touch(LINK_END_TYPES[op.link].child, childId)
				break
			}
			case 'unassign': {
				const spec = LINK_TABLES[op.link]
				const parentId = resolve(op.parentId)
				const childId = resolve(op.childId)
				statements.push(
					db
						.delete(spec.table as AnyTable)
						.where(and(eq(spec.parent, parentId), eq(spec.child, childId))) as Statement,
				)
				links.set(`${op.link}:${parentId}:${childId}`, {
					link: op.link,
					parentId,
					childId,
				})
				touch(LINK_END_TYPES[op.link].parent, parentId)
				touch(LINK_END_TYPES[op.link].child, childId)
				break
			}
		}
	}

	// One `updatedAt` for every touched record (link ends included), so the
	// stale checks of other cards and of Undo see the change.
	// Records an `update` op wrote already carry it; the rest are stamped with
	// a few chunked statements per table instead of one each.
	const unstamped = new Map<MenuCardEntityType, string[]>()
	for (const [key, record] of touched) {
		if (stamped.has(key)) continue
		unstamped.set(record.type, [...(unstamped.get(record.type) ?? []), record.id])
	}
	for (const [type, recordIds] of unstamped) {
		const table = ENTITY_TABLES[type] as AnyTable
		for (let start = 0; start < recordIds.length; start += 90) {
			statements.push(
				db
					.update(table)
					.set({ updatedAt: now })
					.where(
						and(
							eq(table.organizationId, organizationId),
							inArray(table.id, recordIds.slice(start, start + 90)),
						),
					) as Statement,
			)
		}
	}

	return {
		statements,
		touched: [...touched.values()].map((row) => ({
			type: row.type,
			id: row.id,
			fields: [...row.fields],
		})),
		created,
		links: [...links.values()],
	}
}

// --- Undo signature ---------------------------------------------------------

/**
 * `SESSION_SECRET` may be a comma-separated list (rotation). The first signs;
 * every one verifies. Each yields a purpose key, so the session secret itself
 * never signs an Undo manifest.
 */
function undoKeys(): Buffer[] {
	const secrets = (ENV.SESSION_SECRET ?? '')
		.split(',')
		.map((secret) => secret.trim())
		.filter(Boolean)
	if (secrets.length === 0 || secrets.some((secret) => secret.length < 16)) {
		throw new Error('SESSION_SECRET must be at least 16 characters.')
	}
	return secrets.map((secret) =>
		createHmac('sha256', secret).update('menu-card-undo:v1').digest(),
	)
}

function undoManifest(
	organizationId: string,
	undo: Omit<MenuCardUndo, 'signature'>,
) {
	return JSON.stringify([
		organizationId,
		undo.snapshotId,
		undo.issuedAt,
		undo.touched.map((ref) => [ref.type, ref.id, ref.updatedAt, ref.fields]),
		undo.created.map((ref) => [ref.type, ref.id, ref.updatedAt]),
		undo.links.map((pair) => [pair.link, pair.parentId, pair.childId]),
	])
}

/** HMAC over the organization and the Undo manifest Accept produced. */
export function signMenuCardUndo(
	organizationId: string,
	undo: Omit<MenuCardUndo, 'signature'>,
): string {
	return createHmac('sha256', undoKeys()[0]!)
		.update(undoManifest(organizationId, undo))
		.digest('hex')
}

function undoSignatureValid(organizationId: string, undo: MenuCardUndo) {
	const given = Buffer.from(undo.signature, 'hex')
	const manifest = undoManifest(organizationId, undo)
	return undoKeys().some((key) => {
		const expected = createHmac('sha256', key).update(manifest).digest()
		return given.length === expected.length && timingSafeEqual(given, expected)
	})
}

// --- Accept -----------------------------------------------------------------

type OrganizationRef = {
	id: string
	slug: string
	siteLocales: string | null
	siteDefaultLocale: string | null
}

export type MenuCardApplyResult =
	| { ok: true; undo: MenuCardUndo }
	| { ok: false; error: MenuCardError }

function checkRefs(graph: MenuGraph, refs: readonly MenuCardRef[]): boolean {
	return refs.every((ref) => {
		const record = graphRecord(graph, ref.type, ref.id)
		return Boolean(record && sameTime(record.updatedAt, ref.updatedAt))
	})
}

/**
 * Accept one or several cards (triage "accept all"): one snapshot before
 * the first write, then each card against the menu as the previous one
 * left it, so they cannot conflict. Each card gets its own result and Undo.
 */
export async function applyMenuCards({
	organization,
	userId,
	request,
	cards,
	ctx,
	structureEnabled,
	now: fixedNow,
	beforeWrite,
}: {
	organization: OrganizationRef
	userId: string
	request?: Request
	cards: MenuCardApplyInput[]
	ctx: MenuCardContext
	structureEnabled: boolean
	now?: () => Date
	/** Tests only: runs between planning and the write of each card. */
	beforeWrite?: () => Promise<void>
}): Promise<MenuCardApplyResult[]> {
	if (cards.length > MENU_CARDS_PER_REQUEST) {
		return cards.map(() => ({ ok: false, error: 'invalid_input' }))
	}
	try {
		await assertRestoreLockFree(organization.id)
	} catch (error) {
		if (error instanceof MenuSnapshotError)
			return cards.map(() => ({ ok: false, error: 'restore_in_progress' }))
		throw error
	}

	const results: MenuCardApplyResult[] = []
	let snapshotId: string | null = null
	let applied = 0
	// The graph is reloaded only after a card wrote (or failed to write).
	let loaded: Awaited<ReturnType<typeof loadMenuGraph>> | null = null
	try {
		for (const card of cards) {
			if (isStructureCardKind(card.kind) && !structureEnabled) {
				results.push({ ok: false, error: 'feature_off' })
				continue
			}
			try {
				loaded ??= await loadMenuGraph(organization)
				const { graph, content } = loaded
				if (!checkRefs(graph, card.refs)) {
					results.push({ ok: false, error: 'stale_suggestion' })
					continue
				}
				// Only a card the menu still shows can be accepted: params never
				// create a card on their own.
				const detected = detectMenuCards(graph, ctx, {
					structureEnabled,
					kinds: [card.kind],
				}).find((draft) => draft.id === card.id)
				if (!detected) {
					results.push({ ok: false, error: 'not_applicable' })
					continue
				}
				// The refs sent back may only narrow the detected card's refs, so
				// params (AI text included) can only ever write those records.
				const detectedRefs = new Set(
					detected.refs.map((ref) => refKey(ref.type, ref.id)),
				)
				if (!card.refs.every((ref) => detectedRefs.has(refKey(ref.type, ref.id)))) {
					results.push({ ok: false, error: 'invalid_input' })
					continue
				}
				const plan = planCard(graph, ctx, card)
				if (!plan.ok) {
					results.push(plan)
					continue
				}
				const invalid = validateCardPlan(graph, card.refs, plan.ops)
				if (invalid) {
					results.push({ ok: false, error: invalid })
					continue
				}
				snapshotId ??= await createMenuSnapshot({
					organizationId: organization.id,
					reason: 'before_suggestion',
					userId,
					content,
				})
				const now = fixedNow?.() ?? new Date()
				let built: Built
				try {
					built = buildStatements(plan.ops, content, organization.id, now)
				} catch (error) {
					if (error instanceof MenuCardApplyError) {
						results.push({ ok: false, error: error.code })
						continue
					}
					throw error
				}
				try {
					await beforeWrite?.()
					// Atomic: a guard first, so a record edited since we read it
					// refuses the whole card and nothing is written.
					await runGuardedBatch(organization.id, card.refs, built.statements)
				} catch (error) {
					loaded = null
					if (error instanceof MenuCardApplyError) {
						results.push({ ok: false, error: error.code })
						continue
					}
					console.error('menu cards: write failed', {
						kind: card.kind,
						error: error instanceof Error ? error.message : 'unknown',
					})
					results.push({ ok: false, error: 'write_failed' })
					continue
				}
				applied += 1
				loaded = null
				const at = now.toISOString()
				const manifest = {
					snapshotId,
					touched: built.touched.map((row) => ({ ...row, updatedAt: at })),
					created: built.created.map((row) => ({ ...row, updatedAt: at })),
					links: built.links,
					issuedAt: Date.now(),
				}
				const undo: MenuCardUndo = {
					...manifest,
					signature: signMenuCardUndo(organization.id, manifest),
				}
				// The card is saved: a failing audit log must not turn it into a failure.
				try {
					await auditService.log({
						action:
							card.kind === 'merge_categories' || card.kind === 'category_order'
								? AuditAction.MENU_CATEGORY_UPDATED
								: AuditAction.MENU_ITEM_UPDATED,
						userId,
						organizationId: organization.id,
						resourceType: 'menu_review_card',
						resourceId: card.id.slice(0, 120),
						details: 'Menu review suggestion accepted.',
						metadata: {
							kind: card.kind,
							snapshotId,
							touched: undo.touched.length,
							created: undo.created.length,
						},
						request,
					})
				} catch (error) {
					console.error('menu cards: audit log failed', {
						organizationId: organization.id,
						error: error instanceof Error ? error.message : 'unknown',
					})
				}
				results.push({ ok: true, undo })
			} catch (error) {
				// Never lose the results (and Undo manifests) of saved cards.
				loaded = null
				console.error('menu cards: card failed', {
					kind: card.kind,
					error: error instanceof Error ? error.message : 'unknown',
				})
				results.push({ ok: false, error: 'write_failed' })
			}
		}
	} finally {
		if (applied > 0) {
			try {
				await purgeOrganizationSiteCache(organization.id, organization.slug)
			} catch (error) {
				console.error('menu cards: cache purge failed', {
					organizationId: organization.id,
					error: error instanceof Error ? error.message : 'unknown',
				})
			}
			try {
				await pruneMenuSnapshotsForOrganization(organization.id)
			} catch (error) {
				console.error('menu cards: snapshot prune failed', {
					organizationId: organization.id,
					error: error instanceof Error ? error.message : 'unknown',
				})
			}
		}
	}
	return results
}

// --- Undo -------------------------------------------------------------------

/**
 * Put back what one Accept changed, from its snapshot: on each touched record
 * only the columns Accept wrote (and `updatedAt`), the touched links as the
 * snapshot has them, and delete what Accept created with its location
 * overrides, POS links and dismissals. The write is guarded, so a record
 * edited since the check above refuses the whole Undo (`stale_suggestion`).
 */
export async function undoMenuCard({
	organization,
	userId,
	request,
	undo,
	beforeWrite,
}: {
	organization: OrganizationRef
	userId: string
	request?: Request
	undo: MenuCardUndo
	/** Tests only: runs between the checks and the write. */
	beforeWrite?: () => Promise<void>
}): Promise<{ ok: true } | { ok: false; error: MenuCardError }> {
	// Only the manifest this server signed at Accept can be undone.
	if (!undoSignatureValid(organization.id, undo))
		return { ok: false, error: 'invalid_input' }
	const age = Date.now() - undo.issuedAt
	if (age > MENU_CARD_UNDO_MAX_AGE_MS || age < -60_000)
		return { ok: false, error: 'invalid_input' }
	try {
		await assertRestoreLockFree(organization.id)
	} catch (error) {
		if (error instanceof MenuSnapshotError)
			return { ok: false, error: 'restore_in_progress' }
		throw error
	}

	let snapshot: Awaited<ReturnType<typeof loadMenuSnapshotContent>>
	try {
		snapshot = await loadMenuSnapshotContent(undo.snapshotId, organization.id)
	} catch (error) {
		if (error instanceof MenuSnapshotError)
			return { ok: false, error: 'snapshot_gone' }
		throw error
	}
	if (snapshot.meta.reason !== 'before_suggestion')
		return { ok: false, error: 'snapshot_gone' }
	const content = snapshot.content

	const { graph } = await loadMenuGraph(organization)
	// Edited after Accept (or deleted): undoing would overwrite that.
	if (!checkRefs(graph, [...undo.touched, ...undo.created]))
		return { ok: false, error: 'stale_suggestion' }

	const snapshotRow = (type: MenuCardEntityType, id: string) =>
		(content[ENTITY_CONTENT[type]] as Array<Record<string, unknown>>).find(
			(row) => row.id === id,
		)
	for (const record of undo.created) {
		if (snapshotRow(record.type, record.id)) return { ok: false, error: 'invalid_input' }
	}
	const createdIds = new Set(undo.created.map((record) => record.id))

	const statements: Statement[] = []
	// Links first: drop each pair as it is now, then put back the snapshot's
	// row for it, if it had one and both ends stay.
	for (const pair of undo.links) {
		const spec = LINK_TABLES[pair.link]
		const ends = LINK_END_TYPES[pair.link]
		if (
			!createdIds.has(pair.parentId) &&
			!graphRecord(graph, ends.parent, pair.parentId)
		)
			return { ok: false, error: 'invalid_input' }
		if (
			!createdIds.has(pair.childId) &&
			!graphRecord(graph, ends.child, pair.childId)
		)
			return { ok: false, error: 'invalid_input' }
		statements.push(
			db
				.delete(spec.table as AnyTable)
				.where(
					and(eq(spec.parent, pair.parentId), eq(spec.child, pair.childId)),
				) as Statement,
		)
		const before = (
			content[spec.content as keyof MenuSnapshotContent] as Array<
				Record<string, unknown>
			>
		).find(
			(row) =>
				row[spec.parentKey] === pair.parentId &&
				row[spec.childKey] === pair.childId,
		)
		if (
			before &&
			!createdIds.has(pair.parentId) &&
			!createdIds.has(pair.childId)
		) {
			statements.push(
				db.insert(spec.table as AnyTable).values(reviveDates(before)) as Statement,
			)
		}
	}
	const restoredAt = new Date()
	for (const record of undo.touched) {
		const row = snapshotRow(record.type, record.id)
		if (!row) return { ok: false, error: 'invalid_input' }
		// Only the columns Accept wrote go back; the rest stay as they are.
		const before = reviveDates(row)
		const values: Record<string, unknown> = { updatedAt: restoredAt }
		for (const field of record.fields) {
			if (field === 'id' || field === 'organizationId') continue
			if (field in before) values[field] = before[field]
		}
		statements.push(
			db
				.update(ENTITY_TABLES[record.type] as AnyTable)
				.set(values)
				.where(entityWhere(record.type, record.id, organization.id)) as Statement,
		)
	}
	for (const record of undo.created) {
		statements.push(
			db
				.delete(ENTITY_TABLES[record.type] as AnyTable)
				.where(entityWhere(record.type, record.id, organization.id)) as Statement,
			...referenceDeleteStatements(organization.id, record.type, record.id),
		)
	}
	try {
		await beforeWrite?.()
		await runGuardedBatch(
			organization.id,
			[...undo.touched, ...undo.created],
			statements,
		)
	} catch (error) {
		if (error instanceof MenuCardApplyError)
			return { ok: false, error: error.code }
		throw error
	}

	await auditService.log({
		action: AuditAction.MENU_ITEM_UPDATED,
		userId,
		organizationId: organization.id,
		resourceType: 'menu_review_card',
		resourceId: undo.snapshotId,
		details: 'Menu review suggestion undone.',
		metadata: {
			snapshotId: undo.snapshotId,
			touched: undo.touched.length,
			created: undo.created.length,
		},
		request,
	})
	await purgeOrganizationSiteCache(organization.id, organization.slug)
	return { ok: true }
}
