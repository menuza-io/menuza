import {
	and,
	db,
	eq,
	or,
	like,
	MenuCheckDismissal,
} from '@repo/database'
import { type MenuCardContext, type MenuCardDraft } from './menu-card-kinds.ts'
import { detectMenuCards } from './menu-card-plans.server.ts'
import {
	parseMenuCardId,
	type MenuCardKind,
	type MenuCardSkipReason,
} from './menu-cards.ts'
import { type MenuGraph } from './menu-graph.ts'

/**
 * "Not a problem" skips of review cards, in `MenuCheckDismissal` next to the
 * Menu health dismissals: `checkKey` is `card:<kind>`, the entity is the
 * card's primary record, and `fingerprint` is the card's own, recomputed
 * here (never taken from the browser). A skipped card stays away while the
 * menu detects the same card with the same fingerprint, so it comes back
 * only when the records it is about change. "I fixed it myself" and
 * "Later" are not stored: the browser's `seen` list covers the session.
 */

export const CARD_KEY_PREFIX = 'card:'
const cardKey = (kind: MenuCardKind) => `${CARD_KEY_PREFIX}${kind}`

export class MenuCardSkipError extends Error {
	constructor(readonly code: 'not_applicable') {
		super(code)
		this.name = 'MenuCardSkipError'
	}
}

/**
 * Drop drafts skipped as "not a problem" and delete skips that no longer
 * hold (the card changed or is gone), only for the kinds that ran.
 */
export async function filterSkippedCards(
	organizationId: string,
	drafts: MenuCardDraft[],
	ranKinds: readonly MenuCardKind[],
): Promise<MenuCardDraft[]> {
	const rows = await db
		.select({
			id: MenuCheckDismissal.id,
			entityId: MenuCheckDismissal.entityId,
			checkKey: MenuCheckDismissal.checkKey,
			fingerprint: MenuCheckDismissal.fingerprint,
		})
		.from(MenuCheckDismissal)
		.where(
			and(
				eq(MenuCheckDismissal.organizationId, organizationId),
				like(MenuCheckDismissal.checkKey, `${CARD_KEY_PREFIX}%`),
			),
		)
	if (rows.length === 0) return drafts
	const ran = new Set(ranKinds.map(cardKey))
	const byKey = new Map(
		drafts.map((draft) => [`${cardKey(draft.kind)}\u0000${draft.primary.id}`, draft]),
	)
	const skipped = new Set<MenuCardDraft>()
	const stale: Array<{ id: string; fingerprint: string }> = []
	for (const row of rows) {
		if (!ran.has(row.checkKey)) continue
		const draft = byKey.get(`${row.checkKey}\u0000${row.entityId}`)
		if (draft && draft.fingerprint === row.fingerprint) skipped.add(draft)
		else stale.push({ id: row.id, fingerprint: row.fingerprint })
	}
	if (stale.length > 0) {
		try {
			// Match the fingerprint too: a skip saved again a moment ago (new
			// fingerprint) is not the stale row we read.
			for (let start = 0; start < stale.length; start += 40) {
				await db
					.delete(MenuCheckDismissal)
					.where(
						and(
							eq(MenuCheckDismissal.organizationId, organizationId),
							or(
								...stale
									.slice(start, start + 40)
									.map((row) =>
										and(
											eq(MenuCheckDismissal.id, row.id),
											eq(MenuCheckDismissal.fingerprint, row.fingerprint),
										),
									),
							),
						),
					)
			}
		} catch (error) {
			console.error('menu cards: could not drop stale skips', {
				organizationId,
				error: error instanceof Error ? error.message : 'unknown',
			})
		}
	}
	return drafts.filter((draft) => !skipped.has(draft))
}

/** Persist a "not a problem" skip; "fixed_myself" stores nothing. */
export async function skipMenuCard({
	organizationId,
	userId,
	graph,
	ctx,
	structureEnabled,
	kind,
	id,
	reason,
}: {
	organizationId: string
	userId: string
	graph: MenuGraph
	ctx: MenuCardContext
	structureEnabled: boolean
	kind: MenuCardKind
	id: string
	reason: MenuCardSkipReason
}): Promise<{ stored: boolean }> {
	if (reason !== 'not_a_problem') return { stored: false }
	const draft = detectMenuCards(graph, ctx, {
		structureEnabled,
		kinds: [kind],
	}).find((entry) => entry.id === id)
	if (!draft) throw new MenuCardSkipError('not_applicable')
	await db
		.insert(MenuCheckDismissal)
		.values({
			organizationId,
			entityType: draft.primary.type,
			entityId: draft.primary.id,
			checkKey: cardKey(kind),
			reason,
			fingerprint: draft.fingerprint,
			createdById: userId,
		})
		.onConflictDoUpdate({
			target: [
				MenuCheckDismissal.organizationId,
				MenuCheckDismissal.entityId,
				MenuCheckDismissal.checkKey,
			],
			set: {
				reason,
				fingerprint: draft.fingerprint,
				createdById: userId,
				createdAt: new Date(),
			},
		})
	return { stored: true }
}

/** Undo of a skip: forget it. */
export async function unskipMenuCard({
	organizationId,
	id,
}: {
	organizationId: string
	id: string
}) {
	const parsed = parseMenuCardId(id)
	if (!parsed) return
	await db
		.delete(MenuCheckDismissal)
		.where(
			and(
				eq(MenuCheckDismissal.organizationId, organizationId),
				eq(MenuCheckDismissal.entityId, parsed.primaryId),
				eq(MenuCheckDismissal.checkKey, cardKey(parsed.kind)),
			),
		)
}
