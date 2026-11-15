import {
	db,
	eq,
	MenuCheckDismissal,
	OrganizationMenuItem,
} from '@repo/database'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { insertTestUser } from '#tests/dashboard-utils.ts'
import { createTestOrganization } from '#tests/test-utils.ts'

vi.mock('#app/utils/sites/kv-cache.server.ts', () => ({
	purgeOrganizationSiteCache: vi.fn(async () => true),
}))

import {
	filterSkippedCards,
	MenuCardSkipError,
	skipMenuCard,
	unskipMenuCard,
} from './card-skips.server.ts'
import {
	emptyKind,
	type MenuCardContext,
	type MenuCardDraft,
	type MenuCardKindImpl,
} from './menu-card-kinds.ts'
import {
	detectMenuCards,
	setMenuCardKindForTests,
} from './menu-card-plans.server.ts'
import {
	menuCardFingerprint,
	menuCardId,
	MENU_CARD_KINDS,
	type MenuCardKind,
} from './menu-cards.ts'
import { loadMenuGraph } from './menu-graph.server.ts'

const OLD = new Date('2026-01-01T00:00:00.000Z')
const ctx: MenuCardContext = {
	defaultLocale: 'en',
	locales: ['en'],
	settings: { capitalStyle: null },
	now: new Date('2026-06-01T00:00:00.000Z'),
}

/** One card per dish whose description is "broken". */
function brokenKind(kind: MenuCardKind): MenuCardKindImpl {
	return {
		kind,
		detect(graph) {
			return graph.items
				.filter((item) => item.description === 'broken')
				.map((item): MenuCardDraft => {
					const refs = [
						{ type: 'item' as const, id: item.id, updatedAt: item.updatedAt },
					]
					return {
						kind,
						id: menuCardId(kind, item.id),
						primary: { type: 'item', id: item.id },
						subject: item.id,
						refs,
						fingerprint: menuCardFingerprint(refs),
						params: { itemId: item.id },
						preview: { before: [], after: [] },
					}
				})
		},
		plan: (_graph, request) => ({
			ok: true,
			ops: [
				{
					op: 'update',
					entity: 'item',
					id: request.params.itemId as string,
					set: { availabilityStatus: 'hidden' },
				},
			],
		}),
	}
}

async function world() {
	const user = await insertTestUser()
	const org = await createTestOrganization(user.id)
	const organization = {
		id: org.id,
		slug: org.slug,
		siteLocales: null,
		siteDefaultLocale: null,
	}
	const [broken, fine] = await db
		.insert(OrganizationMenuItem)
		.values([
			{
				organizationId: org.id,
				displayName: '{"en":"Broken"}',
				description: 'broken',
				createdAt: OLD,
				updatedAt: OLD,
			},
			{
				organizationId: org.id,
				displayName: '{"en":"Fine"}',
				description: 'fine',
				createdAt: OLD,
				updatedAt: OLD,
			},
		])
		.returning()
	return { user, org, organization, broken: broken!, fine: fine! }
}

type World = Awaited<ReturnType<typeof world>>

async function graphOf(w: World) {
	return (await loadMenuGraph(w.organization)).graph
}

async function drafts(w: World, kind: MenuCardKind = 'typo') {
	return detectMenuCards(await graphOf(w), ctx, {
		structureEnabled: true,
		kinds: [kind],
	})
}

async function skip(
	w: World,
	draft: { kind: MenuCardKind; id: string },
	reason: 'not_a_problem' | 'fixed_myself' = 'not_a_problem',
	structureEnabled = true,
) {
	return skipMenuCard({
		organizationId: w.org.id,
		userId: w.user.id,
		graph: await graphOf(w),
		ctx,
		structureEnabled,
		kind: draft.kind,
		id: draft.id,
		reason,
	})
}

async function dismissals(w: World) {
	return db
		.select()
		.from(MenuCheckDismissal)
		.where(eq(MenuCheckDismissal.organizationId, w.org.id))
}

beforeEach(() => {
	for (const kind of MENU_CARD_KINDS) setMenuCardKindForTests(kind, emptyKind(kind))
	setMenuCardKindForTests('typo', brokenKind('typo'))
	setMenuCardKindForTests('capitals', brokenKind('capitals'))
})
afterEach(() => {
	for (const kind of MENU_CARD_KINDS) setMenuCardKindForTests(kind, null)
})

