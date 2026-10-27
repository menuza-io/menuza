import { type PrintSnapshot } from '@repo/common/print-shop'
import { describe, expect, it } from 'vitest'
import { printDocumentCsp, renderPrintHtml } from './print-document.server.tsx'

function snapshot(overrides: Partial<PrintSnapshot> = {}): PrintSnapshot {
	return {
		product: 'table_card',
		sizeKey: 'a6',
		style: 'classic',
		templateVersion: 1,
		brand: {
			name: 'Bistro <script>alert(1)</script>',
			logoDataUri: null,
			background: '#ffffff',
			foreground: '#111111',
			muted: '#666666',
			primary: '#123456',
			primaryForeground: '#ffffff',
			accent: '#eeeeee',
			accentForeground: '#111111',
			headingFont: '"Inter", sans-serif',
			bodyFont: '"Inter", sans-serif',
		},
		copy: [
			{
				locale: 'en',
				dir: 'ltr',
				headline: 'Scan to order',
				body: '',
				callToAction: 'Order and pay from your phone',
				qrCaption: 'Scan to order',
				pieceWord: 'Table',
			},
			{
				locale: 'ar',
				dir: 'rtl',
				headline: 'امسح للطلب',
				body: '',
				callToAction: 'اطلب وادفع من هاتفك',
				qrCaption: 'امسح للطلب',
				pieceWord: 'طاولة',
			},
		],
		featured: [],
		address: '1 Main Street',
		website: 'bistro.example.com',
		pieces: Array.from({ length: 5 }, (_, index) => ({
			label: `T${index + 1}`,
			qrUrl: `https://bistro.example.com/menu?location=l#table=t${index}`,
		})),
		qr: { kind: 'table', tableIds: ['all'] },
		facts: { featured: [], pieces: [] },
		...overrides,
	}
}

const svg = '<svg viewBox="0 0 1 1"><path d="M0 0h1v1H0z"/></svg>'

describe('print documents', () => {
	it('makes one page per piece with bleed for print shops', () => {
		const html = renderPrintHtml({
			snapshot: snapshot(),
			format: 'pro',
			bleedMm: 3,
			qrSvgs: Array(5).fill(svg),
		})
		expect(html).toContain('@page { size: 111mm 154mm')
		expect(html.match(/class="sheet"/g)).toHaveLength(5)
		expect(html.match(/<svg/g)).toHaveLength(5)
		expect(html).not.toContain('class="crop')
		expect(html).not.toContain('<script')
	})

	it('tiles cards on a home sheet with crop marks and no bleed', () => {
		const html = renderPrintHtml({
			snapshot: snapshot(),
			format: 'home',
			homeSheet: 'letter',
			qrSvgs: Array(5).fill(svg),
		})
		expect(html).toContain('@page { size: 216mm 279mm')
		// Every card gets a slot (with four crop corners) on some sheet.
		const sheets = html.match(/class="sheet"/g)?.length ?? 0
		const slots = html.match(/class="slot"/g)?.length ?? 0
		expect(slots).toBe(5)
		expect(sheets).toBeGreaterThanOrEqual(1)
		expect(html.match(/class="crop crop-h"/g)).toHaveLength(slots * 4)
		expect(html).toContain('--bleed: 0mm')
	})

	it('prints both languages with their own direction', () => {
		const html = renderPrintHtml({
			snapshot: snapshot(),
			format: 'pro',
			qrSvgs: Array(5).fill(svg),
		})
		expect(html).toContain('lang="ar" dir="rtl"')
		expect(html).toContain('طاولة T1')
		expect(html).toContain('Table T1')
	})

	it('escapes the organization name and limits the proof', () => {
		const html = renderPrintHtml({
			snapshot: snapshot(),
			format: 'proof',
			qrSvgs: Array(5).fill(svg),
			proofLimit: 2,
		})
		expect(html).not.toContain('<script>alert(1)</script>')
		expect(html.match(/class="sheet"/g)).toHaveLength(2)
	})

	it('scales a poster onto one home sheet and folds a tent', () => {
		const poster = renderPrintHtml({
			snapshot: snapshot({
				product: 'poster',
				sizeKey: 'a2',
				pieces: [{ label: null, qrUrl: 'https://x.example/menu' }],
			}),
			format: 'home',
			homeSheet: 'a4',
			qrSvgs: [svg],
		})
		expect(poster).toContain('class="fit"')
		const tent = renderPrintHtml({
			snapshot: snapshot({ product: 'table_tent', sizeKey: '4x6' }),
			format: 'pro',
			qrSvgs: Array(5).fill(svg),
		})
		expect(tent).toContain('@page { size: 108mm 310mm')
		expect(tent).toContain('tent-back')
	})

	it('only runs the nonce’d auto-print script', () => {
		const html = renderPrintHtml({
			snapshot: snapshot(),
			format: 'home',
			qrSvgs: Array(5).fill(svg),
			autoPrint: true,
			nonce: 'abc123',
		})
		expect(html).toContain('<script nonce="abc123">')
		expect(printDocumentCsp('abc123')).toContain("script-src 'nonce-abc123'")
		expect(printDocumentCsp()).toContain("script-src 'none'")
		expect(printDocumentCsp()).toContain("frame-ancestors 'self'")
	})
})
