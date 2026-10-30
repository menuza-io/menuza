import { type CanvaDesign, type CanvaTokens } from './client.server.ts'
import { CanvaError } from './errors.ts'

/**
 * A stateless Canva emulator for local development and E2E (`CANVA_MOCK`,
 * ignored unless BASE_URL is local). Three designs: an A3 poster with 3 mm
 * bleed, a two-page A5 flyer without bleed, and a square social post that
 * fits no print. Exports are real (tiny) PDF and PNG files at those sizes.
 */

const MM_TO_PT = 72 / 25.4

const DESIGNS: Array<CanvaDesign & { widthMm: number; heightMm: number }> = [
	{
		id: 'MOCK-POSTER',
		title: 'Spring poster',
		pageCount: 1,
		widthMm: 303,
		heightMm: 426,
		thumbnail: null,
		editUrl: 'https://www.canva.com/design/MOCK-POSTER/edit',
	},
	{
		id: 'MOCK-FLYER',
		title: 'Weekend flyer',
		pageCount: 2,
		widthMm: 148,
		heightMm: 210,
		thumbnail: null,
		editUrl: 'https://www.canva.com/design/MOCK-FLYER/edit',
	},
	{
		id: 'MOCK-SQUARE',
		title: 'Social post',
		pageCount: 1,
		widthMm: 285.75,
		heightMm: 285.75,
		thumbnail: null,
		editUrl: 'https://www.canva.com/design/MOCK-SQUARE/edit',
	},
]

/** A 2×2 grey PNG, enough for an `<img>` and a proof. */
const PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGO4cuUGEDFAKABF/goBo97cMwAAAABJRU5ErkJggg==',
	'base64',
)

/** A minimal, valid one-page PDF of the given size. */
function pdfOfSize(widthMm: number, heightMm: number): Uint8Array<ArrayBuffer> {
	const w = (widthMm * MM_TO_PT).toFixed(2)
	const h = (heightMm * MM_TO_PT).toFixed(2)
	const objects = [
		'<< /Type /Catalog /Pages 2 0 R >>',
		'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
		`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] >>`,
	]
	let body = '%PDF-1.4\n'
	const offsets: number[] = []
	objects.forEach((object, index) => {
		offsets.push(body.length)
		body += `${index + 1} 0 obj\n${object}\nendobj\n`
	})
	const xref = body.length
	body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
	for (const offset of offsets) {
		body += `${String(offset).padStart(10, '0')} 00000 n \n`
	}
	body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
	const bytes = new Uint8Array(new ArrayBuffer(body.length))
	bytes.set(new TextEncoder().encode(body))
	return bytes
}

function find(designId: string) {
	const design = DESIGNS.find((candidate) => candidate.id === designId)
	if (!design) throw new CanvaError('not_found', 'No such design')
	return design
}

const thumbnail = () => ({
	url: `data:image/png;base64,${PNG.toString('base64')}`,
	width: 2,
	height: 2,
})

let imports = 0

export const mockCanva = {
	tokens(): CanvaTokens {
		return {
			accessToken: `mock-access-${Date.now()}`,
			refreshToken: `mock-refresh-${Date.now()}-${Math.random()}`,
			expiresAt: new Date(Date.now() + 4 * 3_600_000),
			scope:
				'design:meta:read design:content:read design:content:write profile:read',
		}
	},

	api() {
		return {
			async profile() {
				return { userId: 'mock-user', displayName: 'Mock Canva user' }
			},
			async listDesigns(input: { query?: string; continuation?: string }) {
				const query = input.query?.toLowerCase() ?? ''
				return {
					designs: DESIGNS.filter((design) =>
						design.title.toLowerCase().includes(query),
					).map(({ widthMm: _w, heightMm: _h, ...design }) => ({
						...design,
						thumbnail: thumbnail(),
					})),
					continuation: null,
				}
			},
			async getDesign(designId: string): Promise<CanvaDesign> {
				const { widthMm: _w, heightMm: _h, ...design } = find(designId)
				return { ...design, thumbnail: thumbnail() }
			},
			async exportFirstPage(
				designId: string,
				format: { type: 'pdf' | 'png' },
			): Promise<string> {
				find(designId)
				return `mock-canva://export/${designId}.${format.type}`
			},
			async importPdf(_bytes: Uint8Array<ArrayBuffer>, _title: string) {
				imports += 1
				return {
					id: `MOCK-IMPORT-${imports}`,
					editUrl: `https://www.canva.com/design/MOCK-IMPORT-${imports}/edit`,
				}
			},
		}
	},

	async download(url: string) {
		const match = url.match(/^mock-canva:\/\/export\/([\w-]+)\.(pdf|png)$/)
		if (!match) throw new CanvaError('failed', 'Not a mock Canva file')
		const design = find(match[1]!)
		return match[2] === 'pdf'
			? {
					bytes: pdfOfSize(design.widthMm, design.heightMm),
					contentType: 'application/pdf',
				}
			: {
					bytes: new Uint8Array(PNG) as Uint8Array<ArrayBuffer>,
					contentType: 'image/png',
				}
	},
}