describe('card skips', () => {
	it('stores "not a problem" with the recomputed fingerprint and filters the card', async () => {
		const w = await world()
		const [draft] = await drafts(w)
		expect(draft).toBeDefined()
		expect(await skip(w, draft!)).toEqual({ stored: true })
		const [row] = await dismissals(w)
		expect(row).toMatchObject({
			checkKey: 'card:typo',
			entityType: 'item',
			entityId: w.broken.id,
			reason: 'not_a_problem',
			fingerprint: draft!.fingerprint,
			createdById: w.user.id,
		})

		const kept = await filterSkippedCards(w.org.id, await drafts(w), ['typo'])
		expect(kept).toEqual([])
		expect(await dismissals(w)).toHaveLength(1)
	})

	it('is per kind: the same dish still gets its other kinds', async () => {
		const w = await world()
		const [typo] = await drafts(w, 'typo')
		await skip(w, typo!)
		const all = [...(await drafts(w, 'typo')), ...(await drafts(w, 'capitals'))]
		const kept = await filterSkippedCards(w.org.id, all, ['typo', 'capitals'])
		expect(kept.map((draft) => draft.kind)).toEqual(['capitals'])
	})

	it('brings the card back and deletes the stale row when the record changes', async () => {
		const w = await world()
		const [draft] = await drafts(w)
		await skip(w, draft!)
		await db
			.update(OrganizationMenuItem)
			.set({ updatedAt: new Date('2026-03-01T00:00:00.000Z') })
			.where(eq(OrganizationMenuItem.id, w.broken.id))

		const changed = await drafts(w)
		expect(changed[0]!.fingerprint).not.toBe(draft!.fingerprint)
		const kept = await filterSkippedCards(w.org.id, changed, ['typo'])
		expect(kept).toHaveLength(1)
		expect(await dismissals(w)).toHaveLength(0)
	})

	it('deletes the skip when the card is gone, but only for kinds that ran', async () => {
		const w = await world()
		const [typo] = await drafts(w, 'typo')
		const [capitals] = await drafts(w, 'capitals')
		await skip(w, typo!)
		await skip(w, capitals!)
		await db
			.update(OrganizationMenuItem)
			.set({ description: 'fixed' })
			.where(eq(OrganizationMenuItem.id, w.broken.id))
		// Only `typo` ran: the capitals skip is left alone.
		await filterSkippedCards(w.org.id, [], ['typo'])
		const rows = await dismissals(w)
		expect(rows.map((row) => row.checkKey)).toEqual(['card:capitals'])
	})

	it('stores nothing for "fixed myself"', async () => {
		const w = await world()
		const [draft] = await drafts(w)
		expect(await skip(w, draft!, 'fixed_myself')).toEqual({ stored: false })
		expect(await dismissals(w)).toHaveLength(0)
		// Not even a validity check: an unknown id is fine, nothing is written.
		expect(await skip(w, { kind: 'typo', id: 'typo:nope' }, 'fixed_myself')).toEqual({
			stored: false,
		})
	})

	it('refuses a card the menu does not show with not_applicable', async () => {
		const w = await world()
		await expect(skip(w, { kind: 'typo', id: 'typo:nope' })).rejects.toBeInstanceOf(
			MenuCardSkipError,
		)
		await expect(
			skip(w, { kind: 'typo', id: menuCardId('typo', w.fine.id) }),
		).rejects.toMatchObject({ code: 'not_applicable' })
		expect(await dismissals(w)).toHaveLength(0)
	})

	it('takes the fingerprint from the menu, not from the caller, and replaces an older skip', async () => {
		const w = await world()
		const [draft] = await drafts(w)
		await skip(w, draft!)
		await db
			.update(OrganizationMenuItem)
			.set({ updatedAt: new Date('2026-03-01T00:00:00.000Z') })
			.where(eq(OrganizationMenuItem.id, w.broken.id))
		const [changed] = await drafts(w)
		await skip(w, changed!)
		const rows = await dismissals(w)
		expect(rows).toHaveLength(1)
		expect(rows[0]!.fingerprint).toBe(changed!.fingerprint)
	})

	it('never touches Menu health dismissals', async () => {
		const w = await world()
		await db.insert(MenuCheckDismissal).values({
			organizationId: w.org.id,
			entityType: 'item',
			entityId: w.broken.id,
			checkKey: 'no_photo',
			reason: 'on_purpose',
			fingerprint: 'abc',
		})
		const [draft] = await drafts(w)
		await skip(w, draft!)
		await filterSkippedCards(w.org.id, [], ['typo', 'capitals'])
		await unskipMenuCard({ organizationId: w.org.id, id: draft!.id })
		const rows = await dismissals(w)
		expect(rows.map((row) => row.checkKey)).toEqual(['no_photo'])
		expect(rows[0]!.fingerprint).toBe('abc')
	})

	it('unskip removes only that card, for that organization', async () => {
		const w = await world()
		const other = await world()
		const [draft] = await drafts(w)
		const [otherDraft] = await drafts(other)
		await skip(w, draft!)
		await skip(other, otherDraft!)
		await unskipMenuCard({ organizationId: w.org.id, id: draft!.id })
		expect(await dismissals(w)).toHaveLength(0)
		expect(await dismissals(other)).toHaveLength(1)
		// An id that is not a card id is ignored.
		await unskipMenuCard({ organizationId: other.org.id, id: 'no_photo:whatever' })
		expect(await dismissals(other)).toHaveLength(1)
	})

	it('a skip of one organization never hides another organization’s card', async () => {
		const a = await world()
		const b = await world()
		await skip(a, (await drafts(a))[0]!)
		const kept = await filterSkippedCards(b.org.id, await drafts(b), ['typo'])
		expect(kept).toHaveLength(1)
	})
})
