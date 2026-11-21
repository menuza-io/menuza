import { describe, expect, it, vi } from 'vitest'
import {
	detectUploadedSourceFile,
	extractMenuFromSource,
} from './extract.server.ts'

async function buildMinimalXlsx(
	files: Record<string, string>,
): Promise<Uint8Array<ArrayBuffer>> {
	// Builds a valid ZIP (stored method 0) for XLSX unit testing without deps.
	const encoder = new TextEncoder()
	const localChunks: Uint8Array[] = []
	const centralChunks: Uint8Array[] = []
	let offset = 0

	const u16 = (v: number) => [v & 0xff, (v >> 8) & 0xff]
	const u32 = (v: number) => [
		v & 0xff,
		(v >> 8) & 0xff,
		(v >> 16) & 0xff,
		(v >> 24) & 0xff,
	]

	const entries = Object.entries(files)
	for (const [name, content] of entries) {
		const nameBytes = encoder.encode(name)
		const dataBytes = encoder.encode(content)
		const localHeader = new Uint8Array([
			0x50,
			0x4b,
			0x03,
			0x04,
			...u16(20),
			...u16(0),
			...u16(0),
			...u16(0),
			...u16(0),
			...u32(0),
			...u32(dataBytes.length),
			...u32(dataBytes.length),
			...u16(nameBytes.length),
			...u16(0),
		])
		localChunks.push(localHeader, nameBytes, dataBytes)

		const centralHeader = new Uint8Array([
			0x50,
			0x4b,
			0x01,
			0x02,
			...u16(20),
			...u16(20),
			...u16(0),
			...u16(0),
			...u16(0),
			...u16(0),
			...u32(0),
			...u32(dataBytes.length),
			...u32(dataBytes.length),
			...u16(nameBytes.length),
			...u16(0),
			...u16(0),
			...u16(0),
			...u16(0),
			...u32(0),
			...u32(offset),
		])
		centralChunks.push(centralHeader, nameBytes)
		offset += localHeader.length + nameBytes.length + dataBytes.length
	}

	const centralSize = centralChunks.reduce((sum, c) => sum + c.length, 0)
	const eocd = new Uint8Array([
		0x50,
		0x4b,
		0x05,
		0x06,
		...u16(0),
		...u16(0),
		...u16(entries.length),
		...u16(entries.length),
		...u32(centralSize),
		...u32(offset),
		...u16(0),
	])

	const all = [...localChunks, ...centralChunks, eocd]
	const total = all.reduce((sum, c) => sum + c.length, 0)
	const out = new Uint8Array(total)
	let pos = 0
	for (const chunk of all) {
		out.set(chunk, pos)
		pos += chunk.length
	}
	return out
}

