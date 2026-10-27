import { type PrintQrTarget } from '@repo/common/print-shop'
import { type PrintShopAccess } from './access.server.ts'
import { printVertical } from './vertical.server.ts'

/**
 * Some QR codes are capabilities (a code that lets someone in to something),
 * so the vertical decides who may see them. Proofs, downloads and orders of
 * a print with such codes check here, whoever approved it.
 */
export async function canViewQrCodes(
	access: PrintShopAccess,
	target: Pick<PrintQrTarget, 'kind'>,
): Promise<boolean> {
	const check = printVertical.qrTargets?.[target.kind]?.canView
	return check ? check(access) : true
}

/** A 403 unless the user may see the codes of this snapshot's target. */
export async function requireQrCodeAccess(
	access: PrintShopAccess,
	snapshot: { qr?: Pick<PrintQrTarget, 'kind'> },
) {
	if (!snapshot.qr) return
	if (!(await canViewQrCodes(access, snapshot.qr))) {
		throw new Response('Forbidden', { status: 403 })
	}
}

/** QR target kinds a product offers this user, in editor order. */
export async function availableQrTargets(
	access: PrintShopAccess,
	kinds: readonly string[],
): Promise<string[]> {
	const allowed = await Promise.all(
		kinds.map(async (kind) => {
			const check = printVertical.qrTargets?.[kind]?.available
			return check ? check(access) : true
		}),
	)
	return kinds.filter((_, index) => allowed[index])
}
