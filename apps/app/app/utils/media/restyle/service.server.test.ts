/**
 * #146: restyle the whole menu's photos, review before publishing. The model
 * and storage are the external boundaries (a mock adapter, in-memory storage);
 * the rules, records, comparisons and decisions run against the real test
 * database.
 */
import {
	RESTYLE_DAILY_BUDGET,
	RESTYLE_DRAFT_TTL_DAYS,
	RESTYLE_MAX_PHOTOS_PER_RUN,
} from '@repo/common/media-restyle'
import {
	and,
	db,
	eq,
	MediaRestyleRun,
	MediaRestyleRunItem,
	OrganizationMediaAsset,
	OrganizationMenuCategory,
	OrganizationMenuItem,
	OrganizationMenuItemCategoryAssignment,
} from '@repo/database'
import type * as DatabaseModule from '@repo/database'
import { describe, expect, it, vi } from 'vitest'
import { setOrgFlag, setupSeoOrganization } from '#tests/seo-utils.ts'
import { createMockRestyleAdapter } from './adapter.server.ts'
import {
	keepRestyleOriginal,
	retryRestyleItem,
	switchBackRestyleItem,
	applyAllRestyleDrafts,
	applyRestyleDraft,
} from './decisions.server.ts'
import {
	processRestyleRun,
	pruneRestyleDrafts,
	sweepRestyleRuns,
} from './process.server.ts'
import {
	cancelRestyleRun,
	getRestyleRun,
	listRestyleRuns,
	previewRestyleRun,
	startRestyleRun,
	type RestyleDeps,
} from './service.server.ts'

/**
 * `db.batch` is the one write that must be atomic on D1. These hooks let a
 * test act just before it (another writer gets in between a read and the
 * batch) or make it fail, on the real test database.
 */
const batchHooks = vi.hoisted(() => ({
	before: null as null | (() => Promise<void>),
	failNext: false,
}))

vi.mock('@repo/database', async (importOriginal) => {
	const actual = await importOriginal<typeof DatabaseModule>()
	return {
		...actual,
		db: new Proxy(actual.db, {
			get(target, prop, receiver) {
				if (prop === 'batch') {
					return async (...args: Parameters<typeof actual.db.batch>) => {
						if (batchHooks.failNext) {
							batchHooks.failNext = false
							throw new Error('d1 down')
						}
						if (batchHooks.before) {
							const run = batchHooks.before
							batchHooks.before = null
							await run()
						}
						return target.batch(...args)
					}
				}
				return Reflect.get(target, prop, receiver)
			},
		}),
	}
})

const NOW = Date.UTC(2026, 10, 21, 12, 0, 0)
const DAY = 86_400_000
const PNG = Uint8Array.from(
	atob(
		'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
	),
	(char) => char.charCodeAt(0),
)

type Ctx = Awaited<ReturnType<typeof setup>>

async function setup() {
	const ctx = await setupSeoOrganization()
	await setOrgFlag(ctx.organization.id, 'media.restyle', true)
	return ctx
}

async function asset(
	organizationId: string,
	values: Partial<typeof OrganizationMediaAsset.$inferInsert> = {},
) {
	const [row] = await db
		.insert(OrganizationMediaAsset)
		.values({
			organizationId,
			objectKey: `orgs/${organizationId}/media/images/${crypto.randomUUID()}.jpg`,
			mimeType: 'image/jpeg',
			width: 1600,
			height: 1200,
			...values,
		})
		.returning()
	return row!
}

/** A dish; with `photo` it shows that library asset as its main photo. */
async function dish(
	organizationId: string,
	name: string,
	photo?: { id: string; objectKey: string } | null,
) {
	const [row] = await db
		.insert(OrganizationMenuItem)
		.values({
			organizationId,
			displayName: name,
			imageKey: photo?.objectKey ?? null,
			imageKeys: JSON.stringify(photo ? [photo.objectKey] : []),
			imageUrl: photo ? `/resources/images?mediaId=${photo.id}&v=1` : null,
		})
		.returning()
	return row!
}

async function dishWithPhoto(organizationId: string, name: string) {
	const photo = await asset(organizationId)
	return { photo, dish: await dish(organizationId, name, photo) }
}

function harness(overrides: Partial<RestyleDeps> = {}) {
	const stored: string[] = []
	const removed: string[] = []
	const adapter = createMockRestyleAdapter()
	const wake = vi.fn(async (_runId: string) => true)
	const deps: RestyleDeps = {
		adapter,
		now: () => NOW,
		wake,
		killSwitch: () => false,
		readSource: async () => ({ data: PNG, mediaType: 'image/png' }),
		store: vi.fn(async (organizationId: string, file: File) => {
			const key = `orgs/${organizationId}/media/images/${crypto.randomUUID()}.png`
			stored.push(key)
			return {
				key,
				mimeType: 'image/png',
				extension: 'png',
				file,
				width: 1,
				height: 1,
			}
		}) as never,
		remove: vi.fn(async (key: string) => {
			removed.push(key)
		}),
		...overrides,
	}
	return { deps, adapter, wake, stored, removed }
}

async function start(
	ctx: Ctx,
	deps: RestyleDeps,
	extra: { presetId?: unknown; categoryIds?: string[]; options?: unknown } = {},
) {
	return startRestyleRun(
		{
			organizationId: ctx.organization.id,
			userId: ctx.userId,
			presetId: extra.presetId ?? 'clean-white',
			options: extra.options,
			categoryIds: extra.categoryIds,
		},
		deps,
	)
}

/** Runs the job until it says it is done, or stops moving. */
async function drain(runId: string, deps: RestyleDeps, maxCalls = 100) {
	let last
	for (let i = 0; i < maxCalls; i++) {
		last = await processRestyleRun(runId, deps)
		if (last.done || last.paused || last.processed === 0) break
	}
	return last!
}

