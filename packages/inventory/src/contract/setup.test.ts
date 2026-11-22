import { describe, expect, test } from 'vitest'
import {
	inventoryNotifyEventSchema,
	MAX_SOLD_OUT_ALERT_ENTRIES,
} from './notify.ts'
import { unitChangeBodySchema, createGroupSchema } from './setup.ts'

describe('sold-out alerts (#478)', () => {
	const entry = {
		entityType: 'item' as const,
		entityId: 'dish_1',
		ingredientId: 'itm_1',
		ingredientName: 'Chicken',
	}
	const event = {
		orgId: 'org_1',
		eventId: 'a'.repeat(32),
		kind: 'inventory_sold_out' as const,
		locationId: 'main',
		count: 1,
		soldOut: [entry],
	}

	test('carries dish ids and the ingredient, nothing else', () => {
		expect(inventoryNotifyEventSchema.safeParse(event).success).toBe(true)
		expect(
			inventoryNotifyEventSchema.safeParse({
				...event,
				kind: 'inventory_sold_out_back',
			}).success,
		).toBe(true)
		for (const bad of [
			{ guestName: 'Sara' },
			{ soldOut: [{ ...entry, guestPhone: '+966500000000' }] },
			{ soldOut: [] },
			{
				soldOut: Array.from(
					{ length: MAX_SOLD_OUT_ALERT_ENTRIES + 1 },
					() => entry,
				),
			},
			{ soldOut: [{ ...entry, ingredientName: '' }] },
		]) {
			expect(
				inventoryNotifyEventSchema.safeParse({ ...event, ...bad }).success,
			).toBe(false)
		}
	})
})

describe('setup requests', () => {
	test('a unit change names the new unit and an exact equation', () => {
		const ok = {
			toUnit: 'g',
			oldAmount: '1',
			newAmount: '180',
			expectedVersion: 1,
		}
		expect(unitChangeBodySchema.safeParse(ok).success).toBe(true)
		for (const bad of [
			{ toUnit: 'kg' },
			{ newAmount: '1e3' },
			{ newAmount: '-5' },
			{ oldAmount: '1.1234567' },
			{ extra: true },
		]) {
			expect(unitChangeBodySchema.safeParse({ ...ok, ...bad }).success).toBe(
				false,
			)
		}
	})

	test('a group needs at least one member and refuses unknown fields', () => {
		const ok = {
			clientId: 'client-12345678',
			name: 'Olive oil',
			baseUnit: 'ml',
			members: [{ itemId: 'a' }],
		}
		expect(createGroupSchema.parse(ok).members[0]).toMatchObject({
			memberQuantity: 1,
			groupQuantity: 1,
		})
		expect(createGroupSchema.safeParse({ ...ok, members: [] }).success).toBe(
			false,
		)
		expect(createGroupSchema.safeParse({ ...ok, price: 1 }).success).toBe(false)
	})
})
