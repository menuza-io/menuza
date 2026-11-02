import {
	db,
	Discount,
	DiscountCode,
	eq,
	and,
	isNull,
	sqliteClient,
} from '@repo/database'
import { type DiscountDefinition } from '@repo/discounts'
import { describe, expect, it } from 'vitest'
import { setupTestOrgWithUser } from '#tests/test-utils.ts'
import {
	createDiscount,
	duplicateDiscount,
	getDiscount,
	listDiscounts,
	MAX_CODES_PER_ORG,
	MAX_DISCOUNTS_PER_ORG,
	setDiscountStatus,
	updateDiscount,
} from './discounts.server.ts'

const definition: DiscountDefinition = {
	name: 'Code discount',
	internalName: null,
	description: null,
	status: 'active',
	application: 'code',
	valueType: 'percent',
	percentBp: 1000,
	amountMinor: null,
	currency: null,
	maxDiscountMinor: null,
	target: {
		scope: 'order',
		itemIds: [],
		categoryIds: [],
		excludeItemIds: [],
		excludeCategoryIds: [],
	},
	requirement: null,
	quantityRule: { kind: 'none' },
	maxDiscountedUnits: null,
	minSubtotalMinor: null,
	locationIds: null,
	channels: ['web'],
	fulfillments: ['pickup'],
	includeDrops: false,
	schedule: null,
	startsAt: null,
	endsAt: null,
	eligibility: 'everyone',
	totalLimit: null,
	perCustomerLimit: null,
	combinable: true,
	priority: 0,
	promoteOnMenu: false,
	requireApproval: false,
}

async function activeCodes(discountId: string) {
	return db
		.select()
		.from(DiscountCode)
		.where(
			and(
				eq(DiscountCode.discountId, discountId),
				isNull(DiscountCode.archivedAt),
			),
		)
}

describe('saving codes', () => {
	it('swaps two codes between rows without a unique clash or a bumped version', async () => {
		const { user, organization } = await setupTestOrgWithUser()
		const created = await createDiscount({
			organizationId: organization.id,
			userId: user.id,
			definition,
			codes: [
				{ id: null, code: 'ALPHA1', maxUses: 1 },
				{ id: null, code: 'BRAVO2', maxUses: 2 },
			],
		})
		if (!created.ok) throw new Error('create failed')
		const [alpha, bravo] = (await activeCodes(created.id)).sort((a, b) =>
			a.code.localeCompare(b.code),
		)
		const saved = await updateDiscount({
			organizationId: organization.id,
			discountId: created.id,
			expectedVersion: created.version,
			definition,
			codes: [
				{ id: alpha!.id, code: 'BRAVO2', maxUses: 1 },
				{ id: bravo!.id, code: 'ALPHA1', maxUses: 2 },
			],
		})
		expect(saved).toMatchObject({ ok: true, version: 2 })
		const after = await activeCodes(created.id)
		expect(after.map((row) => row.normalizedCode).sort()).toEqual([
			'ALPHA1',
			'BRAVO2',
		])
		// The rows kept their ids, so their use counts stay with them.
		expect(after.find((row) => row.id === alpha!.id)?.normalizedCode).toBe(
			'BRAVO2',
		)
	})

	it('saves 98 codes in one go', async () => {
		const { user, organization } = await setupTestOrgWithUser()
		const codes = Array.from({ length: 90 }, (_, index) => ({
			id: null,
			code: `CODE${String(index).padStart(3, '0')}`,
			maxUses: 1,
		}))
		const created = await createDiscount({
			organizationId: organization.id,
			userId: user.id,
			definition,
			codes,
		})
		expect(created.ok).toBe(true)
	})

	it('keeps the stored version when another discount already owns a code', async () => {
		const { user, organization } = await setupTestOrgWithUser()
		await createDiscount({
			organizationId: organization.id,
			userId: user.id,
			definition,
			codes: [{ id: null, code: 'TAKEN1', maxUses: null }],
		})
		const second = await createDiscount({
			organizationId: organization.id,
			userId: user.id,
			definition,
			codes: [{ id: null, code: 'OTHER1', maxUses: null }],
		})
		if (!second.ok) throw new Error('create failed')
		const clash = await updateDiscount({
			organizationId: organization.id,
			discountId: second.id,
			expectedVersion: second.version,
			definition: { ...definition, name: 'Renamed' },
			codes: [{ id: null, code: 'TAKEN1', maxUses: null }],
		})
		expect(clash.ok).toBe(false)
		const retry = await updateDiscount({
			organizationId: organization.id,
			discountId: second.id,
			expectedVersion: second.version,
			definition: { ...definition, name: 'Renamed' },
			codes: [{ id: null, code: 'FRESH1', maxUses: null }],
		})
		expect(retry).toMatchObject({ ok: true, version: 2 })
	})
})

