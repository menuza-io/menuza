/**
 * #145 on the real database: a dish whose primary photo scores under 50 shows
 * up under Weak dish photo in Menu health, only while `media.photo_quality`
 * is on, and the summary carries what "Fix in photo studio" needs.
 */
import {
	db,
	Organization,
	OrganizationMediaAsset,
	OrganizationMenuItem,
	eq,
} from '@repo/database'
import { describe, expect, it } from 'vitest'
import { setOrgFlag, setupSeoOrganization } from '#tests/seo-utils.ts'
import { loadMenuHealthSummary } from './menu-health.server.ts'

async function menu(flag: boolean) {
	const ctx = await setupSeoOrganization()
	if (flag) await setOrgFlag(ctx.organization.id, 'media.photo_quality', true)
	const [organization] = await db
		.select({
			id: Organization.id,
			siteLocales: Organization.siteLocales,
			siteDefaultLocale: Organization.siteDefaultLocale,
		})
		.from(Organization)
		.where(eq(Organization.id, ctx.organization.id))
	return { ...ctx, healthOrg: organization! }
}

async function dish(
	organizationId: string,
	name: string,
	score: number | null,
	issues: string[],
	analyzed = true,
) {
	const objectKey = `orgs/${organizationId}/media/images/${crypto.randomUUID()}.jpg`
	const [asset] = await db
		.insert(OrganizationMediaAsset)
		.values({
			organizationId,
			objectKey,
			mimeType: 'image/jpeg',
			width: 1600,
			height: 1200,
			qualityScore: score,
			qualityIssues: JSON.stringify(issues),
			analyzedAt: analyzed ? new Date() : null,
		})
		.returning()
	const [item] = await db
		.insert(OrganizationMenuItem)
		.values({
			organizationId,
			displayName: JSON.stringify({ en: name }),
			description: JSON.stringify({ en: `${name} described` }),
			price: 10,
			imageKey: objectKey,
			imageKeys: JSON.stringify([objectKey]),
		})
		.returning()
	return { asset: asset!, item: item! }
}

describe('menu health: weak dish photo', () => {
	it('lists a dish with a low-scoring primary photo, with the photo and issues', async () => {
		const { organization, healthOrg } = await menu(true)
		const weak = await dish(organization.id, 'Dark soup', 31, [
			'too_dark',
			'blurry',
		])
		await dish(organization.id, 'Bright salad', 91, [])
		await dish(organization.id, 'Not scored yet', null, [], false)

		const summary = await loadMenuHealthSummary(healthOrg)
		const check = summary.checks.find((c) => c.key === 'weak_photo')
		expect(check).toBeDefined()
		expect(check!.count).toBe(1)
		expect(check!.records).toEqual([
			{
				id: weak.item.id,
				name: 'Dark soup',
				photo: { assetId: weak.asset.id, issues: ['too_dark', 'blurry'] },
			},
		])
		// no_photo still answers on its own: every dish here has a photo.
		expect(summary.checks.find((c) => c.key === 'no_photo')?.count).toBe(0)
	})

	it('is absent while the flag is off', async () => {
		const { organization, healthOrg } = await menu(false)
		await dish(organization.id, 'Dark soup', 12, ['too_dark'])
		const summary = await loadMenuHealthSummary(healthOrg)
		expect(summary.checks.find((c) => c.key === 'weak_photo')).toBeUndefined()
	})

	it("never reads another organization's scores", async () => {
		const a = await menu(true)
		const b = await menu(true)
		await dish(b.organization.id, 'Their dark soup', 5, ['too_dark'])
		await dish(a.organization.id, 'Our fine soup', 90, [])
		const summary = await loadMenuHealthSummary(a.healthOrg)
		expect(summary.checks.find((c) => c.key === 'weak_photo')?.count).toBe(0)
	})
})
