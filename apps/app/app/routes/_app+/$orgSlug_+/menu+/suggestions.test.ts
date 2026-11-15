import {
	ConfigFlag,
	db,
	eq,
	Organization,
	OrganizationMenuCategory,
	OrganizationMenuItem,
} from '@repo/database'
import { RouterContextProvider } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
	process.env.SESSION_SECRET = 'test-session-secret'
	process.env.JWT_SECRET = 'test-jwt-secret-key'
	const workerId =
		process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID ?? '0'
	process.env.DATABASE_URL = `file:./tests/database/data.${workerId}.db`
	process.env.AWS_ENDPOINT_URL_S3 = 'http://localhost:9000'
	process.env.AWS_REGION = 'us-east-1'
	process.env.AWS_ACCESS_KEY_ID = 'test'
	process.env.AWS_SECRET_ACCESS_KEY = 'test'
	process.env.BUCKET_NAME = 'test'
})

const mocks = vi.hoisted(() => ({
	generateContent: vi.fn(),
	purge: vi.fn(async () => true),
}))

vi.mock('@repo/ai/server', () => ({ generateContent: mocks.generateContent }))
vi.mock('#app/utils/sites/kv-cache.server.ts', () => ({
	purgeOrganizationSiteCache: mocks.purge,
}))
const snapshotStore = vi.hoisted(() => new Map<string, string>())
vi.mock('#app/utils/storage.server.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#app/utils/storage.server.ts')>()),
	uploadMenuSnapshotJson: vi.fn(
		async (orgId: string, snapshotId: string, body: string) => {
			const key = `menu-snapshots/${orgId}/${snapshotId}.json`
			snapshotStore.set(key, body)
			return key
		},
	),
	readMenuSnapshotJson: vi.fn(
		async (contentKey: string) => snapshotStore.get(contentKey) ?? null,
	),
	deleteMenuSnapshotJson: vi.fn(async (contentKey: string) => {
		snapshotStore.delete(contentKey)
	}),
}))

import {
	emptyKind,
	type MenuCardDraft,
	type MenuCardKindImpl,
} from '#app/utils/menu/menu-card-kinds.ts'
import { setMenuCardKindForTests } from '#app/utils/menu/menu-card-plans.server.ts'
import {
	menuCardFingerprint,
	menuCardId,
	MENU_CARD_KINDS,
	type MenuCardKind,
} from '#app/utils/menu/menu-cards.ts'
import { MENU_SUGGESTIONS_RATE_LIMIT } from '#app/utils/menu/menu-suggestions.server.ts'
import { setupTestOrgWithUser } from '#tests/test-utils.ts'
import { action } from './suggestions.ts'

type Setup = Awaited<ReturnType<typeof setupTestOrgWithUser>>

async function setup(role: 'admin' | 'viewer' = 'admin'): Promise<Setup> {
	const result = await setupTestOrgWithUser(role)
	await db
		.update(Organization)
		.set({ siteLocales: '["en","ar"]', siteDefaultLocale: 'en' })
		.where(eq(Organization.id, result.organization.id))
	return result
}

async function post(
	{ organization, cookie }: Setup,
	body: unknown,
): Promise<Response> {
	const request = new Request(
		`https://app.example/${organization.slug}/menu/suggestions`,
		{
			method: 'POST',
			headers: { 'content-type': 'application/json', cookie },
			body: typeof body === 'string' ? body : JSON.stringify(body),
		},
	)
	try {
		return (await action({
			request,
			params: { orgSlug: organization.slug },
			context: new RouterContextProvider(),
		} as never)) as Response
	} catch (thrown) {
		if (thrown instanceof Response) return thrown
		throw thrown
	}
}

async function dish(organizationId: string, patch: object = {}) {
	const [row] = await db
		.insert(OrganizationMenuItem)
		.values({
			organizationId,
			displayName: '{"en":"Falafel"}',
			...patch,
		})
		.returning()
	return row!
}