async function items(runId: string) {
	return db
		.select()
		.from(MediaRestyleRunItem)
		.where(eq(MediaRestyleRunItem.runId, runId))
}

async function dishRow(id: string) {
	const [row] = await db
		.select()
		.from(OrganizationMenuItem)
		.where(eq(OrganizationMenuItem.id, id))
	return row!
}

function actor(ctx: Ctx) {
	return {
		organization: { id: ctx.organization.id, slug: ctx.organization.slug },
		userId: ctx.userId,
	}
}

async function readyRun(ctx: Ctx, dishes = 2) {
	const made = []
	for (let i = 0; i < dishes; i++) {
		made.push(await dishWithPhoto(ctx.organization.id, `Dish ${i}`))
	}
	const { deps, ...rest } = harness()
	const started = await start(ctx, deps)
	if (!started.ok) throw new Error(started.error)
	await drain(started.runId, deps)
	const rows = await items(started.runId)
	return { made, runId: started.runId, deps, rows, ...rest }
}

describe('a run (#146 criterion 1)', () => {
	it('drafts every dish with a photo, leaves live photos byte for byte alone and lists the dishes without one', async () => {
		const ctx = await setup()
		const withPhoto = await Promise.all(
			[0, 1, 2, 3, 4].map((i) =>
				dishWithPhoto(ctx.organization.id, `Dish ${i}`),
			),
		)
		const noPhoto = await dish(ctx.organization.id, 'Plain soup')
		const before = await Promise.all(
			[...withPhoto.map((entry) => entry.dish), noPhoto].map((row) =>
				dishRow(row.id),
			),
		)
		const { deps, adapter, wake, stored } = harness()

		const started = await start(ctx, deps)
		expect(started).toMatchObject({ ok: true, total: 6, skipped: 1 })
		if (!started.ok) return
		expect(wake).toHaveBeenCalledWith(started.runId)

		const outcome = await drain(started.runId, deps)
		expect(outcome).toMatchObject({ done: true, paused: false })

		const [run] = await db
			.select()
			.from(MediaRestyleRun)
			.where(eq(MediaRestyleRun.id, started.runId))
		expect(run).toMatchObject({
			status: 'ready',
			total: 6,
			done: 5,
			failed: 0,
			skipped: 1,
		})
		const rows = await items(started.runId)
		const drafted = rows.filter((row) => row.status === 'drafted')
		expect(drafted).toHaveLength(5)
		expect(rows.filter((row) => row.status === 'skipped')).toEqual([
			expect.objectContaining({
				itemId: noPhoto.id,
				skipReason: 'no_photo',
				draftAssetId: null,
			}),
		])
		for (const row of drafted) {
			const [draft] = await db
				.select()
				.from(OrganizationMediaAsset)
				.where(eq(OrganizationMediaAsset.id, row.draftAssetId!))
			expect(draft).toMatchObject({
				source: 'restyle',
				status: 'draft',
				parentAssetId: row.sourceAssetId,
				createdById: ctx.userId,
				objectKey: row.draftObjectKey,
			})
		}
		expect(stored).toHaveLength(5)

		// Criterion 1: nothing about a live dish changed, not one byte.
		const after = await Promise.all(before.map((row) => dishRow(row.id)))
		expect(after).toEqual(before)

		// The model got the photo and the style, no organization data beyond ids.
		expect(adapter.calls).toHaveLength(5)
		expect(adapter.calls[0]).toMatchObject({
			style: { presetId: 'clean-white' },
			aspectRatio: '4:3',
		})
	})

	it('limits a run to chosen categories and what sits under them', async () => {
		const ctx = await setup()
		const org = ctx.organization.id
		const [mains, pasta, drinks] = await db
			.insert(OrganizationMenuCategory)
			.values([
				{ organizationId: org, displayName: 'Mains' },
				{ organizationId: org, displayName: 'Pasta' },
				{ organizationId: org, displayName: 'Drinks' },
			])
			.returning()
		await db
			.update(OrganizationMenuCategory)
			.set({ parentId: mains!.id })
			.where(eq(OrganizationMenuCategory.id, pasta!.id))
		const steak = await dishWithPhoto(org, 'Steak')
		const lasagne = await dishWithPhoto(org, 'Lasagne')
		const cola = await dishWithPhoto(org, 'Cola')
		await db.insert(OrganizationMenuItemCategoryAssignment).values([
			{ categoryId: mains!.id, itemId: steak.dish.id },
			{ categoryId: pasta!.id, itemId: lasagne.dish.id },
			{ categoryId: drinks!.id, itemId: cola.dish.id },
		])
		const { deps } = harness()
		expect(await previewRestyleRun(org, [mains!.id])).toMatchObject({
			ok: true,
			withPhoto: 2,
			withoutPhoto: 0,
		})
		const started = await start(ctx, deps, { categoryIds: [mains!.id] })
		if (!started.ok) throw new Error(started.error)
		expect(
			(await items(started.runId)).map((row) => row.itemId).sort(),
		).toEqual([steak.dish.id, lasagne.dish.id].sort())
	})

	it('refuses an unknown style and a foreign category, and creates nothing', async () => {
		const ctx = await setup()
		const other = await setupSeoOrganization()
		const foreign = await db
			.insert(OrganizationMenuCategory)
			.values({ organizationId: other.organization.id, displayName: 'Theirs' })
			.returning()
		await dishWithPhoto(ctx.organization.id, 'Dish')
		const { deps } = harness()
		expect(await start(ctx, deps, { presetId: 'nope' })).toEqual({
			ok: false,
			error: 'invalid_style',
		})
		expect(await start(ctx, deps, { categoryIds: [foreign[0]!.id] })).toEqual({
			ok: false,
			error: 'invalid_categories',
		})
		expect(await listRestyleRuns(ctx.organization.id)).toMatchObject({
			runs: [],
		})
	})

	it('skips a main photo that is not in the library and says why', async () => {
		const ctx = await setup()
		const loose = await dish(ctx.organization.id, 'Loose', {
			id: 'x',
			objectKey: 'orgs/elsewhere/media/images/not-in-library.jpg',
		})
		const real = await dishWithPhoto(ctx.organization.id, 'Real')
		const { deps } = harness()
		const started = await start(ctx, deps)
		if (!started.ok) throw new Error(started.error)
		const rows = await items(started.runId)
		expect(rows.find((row) => row.itemId === loose.id)).toMatchObject({
			status: 'skipped',
			skipReason: 'photo_not_in_library',
		})
		expect(rows.find((row) => row.itemId === real.dish.id)?.status).toBe(
			'pending',
		)
	})
})

