import { type LabelData } from '@repo/inventory'

/** The words on a label, in the tablet's language (Lingui strings from the screen). */
export type LabelWords = {
	made: string
	opened: string
	useBy: string
	madeBy: string
	quantity: string
}

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;')
}

/**
 * A 2 inch (50 mm) label as a standalone page (#523), for the browser's print
 * dialog when no cloud label printer took the job. Plain text only, escaped,
 * monochrome: the Arabic name sits under the English one and flips to RTL on
 * its own line. Nothing here is sent anywhere.
 */
export function labelHtml(label: LabelData, words: LabelWords): string {
	const row = (name: string, value: string, strong = false) =>
		`<div class="row${strong ? ' strong' : ''}"><span>${escapeHtml(name)}</span><bdi dir="ltr">${escapeHtml(value)}</bdi></div>`
	const rows = [
		row(label.kind === 'opened' ? words.opened : words.made, label.madeAtLabel),
		label.useByLabel ? row(words.useBy, label.useByLabel, true) : '',
		label.madeBy ? row(words.madeBy, label.madeBy) : '',
		label.quantityLabel ? row(words.quantity, label.quantityLabel) : '',
	].join('')
	return `<!doctype html><html><head><meta charset="utf-8"><style>
@page { size: 50mm auto; margin: 2mm; }
body { margin: 0; font-family: sans-serif; color: #000; background: #fff; width: 46mm; }
.name { font-size: 15pt; font-weight: 700; overflow-wrap: anywhere; }
.name-ar { font-size: 15pt; font-weight: 700; direction: rtl; text-align: right; overflow-wrap: anywhere; }
.row { display: flex; justify-content: space-between; gap: 2mm; font-size: 10pt; margin-top: 1mm; }
.strong { font-weight: 700; font-size: 12pt; }
.note { font-size: 9pt; margin-top: 1mm; overflow-wrap: anywhere; }
.page { page-break-after: always; break-after: page; }
</style></head><body>${Array.from({ length: Math.max(1, label.copies) })
		.map(
			() =>
				`<div class="page"><div class="name">${escapeHtml(label.nameEn)}</div>${
					label.nameAr
						? `<div class="name-ar" dir="rtl">${escapeHtml(label.nameAr)}</div>`
						: ''
				}${rows}${
					label.storageNote
						? `<div class="note">${escapeHtml(label.storageNote)}</div>`
						: ''
				}</div>`,
		)
		.join('')}</body></html>`
}

/** Prints a label through a hidden frame (never the visible page, so no other print CSS is touched). */
export function printLabelInBrowser(label: LabelData, words: LabelWords): void {
	const frame = document.createElement('iframe')
	frame.setAttribute('aria-hidden', 'true')
	frame.style.cssText =
		'position:fixed;inset-inline-start:-9999px;width:0;height:0;border:0'
	frame.srcdoc = labelHtml(label, words)
	frame.onload = () => {
		frame.contentWindow?.focus()
		frame.contentWindow?.print()
		window.setTimeout(() => frame.remove(), 60_000)
	}
	document.body.appendChild(frame)
}
