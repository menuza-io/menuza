/**
 * Shared browser file helpers for price-list imports (#505), setup invoice
 * batches (#506), and invoice line reading (#504).
 */

export function inferUploadContentType(file: File): string {
	if (file.type && file.type.trim() !== '') return file.type
	const lower = file.name.toLowerCase()
	if (lower.endsWith('.csv')) return 'text/csv'
	if (lower.endsWith('.tsv')) return 'text/tab-separated-values'
	if (lower.endsWith('.xlsx')) {
		return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
	}
	if (lower.endsWith('.pdf')) return 'application/pdf'
	if (lower.endsWith('.png')) return 'image/png'
	if (lower.endsWith('.webp')) return 'image/webp'
	if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
	return 'application/octet-stream'
}

export async function fileToBase64(file: File): Promise<string> {
	const buffer = await file.arrayBuffer()
	const bytes = new Uint8Array(buffer)
	const chunkSize = 0x8000
	let binary = ''
	for (let i = 0; i < bytes.length; i += chunkSize) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
	}
	return btoa(binary)
}

export function triggerBlobDownload(blob: Blob, filename: string): void {
	const url = URL.createObjectURL(blob)
	try {
		const link = document.createElement('a')
		link.href = url
		link.download = filename
		link.rel = 'noopener'
		document.body.appendChild(link)
		link.click()
		link.remove()
	} finally {
		setTimeout(() => URL.revokeObjectURL(url), 0)
	}
}
