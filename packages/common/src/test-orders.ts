import { z } from 'zod'

/**
 * Free test orders before going live (#119). An operator places a test order
 * through the real guest flow with a one-time code; the order runs the whole
 * path (kitchen screens, tickets, confirmation email) without money and
 * without touching sales, loyalty, stock, discounts or marketing.
 *
 * A code is never stored: it is an HMAC over the organization, the location, a
 * nonce and an expiry (`test-orders:v1`). The region records the nonce when it
 * is minted (for the daily limit) and when it is spent (one order per code).
 */

export const TEST_ORDER_FLAG = 'launch.test_order'
/** The header Sites sends on `POST /orders` with the code. */
export const TEST_ORDER_HEADER = 'X-Test-Order'
/** Valid for one order, for 30 minutes. */
export const TEST_ORDER_CODE_TTL_MS = 30 * 60 * 1000
/** At most this many codes per location per day (`test_order_limit`). */
export const TEST_ORDER_DAILY_LIMIT = 10
/** An open test order completes itself after this long (regional tick). */
export const TEST_ORDER_AUTO_COMPLETE_MS = 2 * 60 * 60 * 1000
/** Spent and expired nonces are pruned after a day. */
export const TEST_ORDER_NONCE_RETENTION_MS = 24 * 60 * 60 * 1000
/** What the kitchen screens and the Orders inbox show. */
export const TEST_ORDER_BADGE = 'TEST'
export const TEST_ORDER_CODE_PREFIX = 'tc1'

export const TEST_ORDER_ERROR_CODES = [
	'test_code_invalid',
	'test_order_limit',
	'test_orders_disabled',
	'test_order_unsupported',
	'not_a_test_order',
] as const
export type TestOrderErrorCode = (typeof TEST_ORDER_ERROR_CODES)[number]

export const mintTestOrderCodeRequestSchema = z.strictObject({
	locationId: z.string().trim().min(1).max(100),
})

/** "Did the ticket print?" Yes or No, recorded on the order. */
export const TEST_PRINT_ANSWERS = ['yes', 'no'] as const
export type TestPrintAnswer = (typeof TEST_PRINT_ANSWERS)[number]
export const testPrintAnswerSchema = z.strictObject({
	answer: z.enum(TEST_PRINT_ANSWERS),
})

/** The message the code's HMAC covers. Fields are length-prefixed by `:`. */
export function testOrderCodeMessage(input: {
	orgId: string
	locationId: string
	nonce: string
	exp: number
}): string {
	return [
		'test-orders:v1',
		input.orgId,
		input.locationId,
		input.nonce,
		String(input.exp),
	].join(':')
}

const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,64}$/
const MAC_PATTERN = /^[0-9a-f]{64}$/

export type ParsedTestOrderCode = {
	locationId: string
	nonce: string
	exp: number
	mac: string
}

/** `tc1.<locationId>.<nonce>.<exp>.<mac>`; ids never contain a dot. */
export function serializeTestOrderCode(input: ParsedTestOrderCode): string {
	return [
		TEST_ORDER_CODE_PREFIX,
		input.locationId,
		input.nonce,
		String(input.exp),
		input.mac,
	].join('.')
}

export function parseTestOrderCode(raw: unknown): ParsedTestOrderCode | null {
	if (typeof raw !== 'string' || raw.length > 400) return null
	const parts = raw.split('.')
	if (parts.length !== 5 || parts[0] !== TEST_ORDER_CODE_PREFIX) return null
	const [, locationId, nonce, expText, mac] = parts as [
		string,
		string,
		string,
		string,
		string,
	]
	if (!locationId || locationId.length > 100) return null
	if (!NONCE_PATTERN.test(nonce) || !MAC_PATTERN.test(mac)) return null
	if (!/^\d{10,16}$/.test(expText)) return null
	return { locationId, nonce, exp: Number(expText), mac }
}

/**
 * The Orders inbox, Station and the kitchen display badge test orders; one
 * predicate keeps the screens alike.
 */
export function isTestOrder(order: { isTest?: boolean | null }): boolean {
	return order.isTest === true
}
