/**
 * #192 on the real database: starting, ending and serving dish photo tests.
 * The regional counters are a separate service (tenant-api); here the control
 * plane's rules are proved: photo B only reaches the web and QR menus, ending
 * keeps the winner on the dish everywhere and never deletes the loser.
 */
import { verifyPhotoTestBeaconKey } from '@repo/common/photo-test-key'
import {
	and,
	db,
	eq,
	MenuItemPhotoTest,
	OrganizationMediaAsset,
	OrganizationMenuItem,
} from '@repo/database'
import { describe, expect, it, vi } from 'vitest'
import { setOrgFlag, setupSeoOrganization } from '#tests/seo-utils.ts'
import {
	endPhotoTest,
	loadPublicPhotoTests,
	startPhotoTest,
	stopPhotoTestsForChangedDish,
} from './photo-tests.server.ts'

const SECRET = 'operator-secret-operator-secret-1234'
vi.stubEnv('TENANT_OPERATOR_TOKEN', SECRET)

vi.mock('#app/utils/sites/kv-cache.server.ts', () => ({
	purgeOrganizationSiteCache: vi.fn(async () => undefined),
}))

async function setup(flag = true) {
	const ctx = await setupSeoOrganization()
	if (flag) await setOrgFlag(ctx.organization.id, 'menu.photo_tests', true)
	return {
		...ctx,
		org: { id: ctx.organization.id, slug: ctx.organization.slug },
	}
}