describe('menu import extraction (#73)', () => {
	it('extracts a review tree from a public HTML menu URL and keeps images as suggestions only', async () => {
		const generator = vi.fn().mockResolvedValue({
			detectedCurrency: 'USD',
			detectedLocales: ['en'],
			menus: [
				{
					name: { en: 'Dinner Menu' },
					categories: [
						{
							name: { en: 'Pastas' },
							items: [
								{
									name: { en: 'Truffle Pasta' },
									description: { en: 'Fresh tagliatelle with truffle butter.' },
									price: 22,
								},
							],
						},
					],
				},
			],
		})

		const result = await extractMenuFromSource(
			{
				sourceKind: 'url',
				fetched: {
					ok: true,
					kind: 'html',
					finalUrl: 'https://bistro.example.com/menu',
					contentType: 'text/html',
					html: '<html><body><h1>Pastas</h1><p>Truffle Pasta $22</p><img src="https://bistro.example.com/pasta.jpg" alt="Pasta" /></body></html>',
					byteLength: 120,
				},
				siteLocales: '["en"]',
				siteDefaultLocale: 'en',
			},
			{ generator },
		)

		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(generator).toHaveBeenCalledTimes(1)
		const call = generator.mock.calls[0]![0]
		// Only menu text sent to model; no org/member PII
		expect(call.prompt).toContain('Truffle Pasta $22')
		expect(call.files).toBeUndefined()
		expect(result.draft.menus[0]!.categories[0]!.items[0]!.price).toBe(22)
		expect(result.draft.imageSuggestions).toEqual([
			{ url: 'https://bistro.example.com/pasta.jpg', alt: 'Pasta' },
		])
	})

	it('extracts a review tree from a PDF upload and a phone photo (JPEG/PNG/WebP)', async () => {
		const sampleModelOutput = {
			detectedCurrency: 'SAR',
			detectedLocales: ['en', 'ar'],
			menus: [
				{
					name: { en: 'All Day', ar: 'طوال اليوم' },
					categories: [
						{
							name: { en: 'Coffee', ar: 'القهوة' },
							items: [
								{
									name: { en: 'Spanish Latte', ar: 'سبانش لاتيه' },
									price: 24,
									sizes: [
										{ name: { en: 'Regular', ar: 'عادي' }, price: 24 },
										{ name: { en: 'Large', ar: 'كبير' }, price: 29 },
									],
								},
							],
						},
					],
				},
			],
		}

		const pdfBytes = new TextEncoder().encode('%PDF-1.4\n1 0 obj\n%%EOF')
		expect(
			detectUploadedSourceFile(pdfBytes, 'menu.pdf', 'application/pdf'),
		).toMatchObject({
			ok: true,
			sourceKind: 'pdf',
		})

		const pdfGenerator = vi.fn().mockResolvedValue(sampleModelOutput)
		const pdfRes = await extractMenuFromSource(
			{
				sourceKind: 'pdf',
				bytes: pdfBytes,
				filename: 'menu.pdf',
				contentType: 'application/pdf',
				siteLocales: '["en","ar"]',
				siteDefaultLocale: 'en',
			},
			{ generator: pdfGenerator },
		)
		expect(pdfRes.ok).toBe(true)
		expect(pdfGenerator.mock.calls[0]![0].files?.[0]?.mediaType).toBe(
			'application/pdf',
		)

		// Phone photo (JPEG magic bytes)
		const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])
		expect(
			detectUploadedSourceFile(jpegBytes, 'photo.jpg', 'image/jpeg'),
		).toMatchObject({
			ok: true,
			sourceKind: 'image',
			contentType: 'image/jpeg',
		})

		const photoGenerator = vi.fn().mockResolvedValue(sampleModelOutput)
		const photoRes = await extractMenuFromSource(
			{
				sourceKind: 'image',
				bytes: jpegBytes,
				filename: 'photo.jpg',
				contentType: 'image/jpeg',
				siteLocales: '["en"]',
				siteDefaultLocale: 'en',
			},
			{ generator: photoGenerator },
		)
		expect(photoRes.ok).toBe(true)
		if (!photoRes.ok) return
		expect(photoGenerator.mock.calls[0]![0].files?.[0]?.mediaType).toBe(
			'image/jpeg',
		)
		// Org only has 'en', so 'ar' is stripped from draft
		expect(photoRes.draft.menus[0]!.categories[0]!.items[0]!.name).toEqual({
			en: 'Spanish Latte',
		})
	})

	it('parses CSV and XLSX spreadsheets locally and strips allergen/calorie columns', async () => {
		const csv = [
			'category,name_en,name_ar,price,allergens,calories,currency',
			'Grills,Chicken Tawook,شيش طاووق,38,dairy,540,SAR',
			'Grills,Mystery Dish,,abc,nuts,200,SAR',
		].join('\n')

		const csvBytes = new TextEncoder().encode(csv)
		const csvRes = await extractMenuFromSource({
			sourceKind: 'spreadsheet',
			bytes: csvBytes,
			filename: 'menu.csv',
			contentType: 'text/csv',
			siteLocales: '["en","ar"]',
			siteDefaultLocale: 'en',
		})

		expect(csvRes.ok).toBe(true)
		if (!csvRes.ok) return
		expect(csvRes.draft.detectedCurrency).toBe('SAR')
		const items = csvRes.draft.menus[0]!.categories[0]!.items
		expect(items).toHaveLength(2)
		expect(items[0]!.name).toEqual({ en: 'Chicken Tawook', ar: 'شيش طاووق' })
		expect(items[0]!.price).toBe(38)
		expect('allergens' in items[0]!).toBe(false)
		expect('calories' in items[0]!).toBe(false)
		// Unreadable price flagged low confidence
		expect(items[1]!.confidence).toBe('low')
		expect(items[1]!.lowConfidenceFields).toEqual(['price'])

		// XLSX archive
		const xlsxBytes = await buildMinimalXlsx({
			'xl/sharedStrings.xml':
				'<sst><si><t>Category</t></si><si><t>Dish</t></si><si><t>Price</t></si><si><t>Desserts</t></si><si><t>Kunafa</t></si></sst>',
			'xl/worksheets/sheet1.xml':
				'<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row><row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2" t="s"><v>4</v></c><c r="C2"><v>26</v></c></row></sheetData></worksheet>',
		})

		const xlsxRes = await extractMenuFromSource({
			sourceKind: 'spreadsheet',
			bytes: xlsxBytes,
			filename: 'menu.xlsx',
			contentType:
				'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
			siteLocales: '["en"]',
			siteDefaultLocale: 'en',
		})
		expect(xlsxRes.ok).toBe(true)
		if (!xlsxRes.ok) return
		expect(xlsxRes.draft.menus[0]!.categories[0]!.name).toEqual({
			en: 'Desserts',
		})
		expect(xlsxRes.draft.menus[0]!.categories[0]!.items[0]!.name).toEqual({
			en: 'Kunafa',
		})
		expect(xlsxRes.draft.menus[0]!.categories[0]!.items[0]!.price).toBe(26)
	})

	it('returns nothing_found when extraction yields zero dishes and model_invalid on malformed output', async () => {
		const emptyRes = await extractMenuFromSource(
			{
				sourceKind: 'url',
				fetched: {
					ok: true,
					kind: 'html',
					finalUrl: 'https://example.com',
					contentType: 'text/html',
					html: '<html><body><p>Welcome to our restaurant, call us!</p></body></html>',
					byteLength: 60,
				},
				siteLocales: '["en"]',
				siteDefaultLocale: 'en',
			},
			{
				generator: async () => ({
					detectedCurrency: null,
					detectedLocales: ['en'],
					menus: [],
				}),
			},
		)
		expect(emptyRes.ok).toBe(false)
		if (!emptyRes.ok) expect(emptyRes.error).toBe('nothing_found')

		const badRes = await extractMenuFromSource(
			{
				sourceKind: 'pdf',
				bytes: new TextEncoder().encode('%PDF-1.4\n%%EOF'),
				filename: 'menu.pdf',
				contentType: 'application/pdf',
				siteLocales: '["en"]',
				siteDefaultLocale: 'en',
			},
			{
				generator: async () => ({
					menus: [
						{
							name: { en: 'Main' },
							categories: [
								{
									name: { en: 'Starters' },
									items: [
										{
											name: { en: 'Soup' },
											price: -99,
											allergens: ['milk'],
										},
									],
								},
							],
						},
					],
				}),
			},
		)
		expect(badRes.ok).toBe(false)
		if (!badRes.ok) expect(badRes.error).toBe('model_invalid')
	})

	it('refuses unsupported files by magic bytes even if extension is spoofed', () => {
		const exeBytes = new Uint8Array([0x4d, 0x5a, 0x90, 0x00]) // PE/EXE header
		expect(
			detectUploadedSourceFile(exeBytes, 'menu.pdf', 'application/pdf').ok,
		).toBe(false)
		expect(
			detectUploadedSourceFile(exeBytes, 'photo.jpg', 'image/jpeg').ok,
		).toBe(false)
	})
})