/**
 * D1 runs `db.transaction` as a pass-through, so a failure halfway through a
 * save cannot roll back. A trigger makes the insert of one code fail the way a
 * unique clash from a concurrent save would.
 */
async function withFailingCode<T>(
	normalizedCode: string,
	run: () => Promise<T>,
	message = 'UNIQUE constraint failed: DiscountCode.normalizedCode',
): Promise<T> {
	await sqliteClient.execute(
		`CREATE TRIGGER test_boom BEFORE INSERT ON "DiscountCode" WHEN NEW."normalizedCode" = '${normalizedCode}' BEGIN SELECT RAISE(ABORT, '${message}'); END`,
	)
	try {
		return await run()
	} finally {
		await sqliteClient.execute('DROP TRIGGER IF EXISTS test_boom')
	}
}

describe('saves that fail halfway', () => {
	it('takes the discount back out when a code cannot be saved, so a retry does not duplicate it', async () => {
		const { user, organization } = await setupTestOrgWithUser()
		const input = {
			organizationId: organization.id,
			userId: user.id,
			definition: { ...definition, name: 'Half made' },
			codes: [
				{ id: null, code: 'FINE01', maxUses: null },
				{ id: null, code: 'BOOM1', maxUses: null },
			],
		}
		const failed = await withFailingCode('BOOM1', () => createDiscount(input))
		expect(failed).toEqual({ ok: false, reason: 'code_taken', codeIndexes: [] })
		expect(await listDiscounts(organization.id)).toEqual([])
		const orphanCodes = await db
			.select()
			.from(DiscountCode)
			.where(eq(DiscountCode.organizationId, organization.id))
		expect(orphanCodes).toEqual([])

		const retry = await createDiscount(input)
		expect(retry.ok).toBe(true)
		expect(await listDiscounts(organization.id)).toHaveLength(1)
	})

	it('rethrows an error that is not a code clash, and still cleans up', async () => {
		const { user, organization } = await setupTestOrgWithUser()
		await expect(
			withFailingCode(
				'BOOM2',
				() =>
					createDiscount({
						organizationId: organization.id,
						userId: user.id,
						definition,
						codes: [{ id: null, code: 'BOOM2', maxUses: null }],
					}),
				'disk I/O error',
			),
		).rejects.toThrow()
		expect(await listDiscounts(organization.id)).toEqual([])
	})

	it('checks a code against the rest of the save before writing anything', async () => {
		const { user, organization } = await setupTestOrgWithUser()
		const result = await createDiscount({
			organizationId: organization.id,
			userId: user.id,
			definition,
			codes: [
				{ id: null, code: 'SAME01', maxUses: null },
				{ id: null, code: 'same-01', maxUses: null },
			],
		})
		expect(result).toEqual({
			ok: false,
			reason: 'code_taken',
			codeIndexes: [1],
		})
		expect(await listDiscounts(organization.id)).toEqual([])
	})

	it('puts the rules, the version and the old codes back when an update fails', async () => {
		const { user, organization } = await setupTestOrgWithUser()
		const created = await createDiscount({
			organizationId: organization.id,
			userId: user.id,
			definition: { ...definition, name: 'Before' },
			codes: [
				{ id: null, code: 'KEEP01', maxUses: 5 },
				{ id: null, code: 'GONE01', maxUses: null },
			],
		})
		if (!created.ok) throw new Error('create failed')
		const before = await activeCodes(created.id)
		const keep = before.find((row) => row.normalizedCode === 'KEEP01')!

		await expect(
			withFailingCode(
				'BOOM3',
				() =>
					updateDiscount({
						organizationId: organization.id,
						discountId: created.id,
						expectedVersion: created.version,
						definition: { ...definition, name: 'After', percentBp: 2500 },
						codes: [
							// KEEP01 is renamed, GONE01 removed, BOOM3 is the one that fails.
							{ id: keep.id, code: 'RENAMED1', maxUses: 7 },
							{ id: null, code: 'BOOM3', maxUses: null },
						],
					}),
				'disk I/O error',
			),
		).rejects.toThrow()

		const loaded = await getDiscount(organization.id, created.id)
		expect(loaded?.row.name).toBe('Before')
		expect(loaded?.row.percentBp).toBe(1000)
		expect(loaded?.row.version).toBe(1)
		const after = await activeCodes(created.id)
		expect(
			after.map((row) => [row.id, row.normalizedCode, row.maxUses]).sort(),
		).toEqual(
			before.map((row) => [row.id, row.normalizedCode, row.maxUses]).sort(),
		)

		// The same save goes through once the failure is gone.
		const retry = await updateDiscount({
			organizationId: organization.id,
			discountId: created.id,
			expectedVersion: created.version,
			definition: { ...definition, name: 'After' },
			codes: [{ id: null, code: 'FRESH01', maxUses: null }],
		})
		expect(retry).toMatchObject({ ok: true, version: 2 })
	})

	it('lets a new code take the name of one that was renamed or removed in the same save', async () => {
		const { user, organization } = await setupTestOrgWithUser()
		const created = await createDiscount({
			organizationId: organization.id,
			userId: user.id,
			definition,
			codes: [
				{ id: null, code: 'AAA111', maxUses: null },
				{ id: null, code: 'BBB222', maxUses: null },
			],
		})
		if (!created.ok) throw new Error('create failed')
		const [first, second] = (await activeCodes(created.id)).sort((a, b) =>
			a.code.localeCompare(b.code),
		)
		const saved = await updateDiscount({
			organizationId: organization.id,
			discountId: created.id,
			expectedVersion: created.version,
			definition,
			codes: [
				// AAA111's row becomes CCC333, a new row takes AAA111, BBB222's row
				// is removed and its value is taken by a rename of nothing else.
				{ id: first!.id, code: 'CCC333', maxUses: null },
				{ id: null, code: 'AAA111', maxUses: null },
				{ id: null, code: 'BBB222', maxUses: 3 },
			],
		})
		expect(saved).toMatchObject({ ok: true })
		expect(second).toBeDefined()
		const after = await activeCodes(created.id)
		expect(after.map((row) => row.normalizedCode).sort()).toEqual([
			'AAA111',
			'BBB222',
			'CCC333',
		])
	})

	it('keeps answering a stale version without touching anything', async () => {
		const { user, organization } = await setupTestOrgWithUser()
		const created = await createDiscount({
			organizationId: organization.id,
			userId: user.id,
			definition: { ...definition, name: 'Original' },
			codes: [{ id: null, code: 'STALE1', maxUses: null }],
		})
		if (!created.ok) throw new Error('create failed')
		const first = await updateDiscount({
			organizationId: organization.id,
			discountId: created.id,
			expectedVersion: created.version,
			definition: { ...definition, name: 'Theirs' },
			codes: [{ id: null, code: 'STALE1', maxUses: null }],
		})
		expect(first).toMatchObject({ ok: true, version: 2 })
		const mine = await updateDiscount({
			organizationId: organization.id,
			discountId: created.id,
			expectedVersion: created.version,
			definition: { ...definition, name: 'Mine' },
			codes: [{ id: null, code: 'MINE01', maxUses: null }],
		})
		expect(mine).toEqual({ ok: false, reason: 'stale' })
		const [row] = await db
			.select()
			.from(Discount)
			.where(eq(Discount.id, created.id))
		expect(row?.name).toBe('Theirs')
		expect(
			(await activeCodes(created.id)).map((c) => c.normalizedCode),
		).toEqual(['STALE1'])
	})

	it('refuses to save an archived discount, which would attach live codes to it', async () => {
		const { user, organization } = await setupTestOrgWithUser()
		const created = await createDiscount({
			organizationId: organization.id,
			userId: user.id,
			definition,
			codes: [{ id: null, code: 'OLD001', maxUses: null }],
		})
		if (!created.ok) throw new Error('create failed')
		const archived = await setDiscountStatus({
			organizationId: organization.id,
			discountId: created.id,
			expectedVersion: created.version,
			status: 'archived',
		})
		if (!archived.ok) throw new Error('archive failed')
		const saved = await updateDiscount({
			organizationId: organization.id,
			discountId: created.id,
			expectedVersion: archived.version,
			definition: { ...definition, status: 'archived' },
			codes: [{ id: null, code: 'NEW001', maxUses: null }],
		})
		expect(saved).toEqual({ ok: false, reason: 'archived' })
		expect(await activeCodes(created.id)).toEqual([])
	})
})

