import {
	type PrintPiece,
	type PrintPieceFact,
	type PrintProduct,
	type PrintQrTarget,
} from '@repo/common/print-shop'
import { type PrintShopAccess } from './access.server.ts'

/**
 * The server half of a print vertical: what a business type adds to the
 * generic Print shop. The core designs, proofs, renders, prices, ships and
 * refunds; the vertical says where the business's places, featured items and
 * extra QR codes come from. Its catalog half (products and QR target
 * schemas) is registered in `@repo/common/print-shop-catalog`, and its UI in
 * `components/print/vertical-ui.tsx`. See `docs/print-shop-verticals.md`.
 */

export type PrintOrg = PrintShopAccess['organization']

/** A place of the business (a branch, office, venue). The id is opaque. */
export type PrintScope = {
	id: string
	name: string
	isDefault: boolean
	/** One line for the print footer, or null. */
	address: string | null
	/** Prefills the ship-to of an order (US fields), or null. */
	shipTo: {
		line1: string
		line2: string
		city: string
		/** Two-letter state code, as `PrintShippingAddress` expects. */
		state: string
		postalCode: string
	} | null
}

/** Something the business sells that a page can feature. */
export type PrintItemChoice = {
	id: string
	name: string
	priceCents: number
	/** Org media asset id or object key of the item's photo, or null. */
	imageKey: string | null
}

export type PrintTargetResolveContext = {
	request: Request
	access: PrintShopAccess
	designId: string
	/** The org's public site origin, for links on the code. */
	siteOrigin: string
	/** UTM tags every printed code carries. */
	utm: Record<string, string>
}

/** The server side of one QR target kind the vertical adds. */
export type PrintQrTargetServer = {
	/** Listed in the editor for this user and org. Default: always. */
	available?(access: PrintShopAccess): Promise<boolean>
	/**
	 * The codes are capabilities (a way in to something): who may see the
	 * proof, download it and order it. Default: anyone with Print shop access.
	 */
	canView?(access: PrintShopAccess): Promise<boolean>
	/** A new design's starting target for this product, or null to skip. */
	defaultFor?(
		access: PrintShopAccess,
		input: { product: PrintProduct; scope: PrintScope | null },
	): Promise<PrintQrTarget | null>
	/** Data the target's editor fields need (JSON-serializable). */
	editorData?(request: Request, access: PrintShopAccess): Promise<unknown>
	/** How many pieces the target prints, for the proof's height. Default 1. */
	pieceCount?(target: PrintQrTarget, editorData: unknown): number
	/** The target from the editor form; `'empty'` when nothing was chosen. */
	fromForm(formData: FormData): PrintQrTarget | 'empty'
	/**
	 * The printed pieces with their code URLs, and the versioned facts the
	 * re-order check compares. Throw a 503 `Response` when the source is
	 * unavailable and a 403 when the user may not see the codes.
	 */
	resolve(
		target: PrintQrTarget,
		context: PrintTargetResolveContext,
	): Promise<{ pieces: PrintPiece[]; facts: PrintPieceFact[] }>
}

export type PrintShopServerVertical = {
	id: string
	/** The business's places: footer address, item prices, ship-to prefill. */
	scopes?: { list(organizationId: string): Promise<PrintScope[]> }
	/** Items a page can feature, priced for a scope. */
	featuredItems?: {
		list(
			org: PrintOrg,
			scopeId: string | null,
		): Promise<{ items: PrintItemChoice[]; currency: string }>
	}
	/** Server side of the catalog's extra QR targets, by kind. */
	qrTargets?: Record<string, PrintQrTargetServer>
}

/** No business type: posters, flyers and stickers that link to the site. */
export const generalPrintVertical: PrintShopServerVertical = { id: 'general' }
