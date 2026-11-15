import {
	MENU_CARD_LINK_ENDS,
	type MenuCardEntityType,
	type MenuCardOp,
} from './menu-cards.ts'
import { indexMenuGraph, type MenuGraph } from './menu-graph.ts'

/**
 * Fields a connected POS owns. Locking them in the editor is issue #93 and
 * is not built; until then the review cards simply never write them.
 *
 * A record with an `OrganizationMenuPosLink` row was imported from a POS
 * (`packages/integrations/src/pos/service.ts`, `import-menu-modifiers.ts`),
 * and the next import rewrites what the import fills:
 *  - dish (`item`): name, description, price, sizes (variant prices), and
 *    its option-group links;
 *  - option group (`modifier_group`): name, selection type, min and max, and
 *    which options it holds (with their price overrides);
 *  - option (`modifier_option`): name and prices.
 * Categories carry no POS link (the import finds them by name), so they are
 * ours. Availability and position always stay ours: hiding or reordering a
 * POS dish is allowed.
 */
export const POS_OWNED_FIELDS: Partial<
	Record<MenuCardEntityType, readonly string[]>
> = {
	item: ['displayName', 'description', 'price', 'variations'],
	modifier_group: ['name', 'selectionType', 'minSelections', 'maxSelections'],
	option: ['displayName', 'price', 'priceWhole', 'priceLeft', 'priceRight'],
}

/** POS link `entityType` for a card entity type. */
const POS_TYPE: Partial<Record<MenuCardEntityType, string>> = {
	item: 'item',
	modifier_group: 'modifier_group',
	option: 'modifier_option',
	category: 'category',
}

export function isPosLinked(
	graph: MenuGraph,
	type: MenuCardEntityType,
	id: string,
): boolean {
	const posType = POS_TYPE[type]
	return posType ? indexMenuGraph(graph).posLinked(posType, id) : false
}

/** The first op that writes a POS-owned field of a linked record, or null. */
export function posOwnedViolation(
	graph: MenuGraph,
	ops: readonly MenuCardOp[],
): MenuCardOp | null {
	for (const op of ops) {
		if (op.op === 'update') {
			if (!isPosLinked(graph, op.entity, op.id)) continue
			const owned = POS_OWNED_FIELDS[op.entity] ?? []
			if (Object.keys(op.set).some((field) => owned.includes(field))) return op
			continue
		}
		if (op.op === 'assign' || op.op === 'unassign') {
			// A POS dish's groups and a POS group's options come from the POS.
			if (op.link === 'item_modifier_group' || op.link === 'group_option') {
				const parentType = MENU_CARD_LINK_ENDS[op.link].parent
				if (isPosLinked(graph, parentType, op.parentId)) return op
			}
		}
	}
	return null
}