async function readItem(id: string) {
	const [row] = await db
		.select()
		.from(OrganizationMenuItem)
		.where(eq(OrganizationMenuItem.id, id))
	return row!
}

beforeEach(() => {
	vi.clearAllMocks()
	mocks.generateContent.mockResolvedValue('{"descriptions":[]}')
})

const flagOrgs: string[] = []
afterEach(async () => {
	for (const id of flagOrgs.splice(0)) {
		await db.delete(ConfigFlag).where(eq(ConfigFlag.organizationId, id))
	}
})

describe('menu review suggestions permissions', () => {
	it('refuses members without menu write access before reading the body', async () => {
		const viewer = await setup('viewer')
		const item = await dish(viewer.organization.id)

		for (const body of [
			{ intent: 'generate' },
			{
				intent: 'set-text',
				reason: 'translation',
				itemId: item.id,
				changes: [{ field: 'displayName', locale: 'ar', value: 'فلافل' }],
			},
			{ intent: 'set-auto-translate', enabled: true },
		]) {
			const response = await post(viewer, body)
			expect(response.status).toBe(403)
		}
		expect(mocks.generateContent).not.toHaveBeenCalled()
		expect((await readItem(item.id)).displayName).toBe('{"en":"Falafel"}')
	})

	it('cannot touch another organization’s dish', async () => {
		const admin = await setup()
		const other = await setup()
		const theirs = await dish(other.organization.id)
		const response = await post(admin, {
			intent: 'set-text',
			reason: 'translation',
			itemId: theirs.id,
			changes: [{ field: 'displayName', locale: 'ar', value: 'فلافل' }],
		})
		expect(response.status).toBe(404)
		expect((await readItem(theirs.id)).displayName).toBe('{"en":"Falafel"}')
	})

	it('rate limits AI batches per organization', async () => {
		const admin = await setup()
		await dish(admin.organization.id)
		const original = MENU_SUGGESTIONS_RATE_LIMIT.maxRequests
		MENU_SUGGESTIONS_RATE_LIMIT.maxRequests = 1
		try {
			expect((await post(admin, { intent: 'generate' })).status).toBe(200)
			const limited = await post(admin, { intent: 'generate' })
			expect(limited.status).toBe(429)
			expect(await limited.json()).toEqual({
				ok: false,
				error: 'rate_limited',
			})
		} finally {
			MENU_SUGGESTIONS_RATE_LIMIT.maxRequests = original
		}
	})
})