async function asset(
	organizationId: string,
	values: Record<string, unknown> = {},
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

async function dish(
	organizationId: string,
	photo: { objectKey: string } | null,
) {
	const [row] = await db
		.insert(OrganizationMenuItem)
		.values({
			organizationId,
			displayName: JSON.stringify({ en: 'Soup' }),
			price: 10,
			imageKey: photo?.objectKey ?? null,
			imageKeys: JSON.stringify(photo ? [photo.objectKey] : []),
		})
		.returning()
	return row!
}

const reload = async (id: string) =>
	(
		await db
			.select()
			.from(OrganizationMenuItem)
			.where(eq(OrganizationMenuItem.id, id))
	)[0]!

describe('start a photo test', () => {
	it('starts a test with the dish photo as A and a library photo as B', async () => {
		const { org, userId } = await setup()
		const a = await asset(org.id)
		const b = await asset(org.id)
		const item = await dish(org.id, a)
		const result = await startPhotoTest({
			organization: org,
			userId,
			itemId: item.id,
			assetId: b.id,
		})
		expect(result.ok).toBe(true)
		const [test] = await db
			.select()
			.from(MenuItemPhotoTest)
			.where(eq(MenuItemPhotoTest.itemId, item.id))
		expect(test).toMatchObject({
			imageKeyA: a.objectKey,
			imageKeyB: b.objectKey,
			endedAt: null,
		})
		// Photo B is not on the dish until it is kept.
		expect(JSON.parse((await reload(item.id)).imageKeys)).toEqual([a.objectKey])
	})

	it('needs the flag, a photo on the dish, a different ready photo, and one test per dish', async () => {
		const off = await setup(false)
		const offA = await asset(off.org.id)
		const offB = await asset(off.org.id)
		const offDish = await dish(off.org.id, offA)
		expect(
			await startPhotoTest({
				organization: off.org,
				userId: off.userId,
				itemId: offDish.id,
				assetId: offB.id,
			}),
		).toEqual({ ok: false, error: 'flag_off' })

		const { org, userId } = await setup()
		const a = await asset(org.id)
		const b = await asset(org.id)
		const draft = await asset(org.id, { status: 'draft' })
		const withPhoto = await dish(org.id, a)
		const noPhoto = await dish(org.id, null)
		expect(
			await startPhotoTest({
				organization: org,
				userId,
				itemId: noPhoto.id,
				assetId: b.id,
			}),
		).toEqual({ ok: false, error: 'no_photo' })
		expect(
			await startPhotoTest({
				organization: org,
				userId,
				itemId: withPhoto.id,
				assetId: a.id,
			}),
		).toEqual({ ok: false, error: 'same_photo' })
		expect(
			await startPhotoTest({
				organization: org,
				userId,
				itemId: withPhoto.id,
				assetId: draft.id,
			}),
		).toEqual({ ok: false, error: 'asset_not_ready' })
		expect(
			await startPhotoTest({
				organization: org,
				userId,
				itemId: withPhoto.id,
				assetId: b.id,
			}),
		).toMatchObject({ ok: true })
		const c = await asset(org.id)
		expect(
			await startPhotoTest({
				organization: org,
				userId,
				itemId: withPhoto.id,
				assetId: c.id,
			}),
		).toEqual({ ok: false, error: 'test_running' })
	})

	it("refuses another organization's dish and photo", async () => {
		const mine = await setup()
		const theirs = await setup()
		const myPhoto = await asset(mine.org.id)
		const theirPhoto = await asset(theirs.org.id)
		const myDish = await dish(mine.org.id, myPhoto)
		const theirDish = await dish(theirs.org.id, theirPhoto)
		expect(
			await startPhotoTest({
				organization: mine.org,
				userId: mine.userId,
				itemId: theirDish.id,
				assetId: myPhoto.id,
			}),
		).toEqual({ ok: false, error: 'not_found' })
		expect(
			await startPhotoTest({
				organization: mine.org,
				userId: mine.userId,
				itemId: myDish.id,
				assetId: theirPhoto.id,
			}),
		).toEqual({ ok: false, error: 'asset_not_found' })
	})

	it('allows at most 20 dishes in test per organization', async () => {
		const { org, userId } = await setup()
		for (let i = 0; i < 20; i += 1) {
			const a = await asset(org.id)
			const b = await asset(org.id)
			const item = await dish(org.id, a)
			expect(
				await startPhotoTest({
					organization: org,
					userId,
					itemId: item.id,
					assetId: b.id,
				}),
			).toMatchObject({ ok: true })
		}
		const a = await asset(org.id)
		const b = await asset(org.id)
		const item = await dish(org.id, a)
		expect(
			await startPhotoTest({
				organization: org,
				userId,
				itemId: item.id,
				assetId: b.id,
			}),
		).toEqual({ ok: false, error: 'too_many_tests' })
	})
})

describe('who sees photo B', () => {
	it('only the web and QR menus carry photo B; the app, delivery and internal readers get photo A', async () => {
		const { org, userId } = await setup()
		const a = await asset(org.id)
		const b = await asset(org.id, { focalX: 0, focalY: 0 })
		const item = await dish(org.id, a)
		await startPhotoTest({
			organization: org,
			userId,
			itemId: item.id,
			assetId: b.id,
		})

		for (const channel of ['web', 'qr'] as const) {
			const tests = await loadPublicPhotoTests(org.id, channel, [item.id])
			const test = tests.get(item.id)!
			expect(test).toMatchObject({
				imageUrlB: expect.stringContaining(`mediaId=${b.id}`),
				imageFocalB: { x: 0, y: 0 },
			})
			// The beacon key proves the test to the region (and only this one).
			expect(
				await verifyPhotoTestBeaconKey(
					SECRET,
					{ organizationId: org.id, testId: test.id, itemId: item.id },
					test.key,
				),
			).toBe(true)
			expect(
				await verifyPhotoTestBeaconKey(
					SECRET,
					{ organizationId: org.id, testId: test.id, itemId: 'another-dish' },
					test.key,
				),
			).toBe(false)
		}
		// Without the shared secret nothing could be counted, so nothing is tested.
		expect(
			(await loadPublicPhotoTests(org.id, 'web', [item.id], { secret: '' }))
				.size,
		).toBe(0)
		for (const channel of ['app', 'pos', undefined] as const) {
			expect(
				(await loadPublicPhotoTests(org.id, channel, [item.id])).size,
			).toBe(0)
		}
	})

	it('carries nothing while the flag is off or for a dish not asked about', async () => {
		const { org, userId } = await setup()
		const a = await asset(org.id)
		const b = await asset(org.id)
		const item = await dish(org.id, a)
		await startPhotoTest({
			organization: org,
			userId,
			itemId: item.id,
			assetId: b.id,
		})
		expect(
			(await loadPublicPhotoTests(org.id, 'web', ['other-dish'])).size,
		).toBe(0)
		await db
			.update(MenuItemPhotoTest)
			.set({ endedAt: new Date() })
			.where(eq(MenuItemPhotoTest.itemId, item.id))
		expect((await loadPublicPhotoTests(org.id, 'web', [item.id])).size).toBe(0)
	})
})

describe('end a photo test', () => {
	it('keeping B makes it the dish photo everywhere and keeps A in the library', async () => {
		const { org, userId } = await setup()
		const a = await asset(org.id)
		const b = await asset(org.id)
		const item = await dish(org.id, a)
		const started = await startPhotoTest({
			organization: org,
			userId,
			itemId: item.id,
			assetId: b.id,
		})
		if (!started.ok) throw new Error('start failed')

		expect(
			await endPhotoTest({
				organization: org,
				userId,
				testId: started.testId,
				choice: 'B',
			}),
		).toEqual({ ok: true })
		const updated = await reload(item.id)
		expect(updated.imageKey).toBe(b.objectKey)
		expect(JSON.parse(updated.imageKeys)).toEqual([b.objectKey])
		expect(updated.imageUrl).toContain(`mediaId=${b.id}`)
		const [test] = await db
			.select()
			.from(MenuItemPhotoTest)
			.where(eq(MenuItemPhotoTest.id, started.testId))
		expect(test).toMatchObject({ winner: 'B', endedReason: 'kept_b' })
		expect(test!.endedAt).toBeInstanceOf(Date)
		// The losing photo is not deleted from the media library.
		const [stillThere] = await db
			.select()
			.from(OrganizationMediaAsset)
			.where(eq(OrganizationMediaAsset.id, a.id))
		expect(stillThere).toBeDefined()
		// Nothing is tested any more.
		expect((await loadPublicPhotoTests(org.id, 'web', [item.id])).size).toBe(0)
		// And it cannot be ended twice.
		expect(
			await endPhotoTest({
				organization: org,
				userId,
				testId: started.testId,
				choice: 'A',
			}),
		).toEqual({ ok: false, error: 'already_ended' })
	})

	it('keeping A or stopping leaves the dish as it is and deletes nothing', async () => {
		const { org, userId } = await setup()
		for (const choice of ['A', 'stop'] as const) {
			const a = await asset(org.id)
			const b = await asset(org.id)
			const item = await dish(org.id, a)
			const started = await startPhotoTest({
				organization: org,
				userId,
				itemId: item.id,
				assetId: b.id,
			})
			if (!started.ok) throw new Error('start failed')
			expect(
				await endPhotoTest({
					organization: org,
					userId,
					testId: started.testId,
					choice,
				}),
			).toEqual({ ok: true })
			expect((await reload(item.id)).imageKey).toBe(a.objectKey)
			const rows = await db
				.select()
				.from(OrganizationMediaAsset)
				.where(
					and(
						eq(OrganizationMediaAsset.organizationId, org.id),
						eq(OrganizationMediaAsset.id, b.id),
					),
				)
			expect(rows).toHaveLength(1)
		}
	})

	it('keeping B is refused when the dish photo changed meanwhile, and nothing changes', async () => {
		const { org, userId } = await setup()
		const a = await asset(org.id)
		const b = await asset(org.id)
		const other = await asset(org.id)
		const item = await dish(org.id, a)
		const started = await startPhotoTest({
			organization: org,
			userId,
			itemId: item.id,
			assetId: b.id,
		})
		if (!started.ok) throw new Error('start failed')
		await db
			.update(OrganizationMenuItem)
			.set({
				imageKey: other.objectKey,
				imageKeys: JSON.stringify([other.objectKey]),
			})
			.where(eq(OrganizationMenuItem.id, item.id))
		expect(
			await endPhotoTest({
				organization: org,
				userId,
				testId: started.testId,
				choice: 'B',
			}),
		).toEqual({ ok: false, error: 'photo_changed' })
		expect((await reload(item.id)).imageKey).toBe(other.objectKey)
		const [test] = await db
			.select()
			.from(MenuItemPhotoTest)
			.where(eq(MenuItemPhotoTest.id, started.testId))
		expect(test!.endedAt).toBeNull()
	})

	it("never ends another organization's test", async () => {
		const mine = await setup()
		const theirs = await setup()
		const a = await asset(theirs.org.id)
		const b = await asset(theirs.org.id)
		const item = await dish(theirs.org.id, a)
		const started = await startPhotoTest({
			organization: theirs.org,
			userId: theirs.userId,
			itemId: item.id,
			assetId: b.id,
		})
		if (!started.ok) throw new Error('start failed')
		expect(
			await endPhotoTest({
				organization: mine.org,
				userId: mine.userId,
				testId: started.testId,
				choice: 'B',
			}),
		).toEqual({ ok: false, error: 'not_found' })
		expect((await reload(item.id)).imageKey).toBe(a.objectKey)
	})

	it('a dish photo changed another way stops its running test', async () => {
		const { org, userId } = await setup()
		const a = await asset(org.id)
		const b = await asset(org.id)
		const item = await dish(org.id, a)
		const started = await startPhotoTest({
			organization: org,
			userId,
			itemId: item.id,
			assetId: b.id,
		})
		if (!started.ok) throw new Error('start failed')
		// The same main photo keeps the test; a different one ends it.
		await stopPhotoTestsForChangedDish({
			organizationId: org.id,
			itemId: item.id,
			newMainKey: a.objectKey,
		})
		let [test] = await db
			.select()
			.from(MenuItemPhotoTest)
			.where(eq(MenuItemPhotoTest.id, started.testId))
		expect(test!.endedAt).toBeNull()
		await stopPhotoTestsForChangedDish({
			organizationId: org.id,
			itemId: item.id,
			newMainKey: 'orgs/x/new.jpg',
		})
		;[test] = await db
			.select()
			.from(MenuItemPhotoTest)
			.where(eq(MenuItemPhotoTest.id, started.testId))
		expect(test).toMatchObject({ endedReason: 'stopped' })
		expect(test!.endedAt).toBeInstanceOf(Date)
	})
})
