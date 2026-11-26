import { and, eq, ne } from 'drizzle-orm'
import {
	duplicateBarcodeMessage,
	normalizeBarcode,
	type BarcodeOwner,
} from '@repo/common/pos-barcode'
import {
	db,
	OrganizationMenuItem,
	OrganizationMenuOption,
} from '@repo/database'

/**
 * Refuses a barcode another dish or option in this organization already uses.
 * Returns the message that names the other item, or null when the code is free.
 */
export async function barcodeConflict(input: {
	organizationId: string
	barcode: string | null
	self: { kind: 'item' | 'option'; id: string }
}): Promise<string | null> {
	const code = normalizeBarcode(input.barcode)
	if (!code) return null
	const itemWhere = [
		eq(OrganizationMenuItem.organizationId, input.organizationId),
		eq(OrganizationMenuItem.barcode, code),
	]
	if (input.self.kind === 'item') {
		itemWhere.push(ne(OrganizationMenuItem.id, input.self.id))
	}
	const [item] = await db
		.select({
			id: OrganizationMenuItem.id,
			name: OrganizationMenuItem.displayName,
		})
		.from(OrganizationMenuItem)
		.where(and(...itemWhere))
		.limit(1)
	const optionWhere = [
		eq(OrganizationMenuOption.organizationId, input.organizationId),
		eq(OrganizationMenuOption.barcode, code),
	]
	if (input.self.kind === 'option') {
		optionWhere.push(ne(OrganizationMenuOption.id, input.self.id))
	}
	const [option] = item
		? []
		: await db
				.select({
					id: OrganizationMenuOption.id,
					name: OrganizationMenuOption.displayName,
				})
				.from(OrganizationMenuOption)
				.where(and(...optionWhere))
				.limit(1)
	const owner: BarcodeOwner | null = item
		? { kind: 'item', id: item.id, name: item.name }
		: option
			? { kind: 'option', id: option.id, name: option.name }
			: null
	return owner ? duplicateBarcodeMessage(owner) : null
}