describe('menu review suggestions writes', () => {
	it('accepts a translation, cleans it and undoes it', async () => {
		const admin = await setup()
		const item = await dish(admin.organization.id)
		const response = await post(admin, {
			intent: 'set-text',
			reason: 'translation',
			itemId: item.id,
			changes: [{ field: 'displayName', locale: 'ar', value: '<b>فلافل</b>' }],
		})
		expect(response.status).toBe(200)
		const body = (await response.json()) as {
			results: Array<{ previous: unknown[] }>
		}
		expect(JSON.parse((await readItem(item.id)).displayName)).toEqual({
			en: 'Falafel',
			ar: 'فلافل',
		})
		expect(mocks.purge).toHaveBeenCalled()

		const undo = await post(admin, {
			intent: 'set-text',
			reason: 'undo',
			itemId: item.id,
			changes: body.results[0]!.previous,
		})
		expect(undo.status).toBe(200)
		expect(JSON.parse((await readItem(item.id)).displayName)).toEqual({
			en: 'Falafel',
		})
	})

	it('keeps each kind to its own languages', async () => {
		const admin = await setup()
		const item = await dish(admin.organization.id)
		const overwriteSource = await post(admin, {
			intent: 'set-text',
			reason: 'translation',
			itemId: item.id,
			changes: [{ field: 'displayName', locale: 'en', value: 'Hacked' }],
		})
		expect(overwriteSource.status).toBe(400)
		const translatedDescription = await post(admin, {
			intent: 'set-text',
			reason: 'description',
			itemId: item.id,
			changes: [{ field: 'description', locale: 'ar', value: 'وصف' }],
		})
		expect(translatedDescription.status).toBe(400)
		const empty = await post(admin, {
			intent: 'set-text',
			reason: 'description',
			itemId: item.id,
			changes: [{ field: 'description', locale: 'en', value: '<br>' }],
		})
		expect(empty.status).toBe(400)
		expect(await readItem(item.id)).toMatchObject({
			displayName: '{"en":"Falafel"}',
			description: null,
		})
		expect((await post(admin, 'not json')).status).toBe(400)
	})

	it('accepts all translations at once and undoes them together', async () => {
		const admin = await setup()
		const a = await dish(admin.organization.id, { displayName: '{"en":"Tea"}' })
		const b = await dish(admin.organization.id, {
			displayName: '{"en":"Soup"}',
		})
		const response = await post(admin, {
			intent: 'set-text-bulk',
			reason: 'translation',
			entries: [
				{
					itemId: a.id,
					changes: [{ field: 'displayName', locale: 'ar', value: 'شاي' }],
				},
				{
					itemId: b.id,
					changes: [{ field: 'displayName', locale: 'ar', value: 'شوربة' }],
				},
			],
		})
		expect(response.status).toBe(200)
		const { results } = (await response.json()) as {
			results: Array<{ itemId: string; previous: unknown[] }>
		}
		expect(JSON.parse((await readItem(b.id)).displayName)).toEqual({
			en: 'Soup',
			ar: 'شوربة',
		})
		await post(admin, {
			intent: 'set-text-bulk',
			reason: 'undo',
			entries: results.map((result) => ({
				itemId: result.itemId,
				changes: result.previous,
			})),
		})
		expect((await readItem(a.id)).displayName).toBe('{"en":"Tea"}')
		expect((await readItem(b.id)).displayName).toBe('{"en":"Soup"}')
	})

	it('makes a long-unavailable dish available and undo puts it back as it was', async () => {
		const admin = await setup()
		const old = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000)
		const item = await dish(admin.organization.id, {
			availabilityStatus: 'unavailable',
			updatedAt: old,
		})
		const hideWithWrongTarget = await post(admin, {
			intent: 'set-item-availability',
			reason: 'hide',
			itemId: item.id,
			availability: { availabilityStatus: 'available' },
		})
		expect(hideWithWrongTarget.status).toBe(400)

		const response = await post(admin, {
			intent: 'set-item-availability',
			reason: 'make_available',
			itemId: item.id,
			availability: { availabilityStatus: 'available' },
		})
		const { previous } = (await response.json()) as {
			previous: {
				availabilityStatus: string
				unavailableUntil: string | null
				updatedAt: string
			}
		}
		expect((await readItem(item.id)).availabilityStatus).toBe('available')

		await post(admin, {
			intent: 'set-item-availability',
			reason: 'undo',
			itemId: item.id,
			availability: {
				availabilityStatus: previous.availabilityStatus,
				unavailableUntil: previous.unavailableUntil,
			},
			restoreUpdatedAt: previous.updatedAt,
		})
		const restored = await readItem(item.id)
		expect(restored.availabilityStatus).toBe('unavailable')
		expect(restored.updatedAt.getTime()).toBe(old.getTime())
	})

	it('hides an empty category and undo shows it again', async () => {
		const admin = await setup()
		const [category] = await db
			.insert(OrganizationMenuCategory)
			.values({
				organizationId: admin.organization.id,
				displayName: '{"en":"Specials"}',
			})
			.returning()
		const response = await post(admin, {
			intent: 'set-category-availability',
			reason: 'hide',
			categoryId: category!.id,
			availability: { availabilityStatus: 'hidden' },
		})
		const { previous } = (await response.json()) as {
			previous: { availabilityStatus: string }
		}
		const read = async () =>
			(
				await db
					.select({ status: OrganizationMenuCategory.availabilityStatus })
					.from(OrganizationMenuCategory)
					.where(eq(OrganizationMenuCategory.id, category!.id))
			)[0]?.status
		expect(await read()).toBe('hidden')
		await post(admin, {
			intent: 'set-category-availability',
			reason: 'undo',
			categoryId: category!.id,
			availability: previous,
		})
		expect(await read()).toBe('available')
	})

	it('stores the auto-translate toggle on the organization', async () => {
		const admin = await setup()
		flagOrgs.push(admin.organization.id)
		const response = await post(admin, {
			intent: 'set-auto-translate',
			enabled: true,
		})
		expect(await response.json()).toEqual({ ok: true, enabled: true })
		const [flag] = await db
			.select({ value: ConfigFlag.value, level: ConfigFlag.level })
			.from(ConfigFlag)
			.where(eq(ConfigFlag.organizationId, admin.organization.id))
		expect(flag).toEqual({ value: true, level: 'organization' })
	})
})

