import 'fake-indexeddb/auto'
import { createClockQueue } from '@repo/staffing/clock-queue'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	flushPunches,
	resetPunchQueueForTests,
} from '../apps/timeclock/clock.ts'
import { db } from './db.ts'
import { usePos } from './store.ts'

const unitRow = {
	key: 'zatca:unit',
	value: {
		environment: 'sandbox',
		privateKeyHex: 'a'.repeat(64),
		certificate: 'cert',
		seller: {},
	},
}

beforeEach(async () => {
	await db.meta.clear()
	await db.orders.clear()
	await db.meta.put(unitRow)
	await db.meta.put({ key: 'zatca:pih', value: 'P'.repeat(43) + '=' })
	usePos.setState({
		settings: {
			...usePos.getState().settings,
			appUrl: 'https://app.example.com',
			slug: 'demo',
			tenantApiUrl: 'https://api.example.com',
			deviceToken: 'pdv1.secret',
			demo: false,
		},
	})
})

afterEach(() => {
	vi.unstubAllGlobals()
	resetPunchQueueForTests()
})

const settled = () => new Promise((resolve) => setTimeout(resolve, 20))

describe('a terminal that stops being this restaurant’s', () => {
	it('unpairing forgets the ZATCA signing key and chain hash', async () => {
		usePos.getState().unpair()
		await settled()
		expect(await db.meta.get('zatca:unit')).toBeUndefined()
		expect(await db.meta.get('zatca:pih')).toBeUndefined()
		expect(usePos.getState().settings.deviceToken).toBeNull()
	})

	it('the server saying it was removed forgets them too', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ error: 'device_revoked' }), {
					status: 401,
				}),
			),
		)
		await usePos.getState().verifyPairing()
		expect(usePos.getState().pairingLost).toBe(true)
		expect(await db.meta.get('zatca:unit')).toBeUndefined()
	})
})

describe('punches on a till that can no longer send them', () => {
	it('sets aside those too old to record, PINs dropped, and sends the rest once paired again', async () => {
		const hour = 60 * 60 * 1000
		const queue = createClockQueue({
			indexedDB: new IDBFactory(),
			crypto,
			dbName: 'store-punches',
		})
		resetPunchQueueForTests(queue)
		const punch = { kind: 'clock_in' as const, pin: '4821' }
		await queue.enqueue({
			...punch,
			id: 'old',
			clientAt: Date.now() - 50 * hour,
			createdAt: 1,
		})
		await queue.enqueue({
			...punch,
			id: 'recent',
			clientAt: Date.now() - 47 * hour,
			createdAt: 2,
		})
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						outcome: 'accepted',
						duplicate: false,
						kind: 'clock_in',
						state: 'in',
						firstName: 'Rana',
						at: Date.now(),
						serverNow: Date.now(),
					}),
				),
		)
		vi.stubGlobal('fetch', fetchMock)
		// A manager removed the tablet: no device secret, so nothing can be sent.
		usePos.setState({
			settings: { ...usePos.getState().settings, deviceToken: null },
		})
		await usePos.getState().sync()
		expect(fetchMock).not.toHaveBeenCalled()
		expect(await queue.failed()).toEqual([
			expect.objectContaining({
				id: 'old',
				failure: 'punch_too_old',
				pin: null,
			}),
		])
		// Paired again within 48 hours: the rest still goes out.
		await flushPunches(
			{ ...usePos.getState().settings, deviceToken: 'pdv1.again' },
			true,
		)
		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect(await queue.counts()).toEqual({ queued: 0, failed: 1 })
	})
})

describe('pairing from a link', () => {
	it('refuses a link to a server that is not https before contacting it', async () => {
		const fetchMock = vi.fn()
		vi.stubGlobal('fetch', fetchMock)
		const code = `ppc1.org_1.${'a'.repeat(43)}`
		const problem = await usePos
			.getState()
			.pair(
				`https://pos.example.com/#a=${encodeURIComponent('http://evil.example.net')}&c=${code}`,
			)
		expect(problem).toMatch(/secure \(https\)/)
		expect(fetchMock).not.toHaveBeenCalled()
		expect(usePos.getState().settings.tenantApiUrl).toBe(
			'https://api.example.com',
		)
	})
})

describe('taking over another terminal’s tab', () => {
	it('refuses a tab with no tax rate before claiming it', async () => {
		const fetchMock = vi.fn()
		vi.stubGlobal('fetch', fetchMock)
		const problem = await usePos.getState().takeOverTab({
			terminal: { code: 'T2', label: 'Bar' },
			order: { id: 'o1', revision: 2, taxRatePercent: null } as never,
		})
		expect(problem).toMatch(/no tax rate/)
		expect(fetchMock).not.toHaveBeenCalled()
	})
})

