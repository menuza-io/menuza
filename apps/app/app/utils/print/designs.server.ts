import {
	PRINT_MAX_PIECES_PER_DESIGN,
	PRINT_TEMPLATE_VERSION,
	type PrintDesignContent,
	type PrintProductKey,
	type PrintQrTarget,
	type PrintSnapshot,
	type PrintTemplateStyle,
} from '@repo/common/print-shop'
import { printCatalog } from '@repo/common/print-shop-catalog'
import { and, db, desc, eq, isNull, PrintDesign } from '@repo/database'
import { type PrintShopAccess } from './access.server.ts'
import {
	buildPrintSnapshot,
	listPrintScopes,
	orgLocales,
	pickScope,
	snapshotHash,
} from './print-snapshot.server.ts'
import { printVertical } from './vertical.server.ts'

export type PrintDesignRow = typeof PrintDesign.$inferSelect

export type PrintDesignView = {
	id: string
	name: string
	product: PrintProductKey
	sizeKey: string
	style: PrintTemplateStyle
	status: 'draft' | 'approved'
	content: PrintDesignContent
	hasApprovedSnapshot: boolean
	approvedAt: string | null
	updatedAt: string
}

export function toDesignView(row: PrintDesignRow): PrintDesignView {
	const content = printCatalog.designContentSchema.safeParse(row.content)
	return {
		id: row.id,
		name: row.name,
		product: row.product,
		sizeKey: row.sizeKey,
		style: row.style as PrintTemplateStyle,
		status: row.status === 'approved' ? 'approved' : 'draft',
		content: content.success
			? content.data
			: (row.content as PrintDesignContent),
		hasApprovedSnapshot: row.snapshot != null,
		approvedAt: row.approvedAt ? row.approvedAt.toISOString() : null,
		updatedAt: row.updatedAt.toISOString(),
	}
}

export async function listPrintDesigns(organizationId: string) {
	const rows = await db
		.select()
		.from(PrintDesign)
		.where(
			and(
				eq(PrintDesign.organizationId, organizationId),
				isNull(PrintDesign.archivedAt),
			),
		)
		.orderBy(desc(PrintDesign.updatedAt))
	return rows.map(toDesignView)
}

/** The design, or a 404 when it belongs to another org (or does not exist). */
export async function requirePrintDesign(
	organizationId: string,
	designId: string | undefined,
): Promise<PrintDesignRow> {
	if (!designId) throw new Response('Not Found', { status: 404 })
	const [row] = await db
		.select()
		.from(PrintDesign)
		.where(
			and(
				eq(PrintDesign.id, designId),
				eq(PrintDesign.organizationId, organizationId),
				isNull(PrintDesign.archivedAt),
			),
		)
		.limit(1)
	if (!row) throw new Response('Not Found', { status: 404 })
	return row
}

async function defaultContent(
	access: PrintShopAccess,
	product: PrintProductKey,
): Promise<PrintDesignContent> {
	const { defaultLocale } = orgLocales(access.organization)
	const scope = pickScope(await listPrintScopes(access.organization.id), null)
	// The first target (in the product's order) the vertical can start with.
	let qr: PrintQrTarget = { kind: 'site', path: '/' }
	const spec = printCatalog.products[product]
	for (const kind of printCatalog.targetsFor(product)) {
		const start = spec
			? await printVertical.qrTargets?.[kind]?.defaultFor?.(access, {
					product: spec,
					scope,
				})
			: null
		if (start) {
			qr = start
			break
		}
	}
	return {
		locales: [defaultLocale],
		headline: {},
		body: {},
		callToAction: {},
		qr,
		featuredItemIds: [],
		scopeId: scope?.id ?? null,
		showAddress: true,
		showWebsite: true,
	}
}