// --- Review cards -------------------------------------------------------------------

const seenSettings: unknown[] = []

/** One card per dish whose name starts with "Card"; the fix moves it to position 3. */
function cardKind(kind: MenuCardKind): MenuCardKindImpl {
	return {
		kind,
		detect: (graph, ctx) => {
			seenSettings.push(ctx.settings)
			return graph.items
				.filter((item) => item.displayName.includes('"Card'))
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
					set: { position: 3 },
				},
			],
		}),
	}
}

const complete = (en: string) => ({
	displayName: JSON.stringify({ en, ar: 'اسم' }),
	description: JSON.stringify({ en: 'Tasty and warm.', ar: 'لذيذ' }),
})

type CardJson = {
	kind: MenuCardKind
	id: string
	refs: Array<{ type: string; id: string; updatedAt: string }>
	params: Record<string, unknown>
}

async function generateCards(setupResult: Setup): Promise<CardJson[]> {
	const response = await post(setupResult, { intent: 'generate' })
	expect(response.status).toBe(200)
	const body = (await response.json()) as {
		batch: { suggestions: Array<{ kind: string }> }
	}
	return body.batch.suggestions.filter((entry) =>
		(MENU_CARD_KINDS as readonly string[]).includes(entry.kind),
	) as unknown as CardJson[]
}

const toApply = (card: CardJson) => ({
	kind: card.kind,
	id: card.id,
	refs: card.refs,
	params: card.params,
})

