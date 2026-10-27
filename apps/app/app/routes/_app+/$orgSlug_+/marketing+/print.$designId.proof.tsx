import { type LoaderFunctionArgs } from 'react-router'
import { requirePrintShopAccess } from '#app/utils/print/access.server.ts'
import {
	approvedSnapshot,
	currentSnapshot,
	requirePrintDesign,
} from '#app/utils/print/designs.server.ts'
import {
	printDocumentCsp,
	renderPrintHtml,
} from '#app/utils/print/print-document.server.tsx'
import { qrSvgsFor } from '#app/utils/print/print-snapshot.server.ts'

/**
 * The live proof the editor frames: the current content rendered with trim
 * and bleed guides, or the approved snapshot with `?approved=1`. HTML only,
 * scripts off, framable by the App only.
 */
export async function loader({ request, params }: LoaderFunctionArgs) {
	const access = await requirePrintShopAccess(request, params.orgSlug)
	const row = await requirePrintDesign(access.organization.id, params.designId)
	const wantsApproved =
		new URL(request.url).searchParams.get('approved') === '1'
	const snapshot =
		(wantsApproved ? approvedSnapshot(row) : null) ??
		(await currentSnapshot(request, access, row))
	const html = renderPrintHtml({
		snapshot,
		format: 'proof',
		qrSvgs: await qrSvgsFor(snapshot),
		proofLimit: 3,
	})
	return new Response(html, {
		headers: {
			'Content-Type': 'text/html; charset=utf-8',
			'Cache-Control': 'private, no-store',
			'Content-Security-Policy': printDocumentCsp(),
			'X-Content-Type-Options': 'nosniff',
		},
	})
}
