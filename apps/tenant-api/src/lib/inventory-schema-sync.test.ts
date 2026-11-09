import {
	COUNT_STATUSES,
	DELIVERY_SOURCES,
	DELIVERY_STATUSES,
	INVENTORY_ACTOR_KINDS,
	INVENTORY_BASE_UNITS,
	INVENTORY_ITEM_KINDS,
	MOVEMENT_KINDS,
	SUPPLIER_ORDER_CHANNELS,
	UNIT_SYSTEMS,
	WASTE_REASONS,
} from '@repo/inventory'
import {
	INV_ACTOR_KIND_VALUES,
	INV_BASE_UNIT_VALUES,
	INV_COUNT_STATUS_VALUES,
	INV_DELIVERY_SOURCE_VALUES,
	INV_DELIVERY_STATUS_VALUES,
	INV_ITEM_KIND_VALUES,
	INV_MOVEMENT_KIND_VALUES,
	INV_SUPPLIER_ORDER_CHANNEL_VALUES,
	INV_UNIT_SYSTEM_VALUES,
	INV_WASTE_REASON_VALUES,
} from '@repo/tenant-db'
import { describe, expect, it } from 'vitest'

/**
 * The tenant-db check constraints name these values in SQL; the domain lists
 * live in @repo/inventory. They must be the same sets, so a new kind or reason
 * is added in both places (and a migration) or neither.
 */
const PAIRS: Array<[string, readonly string[], readonly string[]]> = [
	['unit system', INV_UNIT_SYSTEM_VALUES, UNIT_SYSTEMS],
	['base unit', INV_BASE_UNIT_VALUES, INVENTORY_BASE_UNITS],
	['item kind', INV_ITEM_KIND_VALUES, INVENTORY_ITEM_KINDS],
	['actor kind', INV_ACTOR_KIND_VALUES, INVENTORY_ACTOR_KINDS],
	['movement kind', INV_MOVEMENT_KIND_VALUES, MOVEMENT_KINDS],
	['count status', INV_COUNT_STATUS_VALUES, COUNT_STATUSES],
	['waste reason', INV_WASTE_REASON_VALUES, WASTE_REASONS],
	['order channel', INV_SUPPLIER_ORDER_CHANNEL_VALUES, SUPPLIER_ORDER_CHANNELS],
	['delivery status', INV_DELIVERY_STATUS_VALUES, DELIVERY_STATUSES],
	['delivery source', INV_DELIVERY_SOURCE_VALUES, DELIVERY_SOURCES],
]

describe('inventory value lists match the tenant-db check constraints', () => {
	it.each(PAIRS)('%s', (_name, tenantDb, domain) => {
		expect([...tenantDb].sort()).toEqual([...domain].sort())
	})
})