describe('one run at a time, and the size cap', () => {
	it('refuses a second run while one is active, then allows one once it is cancelled', async () => {
		const ctx = await setup()
		await dishWithPhoto(ctx.organization.id, 'A')
		const { deps } = harness()
		const first = await start(ctx, deps)
		expect(first.ok).toBe(true)
		expect(await start(ctx, deps)).toEqual({
			ok: false,
			error: 'restyle_in_progress',
		})
		if (!first.ok) return
		expect(
			await cancelRestyleRun(
				{ organizationId: ctx.organization.id, runId: first.runId },
				deps,
			),
		).toEqual({ ok: true })
		expect((await start(ctx, deps)).ok).toBe(true)
	})

	it('takes the later of two simultaneous starts back out', async () => {
		const ctx = await setup()
		await dishWithPhoto(ctx.organization.id, 'A')
		const { deps } = harness()
		const results = await Promise.all([start(ctx, deps), start(ctx, deps)])
		expect(results.filter((result) => result.ok)).toHaveLength(1)
		expect(
			await db
				.select()
				.from(MediaRestyleRun)
				.where(eq(MediaRestyleRun.organizationId, ctx.organization.id)),
		).toHaveLength(1)
	})

	it('refuses more than 200 photos and creates nothing; zero photos is nothing to restyle', async () => {
		const ctx = await setup()
		const { deps } = harness()
		await dish(ctx.organization.id, 'No photo')
		expect(await start(ctx, deps)).toEqual({
			ok: false,
			error: 'nothing_to_restyle',
		})
		const photo = await asset(ctx.organization.id)
		const rows = Array.from(
			{ length: RESTYLE_MAX_PHOTOS_PER_RUN + 1 },
			(_, i) => ({
				organizationId: ctx.organization.id,
				displayName: `Bulk ${i}`,
				imageKey: photo.objectKey,
				imageKeys: JSON.stringify([photo.objectKey]),
			}),
		)
		for (let i = 0; i < rows.length; i += 20) {
			await db.insert(OrganizationMenuItem).values(rows.slice(i, i + 20))
		}
		expect(await start(ctx, deps)).toEqual({
			ok: false,
			error: 'too_many_photos',
		})
		expect((await listRestyleRuns(ctx.organization.id)).runs).toEqual([])
		expect(await previewRestyleRun(ctx.organization.id, [])).toMatchObject({
			ok: true,
			withPhoto: RESTYLE_MAX_PHOTOS_PER_RUN + 1,
			tooMany: true,
		})
	})
})

describe('use and switch back (#146 criterion 2)', () => {
	it('makes the draft the main photo, keeps the original in the library as its parent, and switches back in one call', async () => {
		const ctx = await setup()
		const { made, runId, rows } = await readyRun(ctx, 1)
		const { dish: live, photo: original } = made[0]!
		const row = rows[0]!
		const draftKey = row.draftObjectKey!

		const used = await applyRestyleDraft({
			...actor(ctx),
			runId,
			itemRowId: row.id,
		})
		expect(used).toEqual({ ok: true, previousKey: original.objectKey })
		const after = await dishRow(live.id)
		expect(JSON.parse(after.imageKeys)).toEqual([draftKey])
		expect(after.imageKey).toBe(draftKey)
		expect(after.imageUrl).toContain(row.draftAssetId!)
		const [draft] = await db
			.select()
			.from(OrganizationMediaAsset)
			.where(eq(OrganizationMediaAsset.id, row.draftAssetId!))
		expect(draft).toMatchObject({ status: 'ready', parentAssetId: original.id })
		// The original is still in the library, untouched.
		const [still] = await db
			.select()
			.from(OrganizationMediaAsset)
			.where(eq(OrganizationMediaAsset.id, original.id))
		expect(still).toMatchObject({
			objectKey: original.objectKey,
			status: 'ready',
		})
		const [decided] = await items(runId)
		expect(decided).toMatchObject({
			decision: 'used',
			replacedAssetKey: original.objectKey,
		})

		// A second use is refused: it was decided already.
		expect(
			await applyRestyleDraft({ ...actor(ctx), runId, itemRowId: row.id }),
		).toEqual({ ok: false, error: 'already_decided' })

		const back = await switchBackRestyleItem({
			...actor(ctx),
			runId,
			itemRowId: row.id,
		})
		expect(back).toEqual({ ok: true })
		const restored = await dishRow(live.id)
		expect(restored.imageKey).toBe(original.objectKey)
		expect(JSON.parse(restored.imageKeys)).toEqual([original.objectKey])
		const [afterBack] = await items(runId)
		expect(afterBack?.decision).toBe('kept')
		// The restyled photo stays in the library as a ready asset.
		const [kept] = await db
			.select()
			.from(OrganizationMediaAsset)
			.where(eq(OrganizationMediaAsset.id, row.draftAssetId!))
		expect(kept?.status).toBe('ready')
	})

	it('switch back is only for a used draft and refuses when the dish photo changed since', async () => {
		const ctx = await setup()
		const { made, runId, rows } = await readyRun(ctx, 1)
		const row = rows[0]!
		expect(
			await switchBackRestyleItem({ ...actor(ctx), runId, itemRowId: row.id }),
		).toEqual({ ok: false, error: 'not_used' })
		await applyRestyleDraft({ ...actor(ctx), runId, itemRowId: row.id })
		const newer = await asset(ctx.organization.id)
		await db
			.update(OrganizationMenuItem)
			.set({
				imageKey: newer.objectKey,
				imageKeys: JSON.stringify([newer.objectKey]),
			})
			.where(eq(OrganizationMenuItem.id, made[0]!.dish.id))
		expect(
			await switchBackRestyleItem({ ...actor(ctx), runId, itemRowId: row.id }),
		).toEqual({ ok: false, error: 'photo_changed' })
		expect((await dishRow(made[0]!.dish.id)).imageKey).toBe(newer.objectKey)
	})
})

