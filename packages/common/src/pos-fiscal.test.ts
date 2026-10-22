import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
	issuePosFiscalDocument,
	newPosFiscalChain,
	POS_FISCAL_GENESIS_HASH,
	posFiscalHash,
	posRefundTaxCents,
	sha256Hex,
	zatcaQrPayload,
} from './pos-fiscal.ts'

const node = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')

describe('sha256Hex', () => {
	it('matches node:crypto across block boundaries and multi-byte text', () => {
		for (const input of [
			'',
			'abc',
			'a'.repeat(55),
			'a'.repeat(56),
			'a'.repeat(64),
			'a'.repeat(1000),
			'مطعم ☕ café',
		]) {
			expect(sha256Hex(input)).toBe(node(input))
		}
	})
})

describe('fiscal chain', () => {
	const chainId = '6f9d1d6e-3c3d-4d3f-9d4a-0d6a3a1b2c99'
	const doc = (docId: string) => ({
		kind: 'invoice' as const,
		docId,
		orderId: docId,
		at: '2026-10-21T12:00:00.000Z',
		currency: 'SAR',
		totalCents: 1150,
		taxCents: 150,
	})

	it('numbers documents consecutively and links each to the previous hash', () => {
		const first = issuePosFiscalDocument(
			newPosFiscalChain(chainId),
			doc('6f9d1d6e-3c3d-4d3f-9d4a-0d6a3a1b2c01'),
		)
		expect(first.document.counter).toBe(1)
		expect(first.document.previousHash).toBe(POS_FISCAL_GENESIS_HASH)
		const second = issuePosFiscalDocument(
			first.head,
			doc('6f9d1d6e-3c3d-4d3f-9d4a-0d6a3a1b2c02'),
		)
		expect(second.document.counter).toBe(2)
		expect(second.document.previousHash).toBe(first.document.hash)
		const { hash, ...unsigned } = second.document
		expect(posFiscalHash(unsigned)).toBe(hash)
	})

	it('changes the hash when any documented figure changes', () => {
		const { document } = issuePosFiscalDocument(
			newPosFiscalChain(chainId),
			doc('6f9d1d6e-3c3d-4d3f-9d4a-0d6a3a1b2c01'),
		)
		const { hash, ...unsigned } = document
		expect(posFiscalHash({ ...unsigned, totalCents: 1149 })).not.toBe(hash)
	})

	it('apportions tax to a refund', () => {
		expect(posRefundTaxCents({ totalCents: 1150, taxCents: 150 }, 1150)).toBe(
			150,
		)
		expect(posRefundTaxCents({ totalCents: 1150, taxCents: 150 }, 575)).toBe(75)
		expect(posRefundTaxCents({ totalCents: 0, taxCents: 0 }, 0)).toBe(0)
	})
})

describe('zatcaQrPayload', () => {
	it('encodes the five tags as TLV', () => {
		const payload = zatcaQrPayload({
			sellerName: 'Bobs Records',
			vatNumber: '310122393500003',
			at: '2022-04-25T15:30:00Z',
			totalCents: 100000,
			taxCents: 15000,
		})
		const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0))
		const fields: string[] = []
		for (let i = 0; i < bytes.length;) {
			const length = bytes[i + 1]!
			fields.push(new TextDecoder().decode(bytes.slice(i + 2, i + 2 + length)))
			i += 2 + length
		}
		expect(fields).toEqual([
			'Bobs Records',
			'310122393500003',
			'2022-04-25T15:30:00Z',
			'1000.00',
			'150.00',
		])
	})
})
