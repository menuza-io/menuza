import { describe, expect, it } from 'vitest'
import {
	cleanGoogleReviewUrl,
	codeCapacity,
	compactReceiptExtras,
	DEFAULT_APP_CAPTION,
	DEFAULT_RECEIPT_EXTRAS,
	DEFAULT_REVIEW_CAPTION,
	planReceiptExtras,
	readReceiptExtras,
	type ReceiptExtrasConfig,
} from './receipt-extras.ts'
import { compactTickets, resolveTickets } from './ticket-config.ts'

const on: ReceiptExtrasConfig = {
	logo: true,
	review: { show: true, caption: null },
	app: { show: true, caption: 'Get the app' },
}
const targets = {
	reviewUrl: 'https://g.page/r/abc/review',
	appUrl: 'https://site.test/get-app?p=print',
}
const plan = (over: Partial<Parameters<typeof planReceiptExtras>[0]> = {}) =>
	planReceiptExtras({
		config: on,
		targets,
		logoUrl: 'https://app.test/logo.png',
		width: 80,
		fiscalQr: false,
		...over,
	})

describe('what a receipt shows besides the sale (#263)', () => {
	it('shows the logo and both codes with their captions when switched on', () => {
		const result = plan()
		expect(result.logo).toBe(true)
		expect(result.codes).toEqual([
			{ kind: 'review', url: targets.reviewUrl, caption: DEFAULT_REVIEW_CAPTION },
			{ kind: 'app', url: targets.appUrl, caption: 'Get the app' },
		])
		expect(result.dropped).toBeNull()
		expect(DEFAULT_APP_CAPTION).toBe('Order ahead next time')
	})

	it('prints nothing when nothing is switched on', () => {
		expect(plan({ config: DEFAULT_RECEIPT_EXTRAS })).toEqual({
			logo: false,
			codes: [],
			dropped: null,
		})
	})

	it('offers a code only when its target exists: no review link, no review code', () => {
		const result = plan({ targets: { reviewUrl: null, appUrl: targets.appUrl } })
		expect(result.codes.map((c) => c.kind)).toEqual(['app'])
		expect(
			plan({ targets: { reviewUrl: null, appUrl: null } }).codes,
		).toEqual([])
	})

	it('shows no logo when the organization has none', () => {
		expect(plan({ logoUrl: null }).logo).toBe(false)
	})

	it('drops the marketing codes, never the fiscal one, when a narrow roll cannot fit both', () => {
		expect(codeCapacity(58, true)).toBe(0)
		const result = plan({ width: 58, fiscalQr: true })
		expect(result.codes).toEqual([])
		expect(result.dropped).toBe('paper_width')
		// The same roll without a fiscal code has room.
		expect(plan({ width: 58, fiscalQr: false }).codes).toHaveLength(2)
		// A wider roll fits the fiscal code and the marketing codes below it.
		expect(plan({ width: 80, fiscalQr: true }).codes).toHaveLength(2)
		expect(plan({ width: 72, fiscalQr: true }).codes).toHaveLength(2)
	})

	it('never puts marketing on a refund or void slip', () => {
		for (const kind of ['refund', 'void'] as const) {
			const result = plan({ kind })
			expect(result.logo).toBe(false)
			expect(result.codes).toEqual([])
			expect(result.dropped).toBe('refund_or_void')
		}
	})

	it('reads stored settings defensively and stores only what differs', () => {
		expect(readReceiptExtras(null)).toEqual(DEFAULT_RECEIPT_EXTRAS)
		expect(readReceiptExtras({ logo: 'yes', review: 5 })).toEqual(
			DEFAULT_RECEIPT_EXTRAS,
		)
		expect(compactReceiptExtras(DEFAULT_RECEIPT_EXTRAS)).toBeUndefined()
		const longCaption = 'x'.repeat(200)
		const read = readReceiptExtras({
			app: { show: true, caption: `  ${longCaption}\n` },
		})
		expect(read.app.caption).toHaveLength(60)
	})

	it('rides in the location ticket settings and survives a save', () => {
		const resolved = resolveTickets({ extras: { logo: true } })
		expect(resolved.extras.logo).toBe(true)
		expect(resolveTickets(null).extras).toEqual(DEFAULT_RECEIPT_EXTRAS)
		expect(compactTickets(resolved.raw).extras).toEqual({ logo: true })
		expect(compactTickets(resolveTickets({}).raw).extras).toBeUndefined()
	})
})

describe('the Google review link', () => {
	it('accepts an https Google review address and refuses the rest', () => {
		expect(cleanGoogleReviewUrl(' https://g.page/r/abc/review ')).toBe(
			'https://g.page/r/abc/review',
		)
		expect(
			cleanGoogleReviewUrl(
				'https://search.google.com/local/writereview?placeid=ChIJ123',
			),
		).toContain('writereview')
		expect(cleanGoogleReviewUrl('http://g.page/r/abc')).toBeNull()
		expect(cleanGoogleReviewUrl('https://evil.example/review')).toBeNull()
		expect(cleanGoogleReviewUrl('https://google.com.evil.test/x')).toBeNull()
		expect(cleanGoogleReviewUrl('javascript:alert(1)')).toBeNull()
		expect(cleanGoogleReviewUrl('')).toBeNull()
	})
})
