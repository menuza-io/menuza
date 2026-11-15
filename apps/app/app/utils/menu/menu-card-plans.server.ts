import { createHmac, timingSafeEqual } from 'node:crypto'
import { createId } from '@paralleldrive/cuid2'
import { auditService, AuditAction } from '@repo/audit'
import {
	and,
	db,
	eq,
	OrganizationMenu,
	OrganizationMenuCategory,
	OrganizationMenuCategoryAssignment,
	OrganizationMenuItem,
	OrganizationMenuItemCategoryAssignment,
	OrganizationMenuItemModifierGroupAssignment,
	OrganizationMenuModifierGroup,
	OrganizationMenuModifierGroupOptionAssignment,
	OrganizationMenuOption,
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
 * Undo goes through that snapshot: it puts back exactly the records and
 * links Accept changed, as the snapshot has them, and deletes what Accept
 * created, again in one batch. It refuses `stale_suggestion` when any of
 * them changed after Accept, so it never overwrites a later edit.
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
			if (plan.ok && validateCardPlan(graph, draft.refs, plan.ops)) continue
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
	touched: Array<{ type: MenuCardEntityType; id: string }>
	created: Array<{ type: MenuCardEntityType; id: string }>
	links: MenuCardLinkRef[]
}

/** Turn validated ops into statements (nothing runs yet). */
function buildStatements(
	ops: readonly MenuCardOp[],
	content: MenuSnapshotContent,
	organizationId: string,
	now: Date,
): Built {
	const statements: Statement[] = []
	const ids = new Map<string, string>()
	const resolve = (id: string) =>
		isNewRecordRef(id) ? ids.get(id.slice(NEW_RECORD_PREFIX.length))! : id
	const touched = new Map<string, { type: MenuCardEntityType; id: string }>()
	const created: Built['created'] = []
	const links = new Map<string, MenuCardLinkRef>()
	const touch = (type: MenuCardEntityType, id: string) => {
		if (created.some((row) => row.id === id)) return
		touched.set(refKey(type, id), { type, id })
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
	for (const record of touched.values()) {
		statements.push(
			db
				.update(ENTITY_TABLES[record.type] as AnyTable)
				.set({ updatedAt: now })
				.where(entityWhere(record.type, record.id, organizationId)) as Statement,
		)
	}

	return {
		statements,
		touched: [...touched.values()],
		created,
		links: [...links.values()],
	}
}

// --- Undo signature ---------------------------------------------------------

function undoSecret() {
	const secret = ENV.SESSION_SECRET
	if (!secret || secret.length < 16) {
		throw new Error('SESSION_SECRET must be at least 16 characters.')
	}
	return secret
}

/** HMAC over the organization and the Undo manifest Accept produced. */
export function signMenuCardUndo(
	organizationId: string,
	undo: Omit<MenuCardUndo, 'signature'>,
): string {
	const manifest = JSON.stringify([
		organizationId,
		undo.snapshotId,
		undo.touched.map((ref) => [ref.type, ref.id, ref.updatedAt]),
		undo.created.map((ref) => [ref.type, ref.id, ref.updatedAt]),
		undo.links.map((pair) => [pair.link, pair.parentId, pair.childId]),
	])
	return createHmac('sha256', undoSecret())
		.update(`menu-card-undo:v1:${manifest}`)
		.digest('hex')
}

function undoSignatureValid(organizationId: string, undo: MenuCardUndo) {
	const expected = Buffer.from(signMenuCardUndo(organizationId, undo), 'hex')
	const given = Buffer.from(undo.signature, 'hex')
	return given.length === expected.length && timingSafeEqual(given, expected)
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
}: {
	organization: OrganizationRef
	userId: string
	request?: Request
	cards: MenuCardApplyInput[]
	ctx: MenuCardContext
	structureEnabled: boolean
	now?: () => Date
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
	for (const card of cards) {
		if (isStructureCardKind(card.kind) && !structureEnabled) {
			results.push({ ok: false, error: 'feature_off' })
			continue
		}
		const { graph, content } = await loadMenuGraph(organization)
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
		await runBatch(built.statements)
		applied += 1
		const at = now.toISOString()
		const manifest = {
			snapshotId,
			touched: built.touched.map((row) => ({ ...row, updatedAt: at })),
			created: built.created.map((row) => ({ ...row, updatedAt: at })),
			links: built.links,
		}
		const undo: MenuCardUndo = {
			...manifest,
			signature: signMenuCardUndo(organization.id, manifest),
		}
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
		results.push({ ok: true, undo })
	}

	if (applied > 0) {
		await purgeOrganizationSiteCache(organization.id, organization.slug)
		try {
			await pruneMenuSnapshotsForOrganization(organization.id)
		} catch (error) {
			console.error('menu cards: snapshot prune failed', {
				organizationId: organization.id,
				error: error instanceof Error ? error.message : 'unknown',
			})
		}
	}
	return results
}

// --- Undo -------------------------------------------------------------------

/**
 * Put back what one Accept changed, from its snapshot: the touched records
 * and links as the snapshot has them, and delete what Accept created.
 */
export async function undoMenuCard({
	organization,
	userId,
	request,
	undo,
}: {
	organization: OrganizationRef
	userId: string
	request?: Request
	undo: MenuCardUndo
}): Promise<{ ok: true } | { ok: false; error: MenuCardError }> {
	// Only the manifest this server signed at Accept can be undone.
	if (!undoSignatureValid(organization.id, undo))
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
	for (const record of undo.touched) {
		const row = snapshotRow(record.type, record.id)
		if (!row) return { ok: false, error: 'invalid_input' }
		const { id: _id, ...values } = reviveDates(row)
		statements.push(
			db
				.update(ENTITY_TABLES[record.type] as AnyTable)
				.set({ ...values, organizationId: organization.id })
				.where(entityWhere(record.type, record.id, organization.id)) as Statement,
		)
	}
	for (const record of undo.created) {
		statements.push(
			db
				.delete(ENTITY_TABLES[record.type] as AnyTable)
				.where(entityWhere(record.type, record.id, organization.id)) as Statement,
		)
	}
	await runBatch(statements)

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