describe('use is refused when the dish moved on (#146 criterion 3)', () => {
	it('photo_changed: nothing changes, not the dish and not the draft', async () => {
		const ctx = await setup()
		const { made, runId, rows } = await readyRun(ctx, 1)
		const row = rows[0]!
		const newer = await asset(ctx.organization.id)
		await db
			.update(OrganizationMenuItem)
			.set({
				imageKey: newer.objectKey,
				imageKeys: JSON.stringify([newer.objectKey]),
			})
			.where(eq(OrganizationMenuItem.id, made[0]!.dish.id))
		const before = await dishRow(made[0]!.dish.id)

		expect(
			await applyRestyleDraft({ ...actor(ctx), runId, itemRowId: row.id }),
		).toEqual({ ok: false, error: 'photo_changed' })
		expect(await dishRow(made[0]!.dish.id)).toEqual(before)
		const [draft] = await db
			.select()
			.from(OrganizationMediaAsset)
			.where(eq(OrganizationMediaAsset.id, row.draftAssetId!))
		expect(draft?.status).toBe('draft')
		expect((await items(runId))[0]?.decision).toBeNull()
	})

	it('photo_changed also when the dish changes between the check and the write', async () => {
		const ctx = await setup()
		const { made, runId, rows } = await readyRun(ctx, 1)
		const row = rows[0]!
		const newer = await asset(ctx.organization.id)
		// The dish form saves in the middle of "Use new": the compare and set
		// in the batch catches it even though the early check passed.
		batchHooks.before = async () => {
			await db
				.update(OrganizationMenuItem)
				.set({
					imageKey: newer.objectKey,
					imageKeys: JSON.stringify([newer.objectKey]),
				})
				.where(eq(OrganizationMenuItem.id, made[0]!.dish.id))
		}
		const result = await applyRestyleDraft({
			...actor(ctx),
			runId,
			itemRowId: row.id,
		})
		expect(result).toEqual({ ok: false, error: 'photo_changed' })
		expect((await dishRow(made[0]!.dish.id)).imageKey).toBe(newer.objectKey)
		expect((await items(runId))[0]?.decision).toBeNull()
	})

	it('draft_changed when the stored draft is not the one the run made, or the page showed another', async () => {
		const ctx = await setup()
		const { made, runId, rows } = await readyRun(ctx, 2)
		const [first, second] = rows
		await db
			.update(OrganizationMediaAsset)
			.set({
				objectKey: `orgs/${ctx.organization.id}/media/images/swapped.png`,
			})
			.where(eq(OrganizationMediaAsset.id, first!.draftAssetId!))
		expect(
			await applyRestyleDraft({ ...actor(ctx), runId, itemRowId: first!.id }),
		).toEqual({ ok: false, error: 'draft_changed' })
		expect(
			await applyRestyleDraft({
				...actor(ctx),
				runId,
				itemRowId: second!.id,
				draftKey: 'orgs/x/media/images/an-older-draft.png',
			}),
		).toEqual({ ok: false, error: 'draft_changed' })
		for (const entry of made) {
			expect((await dishRow(entry.dish.id)).imageKey).toBe(
				entry.photo.objectKey,
			)
		}
	})

	it('draft_missing when there is no draft (a dish that was skipped)', async () => {
		const ctx = await setup()
		await dishWithPhoto(ctx.organization.id, 'A')
		const noPhoto = await dish(ctx.organization.id, 'B')
		const { deps } = harness()
		const started = await start(ctx, deps)
		if (!started.ok) throw new Error(started.error)
		const skipped = (await items(started.runId)).find(
			(row) => row.itemId === noPhoto.id,
		)!
		expect(
			await applyRestyleDraft({
				...actor(ctx),
				runId: started.runId,
				itemRowId: skipped.id,
			}),
		).toEqual({ ok: false, error: 'draft_missing' })
	})
})

