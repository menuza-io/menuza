import {
	type DiscountCartLine,
	type DiscountContext,
	type DiscountEvaluationInput,
} from './evaluate.ts'
import { type DiscountRecord } from './definition.ts'

export function makeDiscount(
	overrides: Partial<DiscountRecord> = {},
): DiscountRecord {
	return {
		id: 'd1',
		version: 1,
		createdAt: '2026-01-01T00:00:00.000Z',
		name: 'Test discount',
		internalName: null,
		description: null,
		status: 'active',
		application: 'automatic',
		valueType: 'percent',
		percentBp: 1000,
		amountMinor: null,
		currency: null,
		maxDiscountMinor: null,
		target: {
			scope: 'order',
			itemIds: [],
			categoryIds: [],
			excludeItemIds: [],
			excludeCategoryIds: [],
		},
		requirement: null,
		quantityRule: { kind: 'none' },
		maxDiscountedUnits: null,
		minSubtotalMinor: null,
		locationIds: null,
		channels: ['web', 'qr', 'pos', 'app'],
		fulfillments: ['pickup', 'delivery', 'dine_in'],
		includeDrops: false,
		schedule: null,
		startsAt: null,
		endsAt: null,
		eligibility: 'everyone',
		totalLimit: null,
		perCustomerLimit: null,
		combinable: false,
		priority: 0,
		promoteOnMenu: false,
		requireApproval: false,
		...overrides,
	}
}

export function makeLine(
	overrides: Partial<DiscountCartLine> = {},
): DiscountCartLine {
	return {
		lineId: '0',
		itemId: 'burger',
		variantId: null,
		categoryIds: ['mains'],
		quantity: 1,
		unitMinor: 1000,
		excluded: false,
		...overrides,
	}
}

export function makeContext(
	overrides: Partial<DiscountContext> = {},
): DiscountContext {
	return {
		channel: 'web',
		fulfillment: 'pickup',
		locationId: 'loc1',
		isDrop: false,
		// A Friday.
		localNow: '2026-10-30T12:00',
		deliveryFeeMinor: 0,
		customer: { signedIn: false, isNewCustomer: false, isLoyaltyMember: false },
		...overrides,
	}
}

export function makeInput(
	overrides: Partial<DiscountEvaluationInput> = {},
): DiscountEvaluationInput {
	return {
		currency: 'USD',
		lines: [makeLine()],
		context: makeContext(),
		discounts: [],
		codes: [],
		usage: {},
		codeUsage: {},
		...overrides,
	}
}