describe('duplicating a discount', () => {
	it('copies the rules under a new name, paused, with no codes', async () => {
		const { user, organization } = await setupTestOrgWithUser()
		const created = await createDiscount({
			organizationId: organization.id,
			userId: user.id,
			definition: { ...definition, name: 'Lunch', percentBp: 1500 },
			codes: [{ id: null, code: 'LUNCH1', maxUses: null }],
		})
		if (!created.ok) throw new Error('create failed')
		const copy = await duplicateDiscount({
			organizationId: organization.id,
			userId: user.id,
			discountId: created.id,
			copyName: (name) => `${name} copy`,
			defaultLocale: 'en',
		})
		if (!copy.ok) throw new Error('duplicate failed')
		expect(copy.id).not.toBe(created.id)
		const loaded = await getDiscount(organization.id, copy.id)
		expect(loaded?.stored?.definition).toMatchObject({
			name: 'Lunch copy',
			status: 'paused',
			percentBp: 1500,
			application: 'code',
		})
		expect(loaded?.codes).toEqual([])
		// The original keeps its code.
		expect(await activeCodes(created.id)).toHaveLength(1)
	})

	it('answers not found for a discount in another organization', async () => {
		const { user, organization } = await setupTestOrgWithUser()
		const other = await setupTestOrgWithUser()
		const created = await createDiscount({
			organizationId: other.organization.id,
			userId: other.user.id,
			definition,
			codes: [],
		})
		if (!created.ok) throw new Error('create failed')
		expect(
			await duplicateDiscount({
				organizationId: organization.id,
				userId: user.id,
				discountId: created.id,
				copyName: (name) => `${name} copy`,
				defaultLocale: 'en',
			}),
		).toEqual({ ok: false, reason: 'not_found' })
	})
})

