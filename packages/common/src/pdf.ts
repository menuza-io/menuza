/**
 * Zero-dependency, Workers-safe `%PDF-1.4` builder for tabular exports (#507).
 * Uses Type1 Helvetica/Helvetica-Bold with exact byte-offset xref tables.
 */

export type PdfLine = {
	text: string
	bold?: boolean
	size?: number
}

function pdfLiteral(text: string): string {
	let out = ''
	for (const ch of text) {
		const code = ch.codePointAt(0) ?? 32
		if (ch === '\\' || ch === '(' || ch === ')') {
			out += `\\${ch}`
		} else if (code >= 0x20 && code <= 0x7e) {
			out += ch
		} else if (code >= 0xa0 && code <= 0xff) {
			out += `\\${code.toString(8).padStart(3, '0')}`
		} else {
			out += '?'
		}
	}
	return `(${out})`
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
	const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
	const output = new Uint8Array(total)
	let offset = 0
	for (const chunk of chunks) {
		output.set(chunk, offset)
		offset += chunk.byteLength
	}
	return output
}

/**
 * Renders an ordered list of text lines onto one or more landscape A4 PDF pages.
 */
export function buildTextLinesPdf(lines: readonly PdfLine[]): Uint8Array {
	const pageWidth = 842
	const pageHeight = 595
	const marginLeft = 36
	const startY = pageHeight - 44
	const bottomY = 36
	const defaultSize = 9

	const pages: PdfLine[][] = [[]]
	let y = startY
	for (const line of lines) {
		const size = line.size ?? defaultSize
		const step = Math.round(size * 1.45)
		if (y - step < bottomY && pages[pages.length - 1]!.length > 0) {
			pages.push([])
			y = startY
		}
		pages[pages.length - 1]!.push(line)
		y -= step
	}

	const encoder = new TextEncoder()
	const chunks: Uint8Array[] = []
	const offsets = new Map<number, number>()
	let cursor = 0

	function write(data: string | Uint8Array, objId?: number) {
		const bytes = typeof data === 'string' ? encoder.encode(data) : data
		if (objId !== undefined) offsets.set(objId, cursor)
		chunks.push(bytes)
		cursor += bytes.byteLength
	}

	// Object IDs: 1 = Catalog, 2 = Pages, 3 = F1 (Helvetica), 4 = F2 (Helvetica-Bold),
	// then for each page i: (5 + i*2) = Page, (6 + i*2) = Content stream.
	const pageObjIds = pages.map((_, i) => 5 + i * 2)
	const totalObjs = 4 + pages.length * 2

	write('%PDF-1.4\n')
	write('1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n', 1)
	write(
		`2 0 obj << /Type /Pages /Kids [${pageObjIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >> endobj\n`,
		2,
	)
	write(
		'3 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >> endobj\n',
		3,
	)
	write(
		'4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >> endobj\n',
		4,
	)

	pages.forEach((pageLines, i) => {
		const pageId = 5 + i * 2
		const contentId = pageId + 1
		let stream = 'BT\n'
		let curY = startY
		for (const line of pageLines) {
			const size = line.size ?? defaultSize
			const step = Math.round(size * 1.45)
			const font = line.bold ? '/F2' : '/F1'
			stream += `${font} ${size} Tf\n1 0 0 1 ${marginLeft} ${curY} Tm\n${pdfLiteral(line.text)} Tj\n`
			curY -= step
		}
		stream += 'ET\n'
		const streamBytes = encoder.encode(stream)

		write(
			`${pageId} 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId} 0 R >> endobj\n`,
			pageId,
		)
		write(
			`${contentId} 0 obj << /Length ${streamBytes.byteLength} >>\nstream\n`,
			contentId,
		)
		write(streamBytes)
		write('endstream\nendobj\n')
	})

	const xrefStart = cursor
	const pad = (value: number) => value.toString().padStart(10, '0')
	let xref = `xref\n0 ${totalObjs + 1}\n0000000000 65535 f \n`
	for (let id = 1; id <= totalObjs; id += 1) {
		xref += `${pad(offsets.get(id) ?? 0)} 00000 n \n`
	}
	xref += `trailer << /Size ${totalObjs + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`
	write(xref)
	return concatBytes(chunks)
}
