import { beforeEach, describe, expect, it, jest } from '@jest/globals'
import * as SecureStore from 'expo-secure-store'
import {
	createMemoryReservationTokenStore,
	createSecureReservationTokenStore,
	EMPTY_RESERVATION_TOKENS,
	forgetAllReservationTokens,
	isEmptyReservationTokens,
	parseReservationTokens,
	RESERVATION_TOKENS_INDEX_KEY,
	RESERVATION_TOKENS_KEY,
	RESERVATION_TOKENS_MAX_BYTES,
	reservationTokensKey,
	serializeReservationTokens,
	storedReservationTokenKeys,
} from './token-store'

describe('ReservationTokenStore', () => {
	beforeEach(() => {
		jest.clearAllMocks()
	})

	it('remembers and forgets manage and waitlist tokens', async () => {
		const store = createMemoryReservationTokenStore()
		await store.rememberManage('rsv_1', 'tok_a')
		await store.rememberManage('rsv_2', 'tok_b')
		await store.rememberWaitlist('wle_1', 'tok_w')
		expect((await store.load()).manage.rsv_1).toBe('tok_a')
		expect((await store.load()).waitlist.wle_1).toBe('tok_w')

		await store.forgetManage('rsv_1')
		expect((await store.load()).manage.rsv_1).toBeUndefined()
		expect((await store.load()).manage.rsv_2).toBe('tok_b')

		await store.forgetWaitlist('wle_1')
		expect((await store.load()).waitlist).toEqual({})

		await store.clear()
		expect(isEmptyReservationTokens(await store.load())).toBe(true)
		expect(store.raw).toBeNull()
	})

	it('round-trips the stored tokens through JSON', () => {
		const tokens = { manage: { rsv_1: 'tok_a' }, waitlist: { wle_1: 'tok_w' } }
		expect(parseReservationTokens(serializeReservationTokens(tokens))).toEqual(
			tokens,
		)
		expect(JSON.parse(serializeReservationTokens(tokens))).toEqual(tokens)
	})

	it('reads malformed storage as no tokens', () => {
		expect(parseReservationTokens(null)).toBe(EMPTY_RESERVATION_TOKENS)
		expect(parseReservationTokens('not json')).toEqual(EMPTY_RESERVATION_TOKENS)
		expect(parseReservationTokens('[]')).toEqual(EMPTY_RESERVATION_TOKENS)
		expect(
			parseReservationTokens('{"manage":{"a":1},"waitlist":{"b":"t"}}'),
		).toEqual({
			manage: {},
			waitlist: { b: 't' },
		})
	})

	it('keeps concurrent changes', async () => {
		const store = createMemoryReservationTokenStore()
		await Promise.all([
			store.rememberManage('rsv_1', 'tok_a'),
			store.rememberManage('rsv_2', 'tok_b'),
			store.rememberWaitlist('wle_1', 'tok_w'),
		])
		expect(await store.load()).toEqual({
			manage: { rsv_1: 'tok_a', rsv_2: 'tok_b' },
			waitlist: { wle_1: 'tok_w' },
		})
	})

	it('keeps the tokens in secure storage under a valid per-organization key', async () => {
		const key = reservationTokensKey('org_1')
		expect(key).toMatch(/^[\w.-]+$/)
		expect(reservationTokensKey('org/1 x')).toMatch(/^[\w.-]+$/)
		const store = createSecureReservationTokenStore('org_1')
		await store.rememberManage('rsv_1', 'tok_a')
		expect(SecureStore.setItemAsync).toHaveBeenCalledWith(
			key,
			JSON.stringify({ manage: { rsv_1: 'tok_a' }, waitlist: {} }),
			{ keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY },
		)
		expect(await createSecureReservationTokenStore('org_1').load()).toEqual({
			manage: { rsv_1: 'tok_a' },
			waitlist: {},
		})
		await store.clear()
		expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith(key)
		expect(await SecureStore.getItemAsync(key)).toBeNull()
	})

	it('never shows one organization the booking codes of another', async () => {
		await createSecureReservationTokenStore('org_1').rememberManage(
			'rsv_1',
			'tok_a',
		)
		expect(
			isEmptyReservationTokens(
				await createSecureReservationTokenStore('org_2').load(),
			),
		).toBe(true)
		expect(await SecureStore.getItemAsync(RESERVATION_TOKENS_KEY)).toBeNull()
	})

	it('indexes every organization key it writes, so all of them can be deleted', async () => {
		await createSecureReservationTokenStore('org_1').rememberManage(
			'rsv_1',
			'tok_a',
		)
		await createSecureReservationTokenStore('org_2').rememberWaitlist(
			'wle_1',
			'tok_w',
		)
		expect(await storedReservationTokenKeys()).toEqual([
			reservationTokensKey('org_1'),
			reservationTokensKey('org_2'),
			RESERVATION_TOKENS_INDEX_KEY,
			RESERVATION_TOKENS_KEY,
		])

		await createSecureReservationTokenStore('org_1').clear()
		expect(await storedReservationTokenKeys()).toEqual([
			reservationTokensKey('org_2'),
			RESERVATION_TOKENS_INDEX_KEY,
			RESERVATION_TOKENS_KEY,
		])
	})

	it('deletes the booking codes of every organization when the app leaves its site', async () => {
		await createSecureReservationTokenStore('org_1').rememberManage(
			'rsv_1',
			'tok_a',
		)
		await createSecureReservationTokenStore('org_2').rememberWaitlist(
			'wle_1',
			'tok_w',
		)

		await forgetAllReservationTokens()

		for (const orgId of ['org_1', 'org_2']) {
			expect(
				isEmptyReservationTokens(
					await createSecureReservationTokenStore(orgId).load(),
				),
			).toBe(true)
		}
		expect(
			await SecureStore.getItemAsync(RESERVATION_TOKENS_INDEX_KEY),
		).toBeNull()
	})

	it('drops the oldest manage tokens to stay under the secure store value limit', async () => {
		const store = createMemoryReservationTokenStore()
		await store.rememberPayment('rsv_000')
		for (let index = 0; index < 40; index += 1) {
			const id = `rsv_${String(index).padStart(3, '0')}`
			await store.rememberManage(id, `tok_${'x'.repeat(60)}_${index}`)
		}
		await store.rememberWaitlist('wle_1', 'tok_w')

		const raw = store.raw!
		expect(new TextEncoder().encode(raw).length).toBeLessThanOrEqual(
			RESERVATION_TOKENS_MAX_BYTES,
		)
		const stored = await store.load()
		expect(stored.manage.rsv_039).toBeDefined()
		expect(stored.manage.rsv_001).toBeUndefined()
		// The payment in progress and the waitlist entry are never dropped.
		expect(stored.manage.rsv_000).toBeDefined()
		expect(stored.payment).toBe('rsv_000')
		expect(stored.waitlist).toEqual({ wle_1: 'tok_w' })
	})

	it('remembers and forgets the payment in progress', async () => {
		const store = createMemoryReservationTokenStore()
		await store.rememberPayment('rsv_1')
		expect((await store.load()).payment).toBe('rsv_1')
		expect(isEmptyReservationTokens(await store.load())).toBe(false)
		await store.forgetPayment('rsv_other')
		expect((await store.load()).payment).toBe('rsv_1')
		await store.forgetPayment('rsv_1')
		expect((await store.load()).payment).toBeUndefined()
		expect(store.raw).toBeNull()
		expect(parseReservationTokens('{"manage":{},"waitlist":{},"payment":5}')).toEqual(
			EMPTY_RESERVATION_TOKENS,
		)
	})

	it('reports a failed write instead of throwing', async () => {
		jest
			.mocked(SecureStore.setItemAsync)
			.mockRejectedValueOnce(new Error('locked'))
		const store = createSecureReservationTokenStore('org_1')
		await expect(store.rememberManage('rsv_1', 'tok_a')).resolves.toBe(false)
	})
})
