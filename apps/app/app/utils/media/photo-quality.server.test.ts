/**
 * #145: photo quality scores. The model and storage are the external boundaries
 * (a mock analyzer, a stubbed reader); records, rules and limits are real.
 */
import { db, eq, OrganizationMediaAsset } from '@repo/database'
import { describe, expect, it, vi } from 'vitest'
import { setOrgFlag, setupSeoOrganization } from '#tests/seo-utils.ts'
import {
	createMockPhotoQualityAnalyzer,
	processPhotoQualityForOrganization,
	sweepPhotoQuality,
} from './photo-quality.server.ts'

async function setup(flag = true) {
	const ctx = await setupSeoOrganization()
	if (flag) await setOrgFlag(ctx.organization.id, 'media.photo_quality', true)
	return ctx
}

async function photo(
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
			source: 'library',
			...values,
		})
		.returning()
	return row!
}

const readImage = vi.fn(async () => ({
	data: new Uint8Array(1234),
	mediaType: 'image/jpeg' as const,
}))

async function reload(id: string) {
	const [row] = await db
		.select()
		.from(OrganizationMediaAsset)
		.where(eq(OrganizationMediaAsset.id, id))
	return row!
}

describe('photo quality job', () => {
	it('gives a new upload a score and issues', async () => {
		const { organization } = await setup()
		const asset = await photo(organization.id)
		const analyzer = createMockPhotoQualityAnalyzer({
			score: 38,
			issues: ['too_dark', 'blurry'],
		})
		const result = await processPhotoQualityForOrganization(organization.id, {
			analyzer,
			readImage: readImage as never,
		})
		expect(result).toEqual({ processed: 1, remaining: 0, limited: false })
		const row = await reload(asset.id)
		expect(row.qualityScore).toBe(38)
		expect(JSON.parse(row.qualityIssues!)).toEqual(['too_dark', 'blurry'])
		expect(row.analyzedAt).toBeInstanceOf(Date)
	})

	it('flags a short side under 800 px without the model', async () => {
		const { organization } = await setup()
		const asset = await photo(organization.id, { width: 640, height: 480 })
		const analyzer = createMockPhotoQualityAnalyzer({ score: 90 })
		await processPhotoQualityForOrganization(organization.id, {
			analyzer,
			readImage: readImage as never,
		})
		expect(analyzer.calls).toBe(0)
		const row = await reload(asset.id)
		expect(JSON.parse(row.qualityIssues!)).toContain('low_resolution')
		expect(row.qualityScore).toBeNull()
		expect(row.analyzedAt).toBeInstanceOf(Date)
	})

	it('leaves a failed analysis unscored and tries once more, then gives up', async () => {
		const { organization } = await setup()
		const asset = await photo(organization.id)
		const failing = createMockPhotoQualityAnalyzer({ fail: true })
		await processPhotoQualityForOrganization(organization.id, {
			analyzer: failing,
			readImage: readImage as never,
		})
		let row = await reload(asset.id)
		expect(row.qualityScore).toBeNull()
		expect(row.qualityAttempts).toBe(1)
		expect(row.analyzedAt).toBeNull()

		const second = await processPhotoQualityForOrganization(organization.id, {
			analyzer: failing,
			readImage: readImage as never,
		})
		row = await reload(asset.id)
		expect(row.qualityAttempts).toBe(2)
		expect(row.qualityScore).toBeNull()
		expect(row.analyzedAt).toBeInstanceOf(Date)
		expect(second.remaining).toBe(0)
		// No third try.
		const third = await processPhotoQualityForOrganization(organization.id, {
			analyzer: failing,
			readImage: readImage as never,
		})
		expect(third.processed).toBe(0)
		expect(failing.calls).toBe(2)
	})

	it('without a model leaves photos waiting, and only flags the small ones', async () => {
		const { organization } = await setup()
		const big = await photo(organization.id)
		const small = await photo(organization.id, { width: 500, height: 400 })
		const result = await processPhotoQualityForOrganization(organization.id, {
			analyzer: null,
			readImage: readImage as never,
		})
		// The big photo is not offered to a batch without a model, and it is not
		// closed as analyzed either: a key added later still scores it.
		expect(result.remaining).toBe(0)
		expect((await reload(big.id)).analyzedAt).toBeNull()
		expect(JSON.parse((await reload(small.id)).qualityIssues!)).toContain(
			'low_resolution',
		)
	})

	it('two batches at once never analyze the same photo twice', async () => {
		const { organization } = await setup()
		for (let i = 0; i < 6; i += 1) await photo(organization.id)
		const analyzer = createMockPhotoQualityAnalyzer({ score: 70 })
		const deps = {
			analyzer,
			readImage: readImage as never,
			spend: async () => true,
		}
		const [a, b] = await Promise.all([
			processPhotoQualityForOrganization(organization.id, deps),
			processPhotoQualityForOrganization(organization.id, deps),
		])
		expect(a.processed + b.processed).toBe(6)
		expect(analyzer.calls).toBe(6)
	})

	it('a batch gives back the claims of photos it did not finish', async () => {
		const { organization } = await setup()
		const asset = await photo(organization.id)
		const analyzer = createMockPhotoQualityAnalyzer({ score: 70 })
		await processPhotoQualityForOrganization(organization.id, {
			analyzer,
			readImage: readImage as never,
			spend: async () => false,
		})
		expect((await reload(asset.id)).qualityClaimedAt).toBeNull()
		const next = await processPhotoQualityForOrganization(organization.id, {
			analyzer,
			readImage: readImage as never,
			spend: async () => true,
		})
		expect(next.processed).toBe(1)
	})

	it('without a model, big photos never hold up the small ones behind them', async () => {
		const { organization } = await setup()
		for (let i = 0; i < 12; i += 1) await photo(organization.id)
		const small = await photo(organization.id, { width: 500, height: 400 })
		const reader = vi.fn(async () => ({
			data: new Uint8Array(10),
			mediaType: 'image/jpeg' as const,
		}))
		const result = await processPhotoQualityForOrganization(organization.id, {
			analyzer: null,
			readImage: reader as never,
		})
		expect(JSON.parse((await reload(small.id)).qualityIssues!)).toContain(
			'low_resolution',
		)
		// The 12 big photos were not even read, and are not counted as waiting.
		expect(reader).not.toHaveBeenCalled()
		expect(result.remaining).toBe(0)
	})

	it('the sweep is not filled by organizations that cannot be scored', async () => {
		// Older waiting images belong to organizations with the flag off; the one
		// with the flag on still gets its turn.
		const unflagged = await Promise.all(
			Array.from({ length: 30 }, () => setup(false)),
		)
		for (const ctx of unflagged) {
			await photo(ctx.organization.id, { createdAt: new Date('2020-01-01') })
		}
		const flagged = await setup(true)
		await photo(flagged.organization.id)
		const wake = vi.fn(async (_id: string) => true)
		await sweepPhotoQuality({ wake })
		const woken = wake.mock.calls.map((call) => call[0])
		expect(woken).toContain(flagged.organization.id)
		for (const ctx of unflagged) {
			expect(woken).not.toContain(ctx.organization.id)
		}
	})

	it('never reads a guest-submitted photo', async () => {
		const { organization } = await setup()
		const bySource = await photo(organization.id, { source: 'guest-photo' })
		const byName = await photo(organization.id, {
			fileName: 'guest-photo-abc123.jpg',
		})
		const analyzer = createMockPhotoQualityAnalyzer({ score: 80 })
		const reader = vi.fn(async () => ({
			data: new Uint8Array(10),
			mediaType: 'image/jpeg' as const,
		}))
		const result = await processPhotoQualityForOrganization(organization.id, {
			analyzer,
			readImage: reader as never,
		})
		expect(result).toEqual({ processed: 0, remaining: 0, limited: false })
		expect(analyzer.calls).toBe(0)
		expect(reader).not.toHaveBeenCalled()
		expect((await reload(bySource.id)).analyzedAt).toBeNull()
		expect((await reload(byName.id)).analyzedAt).toBeNull()
	})

	it('does nothing while the flag is off and never touches another organization', async () => {
		const off = await setup(false)
		const on = await setup(true)
		const offAsset = await photo(off.organization.id)
		const otherAsset = await photo(on.organization.id)
		const analyzer = createMockPhotoQualityAnalyzer({ score: 70 })
		const offResult = await processPhotoQualityForOrganization(
			off.organization.id,
			{ analyzer, readImage: readImage as never },
		)
		expect(offResult.processed).toBe(0)
		expect((await reload(offAsset.id)).analyzedAt).toBeNull()
		await processPhotoQualityForOrganization(on.organization.id, {
			analyzer,
			readImage: readImage as never,
		})
		expect((await reload(otherAsset.id)).qualityScore).toBe(70)
		expect((await reload(offAsset.id)).qualityScore).toBeNull()
	})

	it('stops at the daily limit and resumes later', async () => {
		const { organization } = await setup()
		const asset = await photo(organization.id)
		const analyzer = createMockPhotoQualityAnalyzer({ score: 60 })
		const spend = vi.fn(async () => false)
		const limited = await processPhotoQualityForOrganization(organization.id, {
			analyzer,
			readImage: readImage as never,
			spend,
		})
		expect(limited).toEqual({ processed: 0, remaining: 1, limited: true })
		expect((await reload(asset.id)).analyzedAt).toBeNull()
		const resumed = await processPhotoQualityForOrganization(organization.id, {
			analyzer,
			readImage: readImage as never,
			spend: async () => true,
		})
		expect(resumed.processed).toBe(1)
	})

	it('paces a backfill: ten photos per call', async () => {
		const { organization } = await setup()
		for (let i = 0; i < 13; i += 1) await photo(organization.id)
		const analyzer = createMockPhotoQualityAnalyzer({ score: 60 })
		const first = await processPhotoQualityForOrganization(organization.id, {
			analyzer,
			readImage: readImage as never,
			spend: async () => true,
		})
		expect(first).toEqual({ processed: 10, remaining: 3, limited: false })
	})

	it('the sweep wakes the workflow for flagged organizations with waiting images', async () => {
		const flagged = await setup(true)
		const unflagged = await setup(false)
		await photo(flagged.organization.id)
		await photo(unflagged.organization.id)
		const wake = vi.fn(async () => true)
		const result = await sweepPhotoQuality({ wake })
		expect(wake).toHaveBeenCalledWith(flagged.organization.id)
		expect(wake).not.toHaveBeenCalledWith(unflagged.organization.id)
		expect(result.woken).toBeGreaterThanOrEqual(1)
	})
})
