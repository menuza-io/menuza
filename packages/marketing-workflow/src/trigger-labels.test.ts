import {
	JOURNEY_TRIGGER_TYPES,
	RESERVATION_JOURNEY_TRIGGER_TYPES,
} from '@repo/tenant-db/types/journey'
import { describe, expect, it } from 'vitest'
import {
	TENANT_TRIGGER_LABELS,
	TENANT_TRIGGER_OPTIONS,
} from './workflow-config.tsx'
import {
	TENANT_TRIGGER_MSGS,
	TENANT_TRIGGER_OPTION_MSGS,
} from './workflow-labels.ts'

// The label maps are Record<string, ...>, so a missing key is not a type error.
describe('tenant trigger labels', () => {
	it.each(JOURNEY_TRIGGER_TYPES)('labels %s in all four maps', (trigger) => {
		expect(TENANT_TRIGGER_MSGS[trigger]).toBeDefined()
		expect(TENANT_TRIGGER_OPTION_MSGS[trigger]).toBeDefined()
		expect(TENANT_TRIGGER_LABELS[trigger]?.label).toBeTruthy()
		expect(TENANT_TRIGGER_LABELS[trigger]?.desc).toBeTruthy()
		expect(
			TENANT_TRIGGER_OPTIONS.find((option) => option.value === trigger)?.label,
		).toBeTruthy()
	})

	it('has the four reservation triggers', () => {
		expect([...RESERVATION_JOURNEY_TRIGGER_TYPES]).toEqual([
			'reservation_booked',
			'reservation_completed',
			'reservation_no_show',
			'reservation_cancelled',
		])
	})

	it('offers every trigger type exactly once', () => {
		expect(TENANT_TRIGGER_OPTIONS.map((o) => o.value).sort()).toEqual(
			[...JOURNEY_TRIGGER_TYPES].sort(),
		)
	})
})