describe('keep, try again and use all', () => {
	it('keep original deletes the draft and leaves the dish and the original alone', async () => {
		const ctx = await setup()
		const { made, runId, rows, removed } = await readyRun(ctx, 1)
		const row = rows[0]!
		const result = await keepRestyleOriginal(
			{
				organizationId: ctx.organization.id,
				runId,
				itemRowId: row.id,
			},
			{ remove: vi.fn(async (key: string) => void removed.push(key)) as never },
		)
		expect(result).toEqual({ ok: true })
		expect(
			await db
				.select()
				.from(OrganizationMediaAsset)
				.where(eq(OrganizationMediaAsset.id, row.draftAssetId!)),
		).toEqual([])
		expect(removed).toContain(row.draftObjectKey)
		expect((await dishRow(made[0]!.dish.id)).imageKey).toBe(
			made[0]!.photo.objectKey,
		)
		expect((await items(runId))[0]).toMatchObject({
			decision: 'kept',
			draftAssetId: null,
		})
		expect(
			await keepRestyleOriginal({
				organizationId: ctx.organization.id,
				runId,
				itemRowId: row.id,
			}),
		).toEqual({ ok: false, error: 'already_decided' })
	})

	it('try again drops the old draft, makes a new one and wakes the run', async () => {
		const ctx = await setup()
		const { runId, rows, deps, wake, adapter } = await readyRun(ctx, 1)
		const row = rows[0]!
		const result = await retryRestyleItem(
			{ organizationId: ctx.organization.id, runId, itemRowId: row.id },
			deps,
		)
		expect(result).toEqual({ ok: true })
		expect(wake).toHaveBeenLastCalledWith(runId)
		const [reset] = await items(runId)
		expect(reset).toMatchObject({
			status: 'pending',
			attempts: 0,
			decision: null,
			draftAssetId: null,
		})
		expect(
			await db
				.select()
				.from(OrganizationMediaAsset)
				.where(eq(OrganizationMediaAsset.id, row.draftAssetId!)),
		).toEqual([])
		await drain(runId, deps)
		const [again] = await items(runId)
		expect(again?.status).toBe('drafted')
		expect(again?.draftAssetId).not.toBe(row.draftAssetId)
		expect(adapter.calls).toHaveLength(2)
	})

	it('try again is refused for a used draft, while the kill switch is on, and while another run is active', async () => {
		const ctx = await setup()
		const { runId, rows, deps } = await readyRun(ctx, 1)
		const row = rows[0]!
		const input = {
			organizationId: ctx.organization.id,
			runId,
			itemRowId: row.id,
		}
		expect(
			await retryRestyleItem(input, { ...deps, killSwitch: () => true }),
		).toEqual({ ok: false, error: 'restyle_paused' })
		expect(await retryRestyleItem(input, { ...deps, adapter: null })).toEqual({
			ok: false,
			error: 'not_configured',
		})
		await dishWithPhoto(ctx.organization.id, 'Another')
		const second = await start(ctx, deps)
		expect(second.ok).toBe(true)
		expect(await retryRestyleItem(input, deps)).toEqual({
			ok: false,
			error: 'restyle_in_progress',
		})
		if (!second.ok) return
		await cancelRestyleRun(
			{ organizationId: ctx.organization.id, runId: second.runId },
			deps,
		)
		await applyRestyleDraft({ ...actor(ctx), runId, itemRowId: row.id })
		expect(await retryRestyleItem(input, deps)).toEqual({
			ok: false,
			error: 'already_decided',
		})
	})

	it('use all uses every open draft, counts a changed dish as refused and never overwrites it', async () => {
		const ctx = await setup()
		const { made, runId } = await readyRun(ctx, 3)
		const newer = await asset(ctx.organization.id)
		await db
			.update(OrganizationMenuItem)
			.set({
				imageKey: newer.objectKey,
				imageKeys: JSON.stringify([newer.objectKey]),
			})
			.where(eq(OrganizationMenuItem.id, made[1]!.dish.id))
		const result = await applyAllRestyleDrafts({ ...actor(ctx), runId })
		expect(result).toEqual({
			ok: true,
			used: 2,
			remaining: 0,
			refused: [{ itemId: made[1]!.dish.id, error: 'photo_changed' }],
		})
		expect((await dishRow(made[1]!.dish.id)).imageKey).toBe(newer.objectKey)
		for (const index of [0, 2]) {
			expect((await dishRow(made[index]!.dish.id)).imageKey).not.toBe(
				made[index]!.photo.objectKey,
			)
		}
		// Nothing left to decide except the refused dish.
		expect(await applyAllRestyleDrafts({ ...actor(ctx), runId })).toMatchObject(
			{
				used: 0,
				refused: [{ itemId: made[1]!.dish.id, error: 'photo_changed' }],
			},
		)
	})

	it('use all can be cut short and says how many are left', async () => {
		const ctx = await setup()
		const { runId } = await readyRun(ctx, 3)
		expect(
			await applyAllRestyleDrafts({ ...actor(ctx), runId, limit: 2 }),
		).toMatchObject({ used: 2, remaining: 1 })
	})
})

