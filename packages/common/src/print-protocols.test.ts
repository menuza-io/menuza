import { describe, expect, it } from 'vitest'
import {
	bitmapBytes,
	encodeLatin,
	epsonPrintRequest,
	layoutBlock,
	monochromeBitmap,
	parseEpsonForm,
	parseStarPoll,
	renderEpsonXml,
	renderStarPrnt,
	starAckOk,
	starPollResponse,
	statusFromText,
} from './print-protocols.ts'
import {
	buildDrawerJob,
	buildKitchenTicket,
	buildTestTicket,
	type TicketDoc,
} from './print-ticket.ts'

const kitchen = (): TicketDoc =>
	buildKitchenTicket({
		widthMm: 80,
		ticket: {
			number: 'W-1',
			time: '14:02',
			orderType: 'pickup',
			lines: [
				{ quantity: 1, name: 'Satay', highlight: 'allergy' },
				{ quantity: 1, name: 'Burger', options: [{ name: 'No onions', highlight: 'attention' }] },
			],
		},
	})

const ascii = (bytes: Uint8Array) =>
	[...bytes].map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '·')).join('')

describe('pictures', () => {
	it('turns a logo into one colour, capped in height', () => {
		// 4x4: left half black, right half transparent.
		const data = new Uint8Array(4 * 4 * 4)
		for (let y = 0; y < 4; y++) {
			for (let x = 0; x < 4; x++) {
				const at = (y * 4 + x) * 4
				const black = x < 2
				data.set([black ? 0 : 255, black ? 0 : 255, black ? 0 : 255, black ? 255 : 0], at)
			}
		}
		const bitmap = monochromeBitmap(
			{ width: 4, height: 4, data },
			{ maxWidth: 384, maxHeight: 2 },
		)!
		expect(bitmap.height).toBeLessThanOrEqual(2)
		expect(bitmap.width).toBeLessThanOrEqual(2)
		const rows = bitmapBytes(bitmap)
		// Only the left side is ink.
		expect(rows[0]! & 0x80).toBe(0x80)
		// A picture with no ink prints nothing.
		expect(
			monochromeBitmap(
				{ width: 1, height: 1, data: [255, 255, 255, 255] },
				{ maxWidth: 10, maxHeight: 10 },
			),
		).toBeNull()
	})
})

describe('text for a printer\'s own font', () => {
	it('drops accents and replaces what it cannot print', () => {
		expect(ascii(encodeLatin('Café crème'))).toBe('Cafe creme')
		expect(ascii(encodeLatin('شاورما'))).toBe('??????')
	})

	it('lays rows out to the paper width and boxes marked lines', () => {
		const lines = layoutBlock({ t: 'row', left: '2x Burger', right: '$23.00' }, 32)
		expect(lines[0]).toHaveLength(32)
		expect(lines[0]!.startsWith('2x Burger')).toBe(true)
		expect(lines[0]!.endsWith('$23.00')).toBe(true)
		const boxed = layoutBlock({ t: 'text', text: 'CHECK ID', boxed: true }, 32)
		expect(boxed[0]).toMatch(/^\+-+\+$/)
		expect(boxed[1]).toContain('CHECK ID')
	})
})