describe('organization caps', () => {
	/** Copies a stored discount `copies` times straight into the table. */
	async function cloneDiscount(discountId: string, copies: number) {
		const [row] = await db
			.select()
			.from(Discount)
			.where(eq(Discount.id, discountId))
		const { id: ignoredId, ...columns } = row!
		for (let done = 0; done < copies; done += 40) {
			await db.insert(Discount).values(
				Array.from({ length: Math.min(40, copies - done) }, () => ({
					...columns,
				})),
			)
		}
	}

	it('refuses the discount past the cap, counts paused ones, and frees a slot when one is archived', async () => {
		const { user, organization } = await setupTestOrgWithUser()
		const first = await createDiscount({
			organizationId: organization.id,
			userId: user.id,
			definition: { ...definition, application: 'automatic' },
			codes: [],
		})
		if (!first.ok) throw new Error('create failed')
		await cloneDiscount(first.id, MAX_DISCOUNTS_PER_ORG - 1)
		const refused = await createDiscount({
			organizationId: organization.id,
			userId: user.id,
			definition: { ...definition, application: 'automatic', status: 'paused' },
			codes: [],
		})
		expect(refused).toEqual({ ok: false, reason: 'too_many_discounts' })
		// A copy of a discount is a creation too.
		expect(
			await duplicateDiscount({
				organizationId: organization.id,
				userId: user.id,
				discountId: first.id,
				copyName: (name) => `${name} copy`,
				defaultLocale: 'en',
			}),
		).toEqual({ ok: false, reason: 'too_many_discounts' })

		// Archiving one frees a place; restoring it needs a place again.
		const archived = await setDiscountStatus({
			organizationId: organization.id,
			discountId: first.id,
			expectedVersion: first.version,
			status: 'archived',
		})
		expect(archived.ok).toBe(true)
		const created = await createDiscount({
			organizationId: organization.id,
			userId: user.id,
			definition: { ...definition, application: 'automatic' },
			codes: [],
		})
		expect(created.ok).toBe(true)
		const restored = await setDiscountStatus({
			organizationId: organization.id,
			discountId: first.id,
			expectedVersion: first.version + 1,
			status: 'paused',
		})
		expect(restored).toEqual({ ok: false, reason: 'too_many_discounts' })
	})

	it('refuses codes past the cap per organization, not counting the discount being saved', async () => {
		const { user, organization } = await setupTestOrgWithUser()
		const mine = await createDiscount({
			organizationId: organization.id,
			userId: user.id,
			definition,
			codes: [{ id: null, code: 'MINE01', maxUses: null }],
		})
		if (!mine.ok) throw new Error('create failed')
		const other = await createDiscount({
			organizationId: organization.id,
			userId: user.id,
			definition,
			codes: [{ id: null, code: 'SEED001', maxUses: null }],
		})
		if (!other.ok) throw new Error('create failed')
		// Fill the organization to one under the cap with codes on another discount.
		const seeded = MAX_CODES_PER_ORG - 3
		for (let done = 0; done < seeded; done += 40) {
			await db.insert(DiscountCode).values(
				Array.from({ length: Math.min(40, seeded - done) }, (_, index) => ({
					organizationId: organization.id,
					discountId: other.id,
					code: `FILL${done + index}`,
					normalizedCode: `FILL${done + index}`,
					maxUses: null,
				})),
			)
		}
		// 2 codes exist already (MINE01, SEED001) plus the fill: one place is left.
		const tooMany = await createDiscount({
			organizationId: organization.id,
			userId: user.id,
			definition,
			codes: [
				{ id: null, code: 'NEW0001', maxUses: null },
				{ id: null, code: 'NEW0002', maxUses: null },
			],
		})
		expect(tooMany).toEqual({ ok: false, reason: 'too_many_codes' })
		expect(
			(
				await createDiscount({
					organizationId: organization.id,
					userId: user.id,
					definition,
					codes: [{ id: null, code: 'NEW0003', maxUses: null }],
				})
			).ok,
		).toBe(true)
		// Saving the first discount with its own code swapped uses its own slot.
		const [mineCode] = await activeCodes(mine.id)
		const swapped = await updateDiscount({
			organizationId: organization.id,
			discountId: mine.id,
			expectedVersion: mine.version,
			definition,
			codes: [{ id: mineCode!.id, code: 'MINE02', maxUses: null }],
		})
		expect(swapped.ok).toBe(true)
		// But adding a second code to it does not fit.
		const grown = await updateDiscount({
			organizationId: organization.id,
			discountId: mine.id,
			expectedVersion: 2,
			definition,
			codes: [
				{ id: mineCode!.id, code: 'MINE02', maxUses: null },
				{ id: null, code: 'MINE03', maxUses: null },
			],
		})
		expect(grown).toEqual({ ok: false, reason: 'too_many_codes' })
	})
})
