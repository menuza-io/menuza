import { describe, expect, it } from 'vitest'
import {
	type MockEventRow,
	type MockObjectRow,
	type MockStore,
	updateObject,
} from './store'

const object = (overrides: Partial<MockObjectRow> = {}): MockObjectRow => ({
	provider: 'stripe',
	id: 'obj_1',
	type: 'customer',
	parentId: null,
	json: { id: 'obj_1', status: 'open' },
	transitionAt: null,
	createdAt: 1000,
	updatedAt: 1000,
	...overrides,
})

const event = (overrides: Partial<MockEventRow> = {}): MockEventRow => ({
	provider: 'stripe',
	id: 'evt_1',
	type: 'checkout.session.completed',
	payload: '{"id":"evt_1"}',
	connectAccount: null,
	createdAt: 1000,
	deliveredAt: null,
	attempts: 0,
	lastStatus: null,
	deliverAfter: null,
	claimedAt: null,
	...overrides,
})

/** One suite, run against the memory store and the App's SQL store. */
export function runStoreContract(
	name: string,
	create: () => Promise<MockStore>,
) {
	describe(`MockStore contract: ${name}`, () => {
		it('inserts once and reads back JSON', async () => {
			const store = await create()
			await store.reset()
			expect(await store.insertObject(object())).toBe(true)
			expect(await store.insertObject(object())).toBe(false)
			const row = await store.getObject('stripe', 'obj_1')
			expect(row).toMatchObject({
				type: 'customer',
				parentId: null,
				createdAt: 1000,
			})
			expect(row?.json).toMatchObject({ id: 'obj_1', status: 'open', __rev: 0 })
			expect(await store.getObject('checkout', 'obj_1')).toBeNull()
		})

		it('replaces only while the revision matches (single-shot transitions)', async () => {
			const store = await create()
			await store.reset()
			await store.insertObject(object())
			const replace = (rev: number, status: string) =>
				store.replaceObject({
					provider: 'stripe',
					id: 'obj_1',
					json: { id: 'obj_1', status },
					expectedRev: rev,
					transitionAt: null,
					updatedAt: 2000,
				})
			expect(await replace(0, 'complete')).toBe(true)
			expect(await replace(0, 'expired')).toBe(false)
			expect((await store.getObject('stripe', 'obj_1'))?.json).toMatchObject({
				status: 'complete',
				__rev: 1,
			})
			expect(await replace(1, 'refunded')).toBe(true)
		})

		it('updateObject retries a lost race and aborts cleanly when the mutator throws', async () => {
			const store = await create()
			await store.reset()
			await store.insertObject(object({ json: { id: 'obj_1', count: 0 } }))
			await Promise.all(
				Array.from({ length: 5 }, () =>
					updateObject(
						store,
						{ provider: 'stripe', id: 'obj_1', now: 3000 },
						(json) => {
							json.count += 1
						},
					),
				),
			)
			expect((await store.getObject('stripe', 'obj_1'))?.json.count).toBe(5)
			await expect(
				updateObject(
					store,
					{ provider: 'stripe', id: 'obj_1', now: 3000 },
					() => {
						throw new Error('abort')
					},
				),
			).rejects.toThrow('abort')
			expect((await store.getObject('stripe', 'obj_1'))?.json.count).toBe(5)
		})

		it('lists by type and parent, newest first, and finds due transitions', async () => {
			const store = await create()
			await store.reset()
			await store.insertObject(
				object({ id: 'a', type: 'refund', parentId: 'ch_1', createdAt: 1 }),
			)
			await store.insertObject(
				object({
					id: 'b',
					type: 'refund',
					parentId: 'ch_1',
					createdAt: 2,
					transitionAt: 50,
				}),
			)
			await store.insertObject(
				object({
					id: 'c',
					type: 'refund',
					parentId: 'ch_2',
					createdAt: 3,
					transitionAt: 500,
				}),
			)
			await store.insertObject(
				object({ provider: 'checkout', id: 'd', type: 'refund', createdAt: 4 }),
			)
			expect(
				(await store.listObjects('stripe', { type: 'refund' })).map(
					(row) => row.id,
				),
			).toEqual(['c', 'b', 'a'])
			expect(
				(await store.listObjects('stripe', { parentId: 'ch_1' })).map(
					(row) => row.id,
				),
			).toEqual(['b', 'a'])
			expect(
				(await store.listObjects('stripe', { limit: 1 })).map((row) => row.id),
			).toEqual(['c'])
			expect((await store.dueObjects(100)).map((row) => row.id)).toEqual(['b'])
			expect((await store.dueObjects(1000)).map((row) => row.id)).toEqual([
				'b',
				'c',
			])
		})

		it('stores an idempotency key once', async () => {
			const store = await create()
			await store.reset()
			const row = {
				provider: 'stripe' as const,
				key: 'k',
				requestHash: 'h',
				status: 200,
				response: '{}',
				createdAt: 1,
			}
			expect(await store.putIdempotency(row)).toBe(true)
			expect(await store.putIdempotency({ ...row, requestHash: 'other' })).toBe(
				false,
			)
			expect(await store.getIdempotency('stripe', 'k')).toMatchObject({
				requestHash: 'h',
				status: 200,
			})
			expect(await store.getIdempotency('checkout', 'k')).toBeNull()
		})

		it('records events, claims one delivery at a time and tracks attempts', async () => {
			const store = await create()
			await store.reset()
			await store.insertEvent(event({ id: 'e1', createdAt: 1 }))
			await store.insertEvent(
				event({
					id: 'e2',
					createdAt: 2,
					type: 'payment_intent.succeeded',
					deliverAfter: 5000,
				}),
			)
			await store.insertEvent(
				event({
					provider: 'checkout',
					id: 'e3',
					createdAt: 3,
					type: 'payment_approved',
				}),
			)
			expect((await store.listEvents()).map((row) => row.id)).toEqual([
				'e3',
				'e2',
				'e1',
			])
			expect(
				(await store.listEvents({ provider: 'stripe' })).map((row) => row.id),
			).toEqual(['e2', 'e1'])
			expect(
				(await store.listEvents({ type: 'payment_approved' })).map(
					(row) => row.id,
				),
			).toEqual(['e3'])
			expect(
				(
					await store.undeliveredEvents({ provider: 'stripe', dueBefore: 1000 })
				).map((row) => row.id),
			).toEqual(['e1'])

			expect(await store.claimEvent('stripe', 'e1', 100, 30_000)).toBe(true)
			expect(await store.claimEvent('stripe', 'e1', 200, 30_000)).toBe(false)
			expect(await store.claimEvent('stripe', 'e1', 40_000, 30_000)).toBe(true)
			await store.recordDelivery({
				provider: 'stripe',
				id: 'e1',
				status: 500,
				at: 300,
			})
			expect(await store.getEvent('stripe', 'e1')).toMatchObject({
				attempts: 1,
				lastStatus: 500,
				deliveredAt: null,
				claimedAt: null,
			})
			expect(
				(await store.undeliveredEvents({ provider: 'stripe' })).map(
					(row) => row.id,
				),
			).toContain('e1')
			await store.recordDelivery({
				provider: 'stripe',
				id: 'e1',
				status: 200,
				at: 400,
			})
			expect(await store.getEvent('stripe', 'e1')).toMatchObject({
				attempts: 2,
				lastStatus: 200,
				deliveredAt: 400,
			})
			expect(
				(await store.undeliveredEvents({ provider: 'stripe' })).map(
					(row) => row.id,
				),
			).toEqual(['e2'])
		})

		it('reset wipes every table', async () => {
			const store = await create()
			await store.insertObject(object({ id: 'z' }))
			await store.insertEvent(event({ id: 'ez' }))
			await store.reset()
			expect(await store.getObject('stripe', 'z')).toBeNull()
			expect(await store.listEvents()).toEqual([])
		})
	})
}