describe('Star CloudPRNT', () => {
	it('answers a poll with a job or with nothing', () => {
		expect(starPollResponse(null)).toEqual({ jobReady: false })
		expect(starPollResponse({ id: 'job-1' })).toEqual({
			jobReady: true,
			mediaTypes: ['application/vnd.star.starprntcore'],
			jobToken: 'job-1',
		})
	})

	it('reads the printer status from the poll body', () => {
		expect(parseStarPoll({ statusCode: '200 OK' }).status).toBe('ok')
		expect(parseStarPoll({ statusCode: '211 Paper Empty' }).status).toBe('out_of_paper')
		expect(parseStarPoll({ statusCode: '201 Cover Open' }).status).toBe('cover_open')
		expect(parseStarPoll({ statusCode: '510 Printer Error' }).status).toBe('error')
		expect(parseStarPoll(null).status).toBe('unknown')
	})

	it('reads the acknowledgement', () => {
		expect(starAckOk('200 OK')).toBe(true)
		expect(starAckOk('ok')).toBe(true)
		expect(starAckOk('520')).toBe(false)
		expect(starAckOk('')).toBe(false)
	})

	it('encodes a kitchen ticket as Star line mode: init, text, bold, invert, cut', () => {
		const bytes = renderStarPrnt(kitchen())
		expect([...bytes.slice(0, 2)]).toEqual([0x1b, 0x40])
		const text = ascii(bytes)
		expect(text).toContain('KITCHEN TICKET')
		expect(text).toContain('ALLERGY: 1x Satay')
		expect(text).toContain('| ATTENTION: + No onions')
		// Allergy line is inverse (ESC 4 ... ESC 5), the ticket ends with a cut.
		expect(bytes.join(',')).toContain('27,52')
		expect(bytes.join(',')).toContain('27,53')
		expect([...bytes.slice(-3)]).toEqual([0x1b, 0x64, 0x03])
	})

	it('prints copies and opens the drawer once', () => {
		const doc = { ...buildTestTicket({ printerName: 'A', locationName: 'B', widthMm: 58, time: 't', drawer: true }), copies: 2 }
		const bytes = renderStarPrnt(doc)
		expect(ascii(bytes).split('TEST PRINT').length - 1).toBe(2)
		expect([...bytes].filter((b) => b === 0x07)).toHaveLength(1)
		expect([...renderStarPrnt(buildDrawerJob(80))]).toEqual([0x1b, 0x40, 0x07])
	})
})

describe('Epson Server Direct Print', () => {
	it('encodes a kitchen ticket as ePOS-Print XML, escaped', () => {
		const xml = renderEpsonXml(
			buildKitchenTicket({
				widthMm: 80,
				ticket: {
					number: 'W-1',
					time: '14:02',
					orderType: 'pickup',
					lines: [{ quantity: 1, name: 'Fish <& chips>' }],
				},
			}),
		)
		expect(xml).toContain('<epos-print')
		expect(xml).toContain('Fish &lt;&amp; chips&gt;')
		expect(xml).toContain('<cut type="feed"/>')
		expect(renderEpsonXml(buildDrawerJob(80))).toContain('<pulse drawer="drawer_1"')
	})

	it('wraps the print data in a request and reads the form exchanges', () => {
		const request = epsonPrintRequest({ jobId: 'abc', eposXml: '<epos-print/>' })
		expect(request).toContain('<printjobid>abc</printjobid>')
		expect(request).toContain('<PrintData><epos-print/></PrintData>')
		expect(
			parseEpsonForm(new URLSearchParams('ConnectionType=GetRequest&ID=p1&Name=Bar')),
		).toMatchObject({ kind: 'get', deviceName: 'Bar' })
		const done = parseEpsonForm(
			new URLSearchParams({
				ConnectionType: 'SetResponse',
				ResponseFile:
					'<PrintResponseInfo><ePOSPrint><PrintResponse><response success="true" code="" status="1"/><printjobid>abc</printjobid></PrintResponse></ePOSPrint></PrintResponseInfo>',
			}),
		)
		expect(done).toMatchObject({ kind: 'result', jobId: 'abc', success: true })
		const failed = parseEpsonForm(
			new URLSearchParams({
				ConnectionType: 'SetResponse',
				ResponseFile:
					'<response success="false" code="EPTR_COVER_OPEN"/><printjobid>abc</printjobid>',
			}),
		)
		expect(failed).toMatchObject({ success: false, report: { status: 'cover_open' } })
		expect(parseEpsonForm(new URLSearchParams('ConnectionType=Other'))).toBeNull()
		expect(statusFromText('EPTR_PTR_END')).toBe('out_of_paper')
	})
})