describe('the daily budget', () => {
	async function spendBudget(
		ctx: Ctx,
		at: number,
		count = RESTYLE_DAILY_BUDGET,
	) {
		const [other] = await db
			.insert(MediaRestyleRun)
			.values({
				organizationId: ctx.organization.id,
				style: JSON.stringify({ type: 'preset', presetId: 'clean-white' }),
				status: 'ready',
			})
			.returning()
		const dishes = await db
			.insert(OrganizationMenuItem)
			.values(
				Array.from({ length: Math.min(count, 20) }, (_, i) => ({
					organizationId: ctx.organization.id,
					displayName: `Spent ${i}`,
				})),
			)
			.returning({ id: OrganizationMenuItem.id })
		// Spread the budget over the dishes: `count` rows need `count` dishes,
		// so reuse the ones made with one run per 20.
		let remaining = count
		let run = other!
		while (remaining > 0) {
			const batch = dishes.slice(0, Math.min(remaining, dishes.length))
			await db.insert(MediaRestyleRunItem).values(
				batch.map((entry) => ({
					runId: run.id,
					organizationId: ctx.organization.id,
					itemId: entry.id,
					status: 'drafted',
					processedAt: new Date(at),
				})),
			)
			remaining -= batch.length
			if (remaining > 0) {
				run = (
					await db
						.insert(MediaRestyleRun)
						.values({
							organizationId: ctx.organization.id,
							style: JSON.stringify({
								type: 'preset',
								presetId: 'clean-white',
							}),
							status: 'ready',
						})
						.returning()
				)[0]!
			}
		}
	}

	it('pauses at the budget with the next UTC midnight as resume time, and goes on the next day', async () => {
		const ctx = await setup()
		await spendBudget(ctx, NOW - 60_000)
		await dishWithPhoto(ctx.organization.id, 'A')
		await dishWithPhoto(ctx.organization.id, 'B')
		const { deps, adapter } = harness()
		const started = await start(ctx, deps)
		if (!started.ok) throw new Error(started.error)

		const paused = await processRestyleRun(started.runId, deps)
		const midnight = new Date(Date.UTC(2026, 10, 22))
		expect(paused).toMatchObject({ done: false, paused: true, processed: 0 })
		expect(paused.resumeAt?.getTime()).toBe(midnight.getTime())
		expect(adapter.calls).toHaveLength(0)
		const [run] = await db
			.select()
			.from(MediaRestyleRun)
			.where(eq(MediaRestyleRun.id, started.runId))
		expect(run).toMatchObject({ status: 'paused' })
		expect(run?.resumeAt?.getTime()).toBe(midnight.getTime())

		// Still paused before midnight, no matter how often it is asked.
		const early = await processRestyleRun(started.runId, {
			...deps,
			now: () => midnight.getTime() - 1,
		})
		expect(early).toMatchObject({ paused: true, processed: 0 })
		expect(adapter.calls).toHaveLength(0)

		// The sweep resumes it once the day came, and the next call restyles.
		const swept = await sweepRestyleRuns({
			...deps,
			now: () => midnight.getTime() + 1,
		})
		expect(swept.swept).toBe(1)
		expect(deps.wake).toHaveBeenLastCalledWith(started.runId)
		const later = { ...deps, now: () => midnight.getTime() + 1000 }
		const done = await drain(started.runId, later)
		expect(done).toMatchObject({ done: true, paused: false })
		expect(adapter.calls).toHaveLength(2)
	})

	it('stops a batch exactly at the budget and pauses with work left', async () => {
		const ctx = await setup()
		await spendBudget(ctx, NOW - 60_000, RESTYLE_DAILY_BUDGET - 1)
		await dishWithPhoto(ctx.organization.id, 'A')
		await dishWithPhoto(ctx.organization.id, 'B')
		const { deps, adapter } = harness()
		const started = await start(ctx, deps)
		if (!started.ok) throw new Error(started.error)
		const outcome = await processRestyleRun(started.runId, deps)
		expect(adapter.calls).toHaveLength(1)
		expect(outcome).toMatchObject({ paused: true, processed: 1 })
	})

	it('yesterday does not count against today', async () => {
		const ctx = await setup()
		await spendBudget(ctx, Date.UTC(2026, 10, 20, 23, 59))
		await dishWithPhoto(ctx.organization.id, 'A')
		const { deps } = harness()
		const started = await start(ctx, deps)
		if (!started.ok) throw new Error(started.error)
		expect(await drain(started.runId, deps)).toMatchObject({ done: true })
	})
})

describe('failures', () => {
	it('puts a dish back while attempts are left, then fails it with a short reason', async () => {
		const ctx = await setup()
		await dishWithPhoto(ctx.organization.id, 'A')
		const adapter = createMockRestyleAdapter({ fail: 'unavailable' })
		const { deps } = harness({ adapter })
		const started = await start(ctx, deps)
		if (!started.ok) throw new Error(started.error)
		const first = await processRestyleRun(started.runId, deps)
		expect(first).toMatchObject({ processed: 0, retry: true, done: false })
		expect((await items(started.runId))[0]).toMatchObject({
			status: 'pending',
			attempts: 1,
		})
		const second = await processRestyleRun(started.runId, deps)
		expect(second).toMatchObject({ processed: 1, done: true })
		expect((await items(started.runId))[0]).toMatchObject({
			status: 'failed',
			error: 'unavailable',
		})
		const [run] = await db
			.select()
			.from(MediaRestyleRun)
			.where(eq(MediaRestyleRun.id, started.runId))
		expect(run).toMatchObject({ status: 'ready', failed: 1, done: 0 })
	})

	it('fails a dish for good on an answer that will not change, and one bad dish does not stop the rest', async () => {
		const ctx = await setup()
		const a = await dishWithPhoto(ctx.organization.id, 'A')
		const b = await dishWithPhoto(ctx.organization.id, 'B')
		const adapter = createMockRestyleAdapter({
			fail: 'unsupported_image',
			failOnCall: 0,
		})
		const { deps } = harness({ adapter })
		const started = await start(ctx, deps)
		if (!started.ok) throw new Error(started.error)
		await drain(started.runId, deps)
		const rows = await items(started.runId)
		expect(rows.find((row) => row.itemId === a.dish.id)).toMatchObject({
			status: 'failed',
			error: 'unsupported_image',
		})
		expect(rows.find((row) => row.itemId === b.dish.id)?.status).toBe('drafted')
	})

	it('does not use a model answer that is not a picture, and stores nothing', async () => {
		const ctx = await setup()
		await dishWithPhoto(ctx.organization.id, 'A')
		const { deps, stored } = harness({
			adapter: createMockRestyleAdapter({ invalid: true }),
		})
		const started = await start(ctx, deps)
		if (!started.ok) throw new Error(started.error)
		await drain(started.runId, deps)
		await drain(started.runId, deps)
		expect((await items(started.runId))[0]).toMatchObject({
			status: 'failed',
			error: 'invalid_output',
		})
		expect(stored).toEqual([])
	})

	it('removes the stored file when the draft cannot be recorded', async () => {
		const ctx = await setup()
		await dishWithPhoto(ctx.organization.id, 'A')
		const { deps, stored, removed } = harness()
		const started = await start(ctx, deps)
		if (!started.ok) throw new Error(started.error)
		batchHooks.failNext = true
		const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
		const outcome = await processRestyleRun(started.runId, deps)
		expect(logged).toHaveBeenCalled()
		logged.mockRestore()
		expect(outcome).toMatchObject({ processed: 0, retry: true })
		expect(removed).toEqual(stored)
		expect(
			await db
				.select()
				.from(OrganizationMediaAsset)
				.where(
					and(
						eq(OrganizationMediaAsset.organizationId, ctx.organization.id),
						eq(OrganizationMediaAsset.source, 'restyle'),
					),
				),
		).toEqual([])
	})

	it('spends no model call on a dish whose photo changed after the run started', async () => {
		const ctx = await setup()
		const a = await dishWithPhoto(ctx.organization.id, 'A')
		const { deps, adapter } = harness()
		const started = await start(ctx, deps)
		if (!started.ok) throw new Error(started.error)
		const newer = await asset(ctx.organization.id)
		await db
			.update(OrganizationMenuItem)
			.set({
				imageKey: newer.objectKey,
				imageKeys: JSON.stringify([newer.objectKey]),
			})
			.where(eq(OrganizationMenuItem.id, a.dish.id))
		await drain(started.runId, deps)
		expect(adapter.calls).toHaveLength(0)
		expect((await items(started.runId))[0]).toMatchObject({
			status: 'skipped',
			skipReason: 'photo_changed',
		})
	})

	it('two callers never restyle the same dish', async () => {
		const ctx = await setup()
		for (let i = 0; i < 3; i++)
			await dishWithPhoto(ctx.organization.id, `D${i}`)
		const { deps, adapter } = harness()
		const started = await start(ctx, deps)
		if (!started.ok) throw new Error(started.error)
		await Promise.all([
			processRestyleRun(started.runId, deps),
			processRestyleRun(started.runId, deps),
		])
		await drain(started.runId, deps)
		expect(adapter.calls).toHaveLength(3)
		const rows = await items(started.runId)
		expect(new Set(rows.map((row) => row.draftObjectKey)).size).toBe(3)
	})

	it('takes over a claim nobody finished after ten minutes, and fails it once attempts run out', async () => {
		const ctx = await setup()
		await dishWithPhoto(ctx.organization.id, 'A')
		const { deps, adapter } = harness()
		const started = await start(ctx, deps)
		if (!started.ok) throw new Error(started.error)
		const [row] = await items(started.runId)
		// A worker claimed it and died.
		await db
			.update(MediaRestyleRunItem)
			.set({ attempts: 1, updatedAt: new Date(NOW - 60_000) })
			.where(eq(MediaRestyleRunItem.id, row!.id))
		expect(await processRestyleRun(started.runId, deps)).toMatchObject({
			processed: 0,
		})
		expect(adapter.calls).toHaveLength(0)
		const later = { ...deps, now: () => NOW + 11 * 60_000 }
		expect(await drain(started.runId, later)).toMatchObject({ done: true })
		expect(adapter.calls).toHaveLength(1)
	})
})