describe('menu review card intents', () => {
	beforeEach(() => {
		snapshotStore.clear()
		seenSettings.length = 0
		for (const kind of MENU_CARD_KINDS) setMenuCardKindForTests(kind, emptyKind(kind))
		setMenuCardKindForTests('category_order', cardKind('category_order'))
	})
	afterEach(() => {
		for (const kind of MENU_CARD_KINDS) setMenuCardKindForTests(kind, null)
	})

	it('refuses members without update:menu:any on every card intent', async () => {
		const viewer = await setup('viewer')
		const item = await dish(viewer.organization.id, complete('Card A'))
		const card = {
			kind: 'category_order',
			id: `category_order:${item.id}`,
			refs: [{ type: 'item', id: item.id, updatedAt: item.updatedAt.toISOString() }],
			params: { itemId: item.id },
		}
		const bodies = [
			{ intent: 'apply-card', card },
			{ intent: 'apply-cards', cards: [card] },
			{
				intent: 'undo-card',
				undo: { snapshotId: 'x', touched: [], created: [], links: [] },
			},
			{ intent: 'skip-card', id: card.id, kind: card.kind, reason: 'not_a_problem' },
			{
				intent: 'skip-cards',
				cards: [{ id: card.id, kind: card.kind, reason: 'not_a_problem' }],
			},
			{ intent: 'unskip-card', id: card.id, kind: card.kind },
			{ intent: 'set-card-setting', setting: { key: 'capitalStyle', value: 'title' } },
		]
		for (const body of bodies) {
			expect((await post(viewer, body)).status).toBe(403)
		}
		expect((await readItem(item.id)).position).toBe(0)
		expect(snapshotStore.size).toBe(0)
	})

	it('accepts a card, returns its Undo, and undo-card puts the dish back', async () => {
		const admin = await setup()
		const item = await dish(admin.organization.id, complete('Card A'))
		const [card] = await generateCards(admin)
		expect(card).toMatchObject({ kind: 'category_order', id: `category_order:${item.id}` })

		const response = await post(admin, { intent: 'apply-card', card: toApply(card!) })
		expect(response.status).toBe(200)
		const body = (await response.json()) as {
			ok: true
			undo: { snapshotId: string; touched: unknown[]; created: unknown[]; links: unknown[] }
		}
		expect(body.undo.touched).toEqual([
			expect.objectContaining({ type: 'item', id: item.id }),
		])
		expect((await readItem(item.id)).position).toBe(3)
		expect(mocks.purge).toHaveBeenCalled()

		const undo = await post(admin, { intent: 'undo-card', undo: body.undo })
		expect(undo.status).toBe(200)
		expect(await undo.json()).toEqual({ ok: true })
		expect((await readItem(item.id)).position).toBe(0)
	})

	it('accepts several cards in one request with one result each', async () => {
		const admin = await setup()
		const a = await dish(admin.organization.id, complete('Card A'))
		const b = await dish(admin.organization.id, complete('Card B'))
		const cards = await generateCards(admin)
		expect(cards).toHaveLength(2)
		const response = await post(admin, {
			intent: 'apply-cards',
			cards: [...cards.map(toApply), { ...toApply(cards[0]!), id: 'category_order:nope' }],
		})
		expect(response.status).toBe(200)
		const body = (await response.json()) as {
			results: Array<{ id: string; ok: boolean; error?: string; undo?: { snapshotId: string } }>
		}
		expect(body.results.map((r) => [r.id, r.ok])).toEqual([
			[`category_order:${a.id}`, true],
			[`category_order:${b.id}`, true],
			['category_order:nope', false],
		])
		// The third was refused, as the first had changed its record.
		expect(body.results[2]!.error).toBe('stale_suggestion')
		expect(body.results[0]!.undo!.snapshotId).toBe(body.results[1]!.undo!.snapshotId)
		expect((await readItem(a.id)).position).toBe(3)
		expect((await readItem(b.id)).position).toBe(3)
	})

	it('answers 400 for more than 20 cards, bad kinds and oversized input', async () => {
		const admin = await setup()
		const item = await dish(admin.organization.id, complete('Card A'))
		const card = {
			kind: 'category_order',
			id: `category_order:${item.id}`,
			refs: [],
			params: {},
		}
		for (const size of [21, 0]) {
			const response = await post(admin, {
				intent: 'apply-cards',
				cards: Array.from({ length: size }, () => card),
			})
			expect(response.status).toBe(400)
		}
		const skips = await post(admin, {
			intent: 'skip-cards',
			cards: Array.from({ length: 21 }, () => ({
				id: card.id,
				kind: card.kind,
				reason: 'not_a_problem',
			})),
		})
		expect(skips.status).toBe(400)
		expect(
			(await post(admin, { intent: 'apply-card', card: { ...card, kind: 'bogus' } })).status,
		).toBe(400)
		expect(
			(
				await post(admin, {
					intent: 'apply-card',
					card: { ...card, id: 'x'.repeat(121) },
				})
			).status,
		).toBe(400)
		expect((await readItem(item.id)).position).toBe(0)
	})

	it('answers 409 stale_suggestion when the dish changed since the card was made', async () => {
		const admin = await setup()
		const item = await dish(admin.organization.id, complete('Card A'))
		const [card] = await generateCards(admin)
		await db
			.update(OrganizationMenuItem)
			.set({ price: 99, updatedAt: new Date(Date.now() + 60_000) })
			.where(eq(OrganizationMenuItem.id, item.id))
		const response = await post(admin, { intent: 'apply-card', card: toApply(card!) })
		expect(response.status).toBe(409)
		expect(await response.json()).toEqual({ ok: false, error: 'stale_suggestion' })
		expect((await readItem(item.id)).position).toBe(0)
	})

	it('answers 404 feature_off for a structure card while the flag is off', async () => {
		const admin = await setup()
		const item = await dish(admin.organization.id, complete('Card A'))
		const response = await post(admin, {
			intent: 'apply-card',
			card: {
				kind: 'merge_duplicates',
				id: `merge_duplicates:${item.id}`,
				refs: [{ type: 'item', id: item.id, updatedAt: item.updatedAt.toISOString() }],
				params: {},
			},
		})
		expect(response.status).toBe(404)
		expect(await response.json()).toEqual({ ok: false, error: 'feature_off' })
	})

	it('refuses another organization’s cards and Undo', async () => {
		const admin = await setup()
		const other = await setup()
		const mine = await dish(admin.organization.id, complete('Card Mine'))
		const theirs = await dish(other.organization.id, complete('Card Theirs'))
		const [theirCard] = await generateCards(other)

		const stale = await post(admin, { intent: 'apply-card', card: toApply(theirCard!) })
		expect(stale.status).toBe(409)
		expect(await stale.json()).toEqual({ ok: false, error: 'stale_suggestion' })

		// A card id of mine with their record's ref is refused too.
		const mixed = await post(admin, {
			intent: 'apply-card',
			card: { ...toApply(theirCard!), id: `category_order:${mine.id}`, params: { itemId: mine.id } },
		})
		expect(mixed.status).toBe(409)

		// Their Undo is unknown to me.
		const applied = await post(other, { intent: 'apply-card', card: toApply(theirCard!) })
		const { undo } = (await applied.json()) as { undo: unknown }
		const forged = await post(admin, { intent: 'undo-card', undo })
		// Signed for the other organization, so refused as not ours.
		expect(forged.status).toBe(400)
		expect(await forged.json()).toEqual({ ok: false, error: 'invalid_input' })

		expect((await readItem(theirs.id)).position).toBe(3)
		expect((await readItem(mine.id)).position).toBe(0)
	})

	it('answers 409 restore_in_progress while a History restore runs', async () => {
		const admin = await setup()
		flagOrgs.push(admin.organization.id)
		await dish(admin.organization.id, complete('Card A'))
		const [card] = await generateCards(admin)
		await db.insert(ConfigFlag).values({
			key: 'menu.restore_in_progress',
			value: 'true',
			level: 'organization',
			organizationId: admin.organization.id,
		})
		const response = await post(admin, { intent: 'apply-card', card: toApply(card!) })
		expect(response.status).toBe(409)
		expect(await response.json()).toEqual({ ok: false, error: 'restore_in_progress' })
	})

	it('skips a card as not a problem, hides it from generate, and unskip brings it back', async () => {
		const admin = await setup()
		const item = await dish(admin.organization.id, complete('Card A'))
		const [card] = await generateCards(admin)

		const skipped = await post(admin, {
			intent: 'skip-card',
			id: card!.id,
			kind: card!.kind,
			reason: 'not_a_problem',
		})
		expect(skipped.status).toBe(200)
		expect(await skipped.json()).toEqual({ ok: true, stored: true })
		expect(await generateCards(admin)).toEqual([])

		const unskipped = await post(admin, {
			intent: 'unskip-card',
			id: card!.id,
			kind: card!.kind,
		})
		expect(await unskipped.json()).toEqual({ ok: true })
		expect((await generateCards(admin)).map((c) => c.id)).toEqual([card!.id])
		expect((await readItem(item.id)).position).toBe(0)
	})

	it('stores nothing for fixed_myself, refuses an unknown card, and reports each of skip-cards', async () => {
		const admin = await setup()
		await dish(admin.organization.id, complete('Card A'))
		const [card] = await generateCards(admin)

		const fixed = await post(admin, {
			intent: 'skip-card',
			id: card!.id,
			kind: card!.kind,
			reason: 'fixed_myself',
		})
		expect(await fixed.json()).toEqual({ ok: true, stored: false })
		expect((await generateCards(admin)).map((c) => c.id)).toEqual([card!.id])

		const unknown = await post(admin, {
			intent: 'skip-card',
			id: 'category_order:nope',
			kind: 'category_order',
			reason: 'not_a_problem',
		})
		expect(unknown.status).toBe(400)
		expect(await unknown.json()).toEqual({ ok: false, error: 'not_applicable' })

		const many = await post(admin, {
			intent: 'skip-cards',
			cards: [
				{ id: card!.id, kind: card!.kind, reason: 'not_a_problem' },
				{ id: 'category_order:nope', kind: 'category_order', reason: 'not_a_problem' },
				{ id: 'category_order:nope2', kind: 'category_order', reason: 'fixed_myself' },
			],
		})
		expect(await many.json()).toEqual({
			ok: true,
			results: [
				{ id: card!.id, ok: true, stored: true },
				{ id: 'category_order:nope', ok: false, error: 'not_applicable' },
				{ id: 'category_order:nope2', ok: true, stored: false },
			],
		})
	})

	it('another organization cannot skip or unskip my card', async () => {
		const admin = await setup()
		const other = await setup()
		await dish(admin.organization.id, complete('Card A'))
		const [card] = await generateCards(admin)
		// The id is unknown to the other organization's menu.
		const response = await post(other, {
			intent: 'skip-card',
			id: card!.id,
			kind: card!.kind,
			reason: 'not_a_problem',
		})
		expect(response.status).toBe(400)
		await post(admin, {
			intent: 'skip-card',
			id: card!.id,
			kind: card!.kind,
			reason: 'not_a_problem',
		})
		await post(other, { intent: 'unskip-card', id: card!.id, kind: card!.kind })
		expect(await generateCards(admin)).toEqual([])
	})

	it('persists a card setting and hands it to the detectors on generate', async () => {
		const admin = await setup()
		flagOrgs.push(admin.organization.id)
		await dish(admin.organization.id, complete('Card A'))

		await generateCards(admin)
		expect(seenSettings.at(-1)).toEqual({ capitalStyle: null })

		const response = await post(admin, {
			intent: 'set-card-setting',
			setting: { key: 'capitalStyle', value: 'sentence' },
		})
		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({
			ok: true,
			settings: { capitalStyle: 'sentence' },
		})

		seenSettings.length = 0
		await generateCards(admin)
		expect(seenSettings.at(-1)).toEqual({ capitalStyle: 'sentence' })

		// Accept plans with the setting too.
		seenSettings.length = 0
		const [card] = await generateCards(admin)
		await post(admin, { intent: 'apply-card', card: toApply(card!) })
		expect(seenSettings.every((s) => (s as { capitalStyle: string }).capitalStyle === 'sentence')).toBe(true)

		// Another organization is unaffected.
		const other = await setup()
		flagOrgs.push(other.organization.id)
		await dish(other.organization.id, complete('Card B'))
		seenSettings.length = 0
		await generateCards(other)
		expect(seenSettings.at(-1)).toEqual({ capitalStyle: null })
	})

	it('refuses an unknown setting key or value', async () => {
		const admin = await setup()
		for (const setting of [
			{ key: 'capitalStyle', value: 'shouting' },
			{ key: 'other', value: 'title' },
			{ key: 'capitalStyle' },
		]) {
			const response = await post(admin, { intent: 'set-card-setting', setting })
			expect(response.status).toBe(400)
		}
	})
})