describe('adding to a tab that already went to the kitchen', () => {
	const dish = {
		itemId: 'i-burger',
		name: 'Burger',
		variantId: null,
		variantLabel: null,
		quantity: 1,
		baseCents: 1000,
		instructions: '',
		options: [],
	}
	beforeEach(() => usePos.getState().clearOrder())

	it('rings the same dish again as a new line, not more of the sent one', () => {
		usePos.setState({ lines: [{ ...dish, id: 'sent', sentAt: 1_000 }] })
		usePos.getState().addLine(dish)
		usePos.getState().addLine(dish)
		const lines = usePos.getState().lines
		expect(lines.map((l) => [l.quantity, l.sentAt ?? null])).toEqual([
			[1, 1_000],
			[2, null],
		])
	})

	it('turns "one more" of a sent dish into a line not sent yet', () => {
		usePos.setState({ lines: [{ ...dish, id: 'sent', sentAt: 1_000 }] })
		usePos.getState().setQuantity('sent', 3)
		const lines = usePos.getState().lines
		expect(
			lines.map((l) => [l.id === 'sent', l.quantity, l.sentAt ?? null]),
		).toEqual([
			[true, 1, 1_000],
			[false, 2, null],
		])
		// Fewer is still fewer of the sent line (taking it off needs a reason on save).
		usePos.getState().setQuantity('sent', 0)
		expect(usePos.getState().lines.map((l) => l.sentAt ?? null)).toEqual([null])
	})

	it('rings a copy of a served round as new: not sent, not served', () => {
		usePos.setState({
			lines: [{ ...dish, id: 'sent', sentAt: 1_000, servedAt: 2_000 }],
		})
		usePos.getState().addLine({ ...dish, sentAt: 1_000, servedAt: 2_000 })
		const added = usePos.getState().lines[1]!
		expect([added.sentAt, added.servedAt]).toEqual([undefined, undefined])
	})

	it('sends more of a sent dish from the item sheet as a new round', () => {
		usePos.setState({
			lines: [{ ...dish, id: 'sent', quantity: 2, sentAt: 1_000 }],
		})
		usePos.getState().replaceLine('sent', { ...dish, quantity: 3 })
		expect(
			usePos.getState().lines.map((l) => [l.quantity, l.sentAt ?? null]),
		).toEqual([
			[2, 1_000],
			[1, null],
		])
		// Fewer stays the same line (taking it off needs a reason on save).
		usePos.getState().replaceLine('sent', { ...dish, quantity: 1 })
		expect(usePos.getState().lines[0]).toMatchObject({
			quantity: 1,
			sentAt: 1_000,
		})
	})

	it('puts a sent dish back after one fewer then one more, sending nothing again', () => {
		usePos.setState({
			lines: [
				{ ...dish, id: 'sent', quantity: 2, sentAt: 1_000, sentQuantity: 2 },
			],
		})
		usePos.getState().setQuantity('sent', 1)
		usePos.getState().setQuantity('sent', 2)
		expect(
			usePos.getState().lines.map((l) => [l.quantity, l.sentAt ?? null]),
		).toEqual([[2, 1_000]])
		usePos.getState().setQuantity('sent', 3)
		expect(
			usePos.getState().lines.map((l) => [l.quantity, l.sentAt ?? null]),
		).toEqual([
			[2, 1_000],
			[1, null],
		])
	})

	it('starts another line past 50 of a dish instead of dropping the rest', () => {
		usePos.setState({ lines: [{ ...dish, id: 'new', quantity: 48 }] })
		usePos.getState().addLine({ ...dish, quantity: 5 })
		expect(usePos.getState().lines.map((l) => l.quantity)).toEqual([50, 3])
	})

	it('keeps what was sent through an unchanged edit, so one more is no new round', () => {
		usePos.setState({
			lines: [
				{ ...dish, id: 'sent', quantity: 1, sentAt: 1_000, sentQuantity: 3 },
			],
		})
		usePos.getState().replaceLine('sent', { ...dish, quantity: 1 })
		expect(usePos.getState().lines[0]!.sentQuantity).toBe(3)
		usePos.getState().setQuantity('sent', 2)
		expect(
			usePos.getState().lines.map((l) => [l.quantity, l.sentAt ?? null]),
		).toEqual([[2, 1_000]])
	})

	it('lets a tab taken over elsewhere go, keeping only what was not sent', () => {
		usePos.setState({
			activeOrderId: 'tab',
			adjustments: [],
			lines: [
				{ ...dish, id: 'sent', sentAt: 1_000 },
				{ ...dish, id: 'new', instructions: 'Extra pickles' },
			],
		})
		usePos.getState().releaseTab()
		const { activeOrderId, lines } = usePos.getState()
		expect(activeOrderId).toBeNull()
		expect(lines.map((l) => [l.id, l.sentAt ?? null])).toEqual([['new', null]])
	})

	it('makes a changed dish new work, and leaves an unchanged one sent', () => {
		usePos.setState({ lines: [{ ...dish, id: 'sent', sentAt: 1_000 }] })
		usePos.getState().replaceLine('sent', dish)
		expect(usePos.getState().lines[0]!.sentAt).toBe(1_000)
		usePos.getState().replaceLine('sent', { ...dish, instructions: 'No bun' })
		expect(usePos.getState().lines[0]!.sentAt).toBeUndefined()
	})
})