describe('the kill switch', () => {
	it('stops starting, retrying and processing, but not reviewing', async () => {
		const ctx = await setup()
		await dishWithPhoto(ctx.organization.id, 'A')
		const { deps, adapter } = harness({ killSwitch: () => true })
		expect(await start(ctx, deps)).toEqual({
			ok: false,
			error: 'restyle_paused',
		})
		// A run that exists: the job answers paused with no resume time and
		// calls nothing.
		const on = harness()
		const started = await start(ctx, on.deps)
		if (!started.ok) throw new Error(started.error)
		expect(await processRestyleRun(started.runId, deps)).toEqual({
			done: false,
			paused: true,
			resumeAt: null,
			processed: 0,
		})
		expect(adapter.calls).toHaveLength(0)
		// The sweep does not wake or resume anything either.
		expect(await sweepRestyleRuns({ ...deps, now: () => NOW + DAY })).toEqual({
			swept: 0,
			pruned: 0,
		})
		// Reviewing and using existing drafts keeps working.
		await drain(started.runId, on.deps)
		const [row] = await items(started.runId)
		expect(
			await applyRestyleDraft({
				...actor(ctx),
				runId: started.runId,
				itemRowId: row!.id,
			}),
		).toMatchObject({ ok: true })
		expect(
			await getRestyleRun(ctx.organization.id, started.runId),
		).toMatchObject({ run: { status: 'ready' } })
	})

	it('a run cannot start with no model set up', async () => {
		const ctx = await setup()
		await dishWithPhoto(ctx.organization.id, 'A')
		const { deps } = harness({ adapter: null })
		expect(await start(ctx, deps)).toEqual({
			ok: false,
			error: 'not_configured',
		})
	})
})

describe('organization isolation', () => {
	it('a run or item of another organization is not found for every decision and for the review', async () => {
		const ctx = await setup()
		const other = await setup()
		const { runId, rows, deps } = await readyRun(ctx, 1)
		const row = rows[0]!
		const intruder = actor(other)
		const ids = { runId, itemRowId: row.id }

		expect(await getRestyleRun(other.organization.id, runId)).toBeNull()
		expect(await applyRestyleDraft({ ...intruder, ...ids })).toEqual({
			ok: false,
			error: 'not_found',
		})
		expect(await switchBackRestyleItem({ ...intruder, ...ids })).toEqual({
			ok: false,
			error: 'not_found',
		})
		expect(
			await keepRestyleOriginal({
				organizationId: other.organization.id,
				...ids,
			}),
		).toEqual({ ok: false, error: 'not_found' })
		expect(
			await retryRestyleItem(
				{ organizationId: other.organization.id, ...ids },
				deps,
			),
		).toEqual({ ok: false, error: 'not_found' })
		expect(await applyAllRestyleDrafts({ ...intruder, runId })).toEqual({
			ok: false,
			error: 'not_found',
		})
		expect(
			await cancelRestyleRun({ organizationId: other.organization.id, runId }),
		).toEqual({ ok: false, error: 'not_found' })
		expect(await listRestyleRuns(other.organization.id)).toMatchObject({
			runs: [],
		})

		// Nothing of the first organization moved.
		const [after] = await items(runId)
		expect(after).toMatchObject({ status: 'drafted', decision: null })
	})

	it('an item id of the right organization under another run is not found', async () => {
		const ctx = await setup()
		const first = await readyRun(ctx, 1)
		await db
			.update(MediaRestyleRun)
			.set({ status: 'cancelled' })
			.where(eq(MediaRestyleRun.id, first.runId))
		const second = await readyRun(ctx, 1)
		expect(
			await applyRestyleDraft({
				...actor(ctx),
				runId: second.runId,
				itemRowId: first.rows[0]!.id,
			}),
		).toEqual({ ok: false, error: 'not_found' })
	})
})