export async function createPrintDesign(
	access: PrintShopAccess,
	input: {
		name: string
		product: PrintProductKey
		sizeKey: string
		style: PrintTemplateStyle
	},
) {
	if (!printCatalog.getSize(input.product, input.sizeKey)) {
		throw new Response('Unknown size', { status: 400 })
	}
	const [row] = await db
		.insert(PrintDesign)
		.values({
			organizationId: access.organization.id,
			createdById: access.userId,
			name: input.name,
			product: input.product,
			sizeKey: input.sizeKey,
			style: input.style,
			templateVersion: PRINT_TEMPLATE_VERSION,
			content: await defaultContent(access, input.product),
			status: 'draft',
		})
		.returning()
	return row!
}

/**
 * Saving edits returns a design to draft: the approved snapshot stays (it is
 * what past orders printed) but downloads and new orders wait for a new
 * approval of the proof.
 */
export async function savePrintDesign(
	row: PrintDesignRow,
	input: {
		name: string
		sizeKey: string
		style: PrintTemplateStyle
		content: PrintDesignContent
	},
) {
	const product = row.product
	if (!printCatalog.getSize(product, input.sizeKey)) {
		throw new Response('Unknown size', { status: 400 })
	}
	if (!printCatalog.targetsFor(product).includes(input.content.qr.kind)) {
		throw new Response('This print cannot use that QR code', { status: 400 })
	}
	if (!printCatalog.products[product]?.featuredItems) {
		input.content.featuredItemIds = []
	}
	const [updated] = await db
		.update(PrintDesign)
		.set({
			name: input.name,
			sizeKey: input.sizeKey,
			style: input.style,
			content: input.content,
			templateVersion: PRINT_TEMPLATE_VERSION,
			status: 'draft',
		})
		.where(eq(PrintDesign.id, row.id))
		.returning()
	return updated!
}

/** The snapshot for the current content (proof), resolved live. */
export async function currentSnapshot(
	request: Request,
	access: PrintShopAccess,
	row: PrintDesignRow,
	options: { skipImages?: boolean } = {},
): Promise<PrintSnapshot> {
	const view = toDesignView(row)
	return buildPrintSnapshot({
		request,
		access,
		skipImages: options.skipImages,
		design: {
			id: row.id,
			product: view.product,
			sizeKey: view.sizeKey,
			style: view.style,
			content: view.content,
		},
	})
}

/**
 * Approval freezes the proof: the snapshot (with piece labels, code
 * versions and item prices as they are now) is what every download and order
 * of this design prints until the operator approves again.
 */
export async function approvePrintDesign(
	request: Request,
	access: PrintShopAccess,
	row: PrintDesignRow,
) {
	const snapshot = await currentSnapshot(request, access, row)
	if (snapshot.pieces.length === 0) {
		throw new Response('Nothing to print yet', { status: 422 })
	}
	// One file and one price per piece: a vertical's "every one" target must
	// not grow a set past the cap (downloads and orders print the snapshot).
	if (snapshot.pieces.length > PRINT_MAX_PIECES_PER_DESIGN) {
		throw new Response('Too many pieces', { status: 413 })
	}
	// Only the version the snapshot was built from: a save in between (another
	// editor) must not be marked approved with older words.
	const [updated] = await db
		.update(PrintDesign)
		.set({
			status: 'approved',
			snapshot,
			snapshotHash: snapshotHash(snapshot),
			approvedAt: new Date(),
			approvedById: access.userId,
		})
		.where(
			and(eq(PrintDesign.id, row.id), eq(PrintDesign.updatedAt, row.updatedAt)),
		)
		.returning()
	if (!updated) {
		throw new Response('The print changed while it was approved', {
			status: 409,
		})
	}
	return updated
}

export function approvedSnapshot(row: PrintDesignRow): PrintSnapshot | null {
	if (row.status !== 'approved' || !row.snapshot) return null
	return row.snapshot as PrintSnapshot
}

export async function archivePrintDesign(row: PrintDesignRow) {
	await db
		.update(PrintDesign)
		.set({ archivedAt: new Date() })
		.where(eq(PrintDesign.id, row.id))
}