describe('discounts on the cart', () => {
	const dish = {
		itemId: 'i-burger',
		name: 'Burger',
		variantId: null,
		variantLabel: null,
		quantity: 1,
		baseCents: 10_000,
		instructions: '',
		options: [],
	}
	const target = {
		scope: 'order',
		itemIds: [],
		categoryIds: [],
		excludeItemIds: [],
		excludeCategoryIds: [],
	}
	const rule = (over: Record<string, unknown>) => ({
		id: 'd1',
		version: 1,
		createdAt: '2026-01-01T00:00:00.000Z',
		name: 'Happy hour',
		internalName: null,
		description: null,
		status: 'active',
		application: 'automatic',
		valueType: 'percent',
		percentBp: 1000,
		amountMinor: null,
		currency: null,
		maxDiscountMinor: null,
		target,
		requirement: null,
		quantityRule: { kind: 'none' },
		maxDiscountedUnits: null,
		minSubtotalMinor: null,
		locationIds: null,
		channels: ['pos'],
		fulfillments: ['pickup', 'dine_in'],
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
		...over,
	})
	const withRules = (rules: unknown[], rulesAt = Date.now()) =>
		usePos.setState({
			snapshot: {
				key: 'catalog',
				fetchedAt: Date.now(),
				organization: { currency: 'USD' },
				menu: {
					organization: { currency: 'USD' },
					discountRules: rules,
					discountRulesAt: rulesAt,
				},
			} as never,
		})
	beforeEach(() => {
		usePos.getState().clearOrder()
		usePos.setState({ snapshot: null, discountNotice: null })
	})

	it('takes one manual discount at a time: a new one replaces the old', () => {
		withRules([
			rule({ id: 'm1', name: 'Staff', application: 'manual', percentBp: 1000 }),
			rule({
				id: 'm2',
				name: 'Friend',
				application: 'manual',
				percentBp: 5000,
			}),
		])
		usePos.getState().addLine(dish)
		expect(usePos.getState().applyManualDiscount('m1')).toMatchObject({
			ok: true,
			amountMinor: 1000,
		})
		const second = usePos.getState().applyManualDiscount('m2')
		expect(second).toMatchObject({
			ok: true,
			amountMinor: 5000,
			replacedManual: 'Staff',
		})
		const rows = usePos.getState().adjustments
		expect(rows.map((row) => row.id)).toEqual(['manual:m2'])
	})

	it('applies an approval-required manual discount with only a reason when sign-in is off', () => {
		withRules([
			rule({
				id: 'm1',
				application: 'manual',
				percentBp: 1000,
				requireApproval: true,
			}),
		])
		usePos.getState().addLine(dish)
		expect(
			usePos
				.getState()
				.applyManualDiscount('m1', { reason: 'Guest complaint' }),
		).toMatchObject({ ok: true, amountMinor: 1000 })
	})

	it('a refused manual discount leaves the one on the cart alone', () => {
		withRules([
			rule({ id: 'm1', application: 'manual', percentBp: 1000 }),
			rule({
				id: 'm2',
				application: 'manual',
				valueType: 'variable_percent',
				percentBp: null,
			}),
		])
		usePos.getState().addLine(dish)
		usePos.getState().applyManualDiscount('m1')
		expect(
			usePos.getState().applyManualDiscount('m2', { percentBp: 15_000 }),
		).toEqual({ ok: false, reason: 'over_100' })
		expect(usePos.getState().adjustments.map((row) => row.id)).toEqual([
			'manual:m1',
		])
	})

	it('quotes a manual discount on the total after the automatic ones', () => {
		withRules([
			rule({ percentBp: 4000 }),
			rule({ id: 'm1', application: 'manual', percentBp: 10_000 }),
		])
		usePos.getState().addLine(dish)
		expect(usePos.getState().applyManualDiscount('m1')).toMatchObject({
			ok: true,
			amountMinor: 6000,
		})
		const rows = usePos.getState().adjustments
		expect(rows.reduce((sum, row) => sum + row.amountCents, 0)).toBe(10_000)
	})

	it('a manual discount that does not combine replaces the automatic one, and says so', () => {
		withRules([
			rule({}),
			rule({
				id: 'm1',
				application: 'manual',
				percentBp: 2000,
				combinable: false,
			}),
		])
		usePos.getState().addLine(dish)
		expect(usePos.getState().adjustments.map((row) => row.id)).toEqual([
			'auto:d1',
		])
		usePos.getState().applyManualDiscount('m1')
		expect(usePos.getState().adjustments.map((row) => row.id)).toEqual([
			'manual:m1',
		])
		expect(usePos.getState().discountNotice).toEqual({
			kind: 'replaced',
			names: ['Happy hour'],
		})
		// Taking it off brings the automatic discount back.
		usePos.getState().removeManualDiscount('m1')
		expect(usePos.getState().adjustments.map((row) => row.id)).toEqual([
			'auto:d1',
		])
		expect(usePos.getState().discountNotice).toBeNull()
	})

	it('stops applying discounts once the rules are over 24 hours old', () => {
		const old = Date.now() - 25 * 60 * 60 * 1000
		withRules(
			[rule({}), rule({ id: 'm1', application: 'manual', percentBp: 1000 })],
			old,
		)
		usePos.getState().addLine(dish)
		expect(usePos.getState().adjustments).toEqual([])
		expect(usePos.getState().applyManualDiscount('m1')).toEqual({
			ok: false,
			reason: 'rules_stale',
		})
		// A refresh brings them back.
		withRules([rule({})])
		usePos.getState().addLine(dish)
		expect(usePos.getState().adjustments.map((row) => row.id)).toEqual([
			'auto:d1',
		])
	})

	it('says once that automatic discounts were skipped because the rules are old', () => {
		const old = Date.now() - 25 * 60 * 60 * 1000
		withRules([rule({})], old)
		usePos.getState().addLine(dish)
		expect(usePos.getState().adjustments).toEqual([])
		const notice = usePos.getState().discountNotice
		expect(notice).toEqual({ kind: 'rules_old', names: ['Happy hour'] })
		// Another edit keeps the same notice (nothing new to announce).
		usePos.getState().addLine(dish)
		expect(usePos.getState().discountNotice).toBe(notice)
		// Dismissed, it does not come back with the next edit.
		usePos.getState().clearDiscountNotice()
		usePos.getState().addLine(dish)
		expect(usePos.getState().discountNotice).toBeNull()
		// A refresh clears it for good; going stale again is news again.
		withRules([rule({})])
		usePos.getState().addLine(dish)
		expect(usePos.getState().discountNotice).toBeNull()
		expect(usePos.getState().staleRulesNoticeKey).toBeNull()
		withRules([rule({})], old)
		usePos.getState().addLine(dish)
		expect(usePos.getState().discountNotice).toMatchObject({
			kind: 'rules_old',
		})
	})

	it('says nothing about old rules when no automatic discount would have applied', () => {
		const old = Date.now() - 25 * 60 * 60 * 1000
		withRules([rule({ id: 'm1', application: 'manual', percentBp: 1000 })], old)
		usePos.getState().addLine(dish)
		expect(usePos.getState().discountNotice).toBeNull()
	})

	it('a manual discount that no longer applies after the cart changes is dropped with a notice', () => {
		withRules([
			rule({
				id: 'm1',
				application: 'manual',
				percentBp: 1000,
				minSubtotalMinor: 5_000,
				currency: 'USD',
			}),
		])
		usePos.getState().addLine(dish)
		expect(usePos.getState().applyManualDiscount('m1').ok).toBe(true)
		const id = usePos.getState().lines[0]!.id
		usePos.getState().setQuantity(id, 0)
		usePos.getState().addLine({ ...dish, baseCents: 1_000 })
		expect(usePos.getState().adjustments).toEqual([])
		expect(usePos.getState().discountNotice).toMatchObject({
			kind: 'stopped',
			reason: expect.any(String),
		})
	})
	describe('a tab keeps the discounts its sent rounds already had', () => {
		const sendAll = () =>
			usePos.setState((s) => ({
				lines: s.lines.map((l) => ({
					...l,
					sentAt: Date.now() - 1_000,
					sentQuantity: l.quantity,
				})),
			}))
		const openTab = () => {
			withRules([rule({})])
			usePos.getState().addLine(dish)
			sendAll()
			expect(usePos.getState().adjustments.map((row) => row.id)).toEqual([
				'auto:d1',
			])
		}
		const total = () =>
			usePos
				.getState()
				.adjustments.reduce((sum, row) => sum + row.amountCents, 0)

		it('keeps the discount on a sent round when the rule is deleted', () => {
			openTab()
			withRules([rule({ id: 'other', percentBp: 500 })])
			usePos.getState().addLine(dish)
			const rows = usePos.getState().adjustments
			expect(rows.map((row) => [row.id, row.amountCents])).toEqual([
				['auto:d1', 1000],
				['auto:other', 500],
			])
		})

		it('keeps it when the list of rules is empty, and says so once', () => {
			openTab()
			withRules([])
			usePos.getState().addLine(dish)
			const state = usePos.getState()
			expect(state.adjustments.map((row) => [row.id, row.amountCents])).toEqual(
				[['auto:d1', 1000]],
			)
			expect(state.discountNotice).toMatchObject({
				kind: 'kept',
				names: ['Happy hour'],
			})
			// Another edit keeps the notice up; dismissed, it stays gone.
			usePos.getState().addLine(dish)
			expect(usePos.getState().discountNotice).toMatchObject({ kind: 'kept' })
			usePos.getState().clearDiscountNotice()
			usePos.getState().addLine(dish)
			expect(usePos.getState().discountNotice).toBeNull()
			expect(total()).toBe(1000)
		})

		it('a paused rule: the new round gets none, the old round keeps it', () => {
			openTab()
			withRules([rule({ status: 'paused' })])
			usePos.getState().addLine(dish)
			const [row] = usePos.getState().adjustments
			const [sentLine] = usePos.getState().lines
			expect(usePos.getState().adjustments).toHaveLength(1)
			expect(row?.lineAmounts).toEqual({ [sentLine!.id]: 1000 })
		})

		it('an edit to a smaller percent does not shrink the sent round', () => {
			openTab()
			withRules([rule({ percentBp: 500, version: 2 })])
			usePos.getState().addLine(dish)
			const [row] = usePos.getState().adjustments
			expect(row?.amountCents).toBe(1500)
			const [sentLine, newLine] = usePos.getState().lines
			expect(row?.lineAmounts).toEqual({
				[sentLine!.id]: 1000,
				[newLine!.id]: 500,
			})
		})

		it('an unsent cart with no rules has no discount', () => {
			withRules([rule({})])
			usePos.getState().addLine(dish)
			expect(total()).toBe(1000)
			withRules([])
			usePos.getState().addLine(dish)
			expect(usePos.getState().adjustments).toEqual([])
			expect(usePos.getState().discountNotice).toBeNull()
		})

		it('reopening a tab with such a discount raises the notice', () => {
			openTab()
			const adjustments = usePos.getState().adjustments
			const lines = usePos.getState().lines
			usePos.getState().clearOrder()
			withRules([])
			usePos.getState().loadTab({
				id: 'o1',
				taxRatePercent: 0,
				taxInclusive: false,
				orderType: 'dine_in',
				customerName: '',
				tableLabel: '',
				createdAt: Date.now(),
				lines,
				adjustments,
			} as never)
			expect(usePos.getState().discountNotice).toMatchObject({ kind: 'kept' })
		})

		it('never gives a line a discount that does not combine with the one it keeps', () => {
			withRules([rule({ combinable: false })])
			usePos.getState().addLine(dish)
			sendAll()
			withRules([
				rule({ combinable: false }),
				rule({ id: 'x', name: 'Half off', percentBp: 5000, combinable: false }),
			])
			usePos.getState().addLine({ ...dish, quantity: 1 })
			const sentId = usePos.getState().lines[0]!.id
			const taken = usePos
				.getState()
				.adjustments.reduce(
					(sum, row) => sum + (row.lineAmounts?.[sentId] ?? 0),
					0,
				)
			expect(taken).toBe(1000)
		})
	})
})