describe('pruning old drafts', () => {
	it('deletes drafts nobody chose after 30 days and never a used one or a live photo', async () => {
		const ctx = await setup()
		const { made, runId, rows, deps, removed } = await readyRun(ctx, 3)
		const [stale, used, fresh] = rows
		// One draft is used, one is fresh, one is older than 30 days.
		await applyRestyleDraft({ ...actor(ctx), runId, itemRowId: used!.id })
		const old = new Date(NOW - (RESTYLE_DRAFT_TTL_DAYS + 1) * DAY)
		await db
			.update(OrganizationMediaAsset)
			.set({ createdAt: old })
			.where(eq(OrganizationMediaAsset.id, stale!.draftAssetId!))
		await db
			.update(OrganizationMediaAsset)
			.set({ createdAt: old })
			.where(eq(OrganizationMediaAsset.id, used!.draftAssetId!))
		const liveBefore = await Promise.all(
			made.map((entry) => dishRow(entry.dish.id)),
		)

		expect(await pruneRestyleDrafts(deps)).toBe(1)
		expect(removed).toEqual([stale!.draftObjectKey])
		const kept = await db
			.select({ id: OrganizationMediaAsset.id })
			.from(OrganizationMediaAsset)
			.where(eq(OrganizationMediaAsset.source, 'restyle'))
		const keptIds = kept.map((row) => row.id)
		expect(keptIds).toContain(used!.draftAssetId)
		expect(keptIds).toContain(fresh!.draftAssetId)
		expect(keptIds).not.toContain(stale!.draftAssetId)
		const after = await items(runId)
		expect(after.find((row) => row.id === stale!.id)).toMatchObject({
			status: 'failed',
			error: 'draft_expired',
			draftAssetId: null,
		})
		expect(after.find((row) => row.id === used!.id)?.decision).toBe('used')
		// Live photos: only the used dish changed, through its own decision.
		expect(await dishRow(made[0]!.dish.id)).toEqual(liveBefore[0])
		expect(await dishRow(made[2]!.dish.id)).toEqual(liveBefore[2])
		const [run] = await db
			.select()
			.from(MediaRestyleRun)
			.where(eq(MediaRestyleRun.id, runId))
		expect(run).toMatchObject({ done: 2, failed: 1 })
	})

	it('keeps the stored file while something else still uses it', async () => {
		const ctx = await setup()
		const { runId, rows, deps, removed } = await readyRun(ctx, 1)
		const row = rows[0]!
		// A dish already shows this file, so it is in use.
		await dish(ctx.organization.id, 'Elsewhere', {
			id: row.draftAssetId!,
			objectKey: row.draftObjectKey!,
		})
		await db
			.update(OrganizationMediaAsset)
			.set({ createdAt: new Date(NOW - 40 * DAY) })
			.where(eq(OrganizationMediaAsset.id, row.draftAssetId!))
		expect(await pruneRestyleDrafts(deps)).toBe(1)
		expect(removed).toEqual([])
		expect((await items(runId))[0]).toMatchObject({ error: 'draft_expired' })
	})

	it('the sweep prunes too, and wakes a run that went quiet', async () => {
		const ctx = await setup()
		await dishWithPhoto(ctx.organization.id, 'A')
		const { deps, wake } = harness()
		const started = await start(ctx, deps)
		if (!started.ok) throw new Error(started.error)
		wake.mockClear()
		// Fresh: nothing to do.
		expect(await sweepRestyleRuns(deps)).toEqual({ swept: 0, pruned: 0 })
		// Idle for 16 minutes: woken again.
		await db
			.update(MediaRestyleRun)
			.set({ updatedAt: new Date(NOW - 16 * 60_000) })
			.where(eq(MediaRestyleRun.id, started.runId))
		expect(await sweepRestyleRuns(deps)).toEqual({ swept: 1, pruned: 0 })
		expect(wake).toHaveBeenCalledWith(started.runId)
	})
})

describe('listing', () => {
	it('lists runs with what waits for review and the daily budget, and a run with names and links', async () => {
		const ctx = await setup()
		const { runId } = await readyRun(ctx, 2)
		const listed = await listRestyleRuns(ctx.organization.id, NOW)
		expect(listed).toMatchObject({
			budget: RESTYLE_DAILY_BUDGET,
			usedToday: 2,
			budgetLeft: RESTYLE_DAILY_BUDGET - 2,
		})
		expect(listed.runs[0]).toMatchObject({
			id: runId,
			status: 'ready',
			presetId: 'clean-white',
			toReview: 2,
			toDo: 2,
		})
		const detail = await getRestyleRun(ctx.organization.id, runId)
		expect(detail?.items).toHaveLength(2)
		const first = detail?.items.find((item) => item.name === 'Dish 0')
		expect(first).toMatchObject({ status: 'drafted', decision: null })
		expect(first?.originalUrl).toContain('/resources/images?mediaId=')
		expect(first?.draftUrl).toContain('/resources/images?mediaId=')
		expect(first?.draftExpiresAt).toBeTruthy()
	})
})
