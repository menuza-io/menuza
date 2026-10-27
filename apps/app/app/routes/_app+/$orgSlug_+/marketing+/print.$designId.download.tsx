import {
	PRINT_DEFAULT_BLEED_MM,
	PRINT_DOWNLOAD_FORMATS,
	PRINT_HOME_SHEETS,
} from '@repo/common/print-shop'
import { redirect, type LoaderFunctionArgs } from 'react-router'
import { z } from 'zod'
import { requirePrintShopAccess } from '#app/utils/print/access.server.ts'
import {
	approvedSnapshot,
	requirePrintDesign,
} from '#app/utils/print/designs.server.ts'
import { printDocumentCsp } from '#app/utils/print/print-document.server.tsx'
import { getPrintFile } from '#app/utils/print/print-files.server.ts'
import { requireQrCodeAccess } from '#app/utils/print/qr-access.server.ts'

const querySchema = z.object({
	format: z.enum(PRINT_DOWNLOAD_FORMATS).default('pro'),
	sheet: z.enum(PRINT_HOME_SHEETS).default('letter'),
})

function fileName(name: string, format: string) {
	const base =
		name
			.normalize('NFKD')
			.replace(/[^\w\s-]/g, '')
			.trim()
			.replace(/\s+/g, '-')
			.toLowerCase()
			.slice(0, 60) || 'print'
	return `${base}-${format}.pdf`
}

/**
 * Downloads the approved print as a PDF: `home` tiles pieces on Letter/A4
 * with crop marks, `pro` is one piece per page with bleed for a print shop.
 * Free on every plan. Without a renderer (local dev) it serves the
 * print-ready page, which opens the browser's print dialog.
 */
export async function loader({ request, params }: LoaderFunctionArgs) {
	const access = await requirePrintShopAccess(request, params.orgSlug)
	const row = await requirePrintDesign(access.organization.id, params.designId)
	const snapshot = approvedSnapshot(row)
	if (!snapshot) {
		throw new Response('Approve the proof before downloading', { status: 409 })
	}
	await requireQrCodeAccess(access, snapshot)
	const query = querySchema.safeParse(
		Object.fromEntries(new URL(request.url).searchParams),
	)
	if (!query.success) throw new Response('Bad Request', { status: 400 })

	const result = await getPrintFile({
		organizationId: access.organization.id,
		snapshot,
		format: query.data.format,
		homeSheet: query.data.sheet,
		bleedMm: PRINT_DEFAULT_BLEED_MM,
	})
	switch (result.kind) {
		case 'pdf':
			return new Response(result.bytes, {
				headers: {
					'Content-Type': 'application/pdf',
					'Content-Disposition': `attachment; filename="${fileName(row.name, query.data.format)}"`,
					'Cache-Control': 'private, no-store',
					'X-Content-Type-Options': 'nosniff',
				},
			})
		case 'html':
			return new Response(result.html, {
				headers: {
					'Content-Type': 'text/html; charset=utf-8',
					'Cache-Control': 'private, no-store',
					'Content-Security-Policy': printDocumentCsp(result.nonce),
					'X-Content-Type-Options': 'nosniff',
				},
			})
		// The download opens in a new tab: land it on the editor with a message
		// in the operator's language instead of a bare error body.
		case 'limited':
			throw redirect(
				`/${access.organization.slug}/marketing/print/${row.id}?download=limited`,
			)
		default:
			throw redirect(
				`/${access.organization.slug}/marketing/print/${row.id}?download=failed`,
			)
	}
}
