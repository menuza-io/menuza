import { describe, expect, it } from 'vitest'
import { parseXlsxToRows } from './xlsx.ts'

function writeUint16(buf: number[], value: number) {
	buf.push(value & 0xff, (value >>> 8) & 0xff)
}

function writeUint32(buf: number[], value: number) {
	buf.push(
		value & 0xff,
		(value >>> 8) & 0xff,
		(value >>> 16) & 0xff,
		(value >>> 24) & 0xff,
	)
}

function buildStoredZip(
	files: Array<{ name: string; content: string }>,
): Uint8Array {
	const encoder = new TextEncoder()
	const body: number[] = []
	const central: number[] = []

	for (const file of files) {
		const nameBytes = encoder.encode(file.name)
		const dataBytes = encoder.encode(file.content)
		const localOffset = body.length

		writeUint32(body, 0x04034b50)
		writeUint16(body, 20)
		writeUint16(body, 0)
		writeUint16(body, 0)
		writeUint16(body, 0)
		writeUint16(body, 0)
		writeUint32(body, 0)
		writeUint32(body, dataBytes.length)
		writeUint32(body, dataBytes.length)
		writeUint16(body, nameBytes.length)
		writeUint16(body, 0)
		for (const b of nameBytes) body.push(b)
		for (const b of dataBytes) body.push(b)

		writeUint32(central, 0x02014b50)
		writeUint16(central, 20)
		writeUint16(central, 20)
		writeUint16(central, 0)
		writeUint16(central, 0)
		writeUint16(central, 0)
		writeUint16(central, 0)
		writeUint32(central, 0)
		writeUint32(central, dataBytes.length)
		writeUint32(central, dataBytes.length)
		writeUint16(central, nameBytes.length)
		writeUint16(central, 0)
		writeUint16(central, 0)
		writeUint16(central, 0)
		writeUint16(central, 0)
		writeUint32(central, 0)
		writeUint32(central, localOffset)
		for (const b of nameBytes) central.push(b)
	}

	const centralOffset = body.length
	const all = [...body, ...central]
	writeUint32(all, 0x06054b50)
	writeUint16(all, 0)
	writeUint16(all, 0)
	writeUint16(all, files.length)
	writeUint16(all, files.length)
	writeUint32(all, central.length)
	writeUint32(all, centralOffset)
	writeUint16(all, 0)
	return new Uint8Array(all)
}

describe('parseXlsxToRows (#505, #506)', () => {
	it('parses shared strings, inline strings, numeric precision, self-closing cells, and ignores <col> tags', async () => {
		const zip = buildStoredZip([
			{
				name: 'xl/sharedStrings.xml',
				content:
					'<sst><si><t>Item</t></si><si><t>Price</t></si><si><t>Saffron</t></si></sst>',
			},
			{
				name: 'xl/worksheets/sheet1.xml',
				content:
					'<worksheet><cols><col min="1" max="1" width="12"/></cols><sheetData>' +
					'<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
					'<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" t="n"><v>0.125</v></c></row>' +
					'<row r="3"><c r="A3" t="inlineStr"><is><t>Mint</t></is></c><c r="B3"/><c r="C3" t="n"><v>4.125</v></c></row>' +
					'</sheetData></worksheet>',
			},
		])

		const rows = await parseXlsxToRows(zip)
		expect(rows).toEqual([
			['Item', 'Price'],
			['Saffron', '0.125'],
			['Mint', '', '4.125'],
		])
	})

	it('scans malformed XML with 50k unclosed tags in linear time without backtracking hang', async () => {
		const hostile =
			'<worksheet><sheetData>' +
			'<row><c><si><t>'.repeat(50_000) +
			'</sheetData></worksheet>'
		const zip = buildStoredZip([
			{
				name: 'xl/sharedStrings.xml',
				content: '<sst>' + '<si><t>'.repeat(20_000),
			},
			{ name: 'xl/worksheets/sheet1.xml', content: hostile },
		])

		const started = Date.now()
		const rows = await parseXlsxToRows(zip)
		expect(rows).toEqual([])
		expect(Date.now() - started).toBeLessThan(500)
	})
})
