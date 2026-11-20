import { type PublicFormField } from '@repo/common/public-form'
import { describe, expect, it } from 'vitest'
import {
	buildFormPayload,
	locationFieldMode,
	offeredLocations,
	visibleFieldIds,
} from './website-form-fields'

const downtown = { id: 'loc-a', name: 'Downtown' }
const airport = { id: 'loc-b', name: 'Airport' }
const mall = { id: 'loc-c', name: 'Mall' }

const field = (
	extra: Partial<PublicFormField> & Pick<PublicFormField, 'id' | 'type'>,
): PublicFormField => ({ label: extra.id, required: false, ...extra })

describe('Location field (#239)', () => {
	it('lists only the chosen locations that are still active', () => {
		// loc-c was chosen but is deactivated, so it is not in the active list.
		const chosen = field({
			id: 'place',
			type: 'location',
			locationIds: ['loc-a', 'loc-c'],
		})
		expect(offeredLocations(chosen, [downtown, airport])).toEqual([downtown])
		// Nothing chosen offers every active location.
		expect(
			offeredLocations(field({ id: 'p', type: 'location' }), [
				downtown,
				airport,
			]),
		).toEqual([downtown, airport])
	})

	it('hides with no location left and does not ask when there is one', () => {
		expect(locationFieldMode([])).toBe('hidden')
		expect(locationFieldMode([downtown])).toBe('single')
		expect(locationFieldMode([downtown, airport, mall])).toBe('pick')
	})

	it('a form with no locations left posts without it and marks it unavailable', () => {
		const fields = [field({ id: 'place', type: 'location', required: true })]
		const payload = buildFormPayload(fields, {
			getAll: () => [],
			offered: { place: [] },
		})
		expect(payload).toEqual({
			values: {},
			locationLabels: {},
			unavailableFields: ['place'],
		})
	})

	it('sends the id and the name of the picked location', () => {
		const fields = [field({ id: 'place', type: 'location' })]
		const payload = buildFormPayload(fields, {
			getAll: (name) => (name === 'place' ? ['loc-b'] : []),
			offered: { place: [downtown, airport] },
		})
		expect(payload.values).toEqual({ place: 'loc-b' })
		expect(payload.locationLabels).toEqual({ place: 'Airport' })
	})

	it('answers for the only location without asking', () => {
		const fields = [field({ id: 'place', type: 'location' })]
		const payload = buildFormPayload(fields, {
			getAll: () => [],
			offered: { place: [downtown] },
		})
		expect(payload.values).toEqual({ place: 'loc-a' })
		expect(payload.locationLabels).toEqual({ place: 'Downtown' })
	})

	it('refuses to send a location that is not on offer', () => {
		const fields = [field({ id: 'place', type: 'location' })]
		const payload = buildFormPayload(fields, {
			getAll: (name) => (name === 'place' ? ['loc-z'] : []),
			offered: { place: [downtown, airport] },
		})
		expect(payload.values).toEqual({})
	})
})

describe('conditional fields and the payload (#357)', () => {
	const fields: PublicFormField[] = [
		field({
			id: 'fulfilment',
			type: 'single_choice',
			required: true,
			options: ['Delivery', 'Pickup'],
		}),
		field({
			id: 'address',
			type: 'address',
			required: true,
			showWhen: { fieldId: 'fulfilment', values: ['Delivery'] },
		}),
		field({ id: 'notes', type: 'textarea' }),
	]
	const read = (data: Record<string, string[]>) => ({
		getAll: (name: string) => data[name] ?? [],
		offered: {},
	})

	it('shows the address only for Delivery', () => {
		expect([...visibleFieldIds(fields, { fulfilment: 'Delivery' })]).toEqual([
			'fulfilment',
			'address',
			'notes',
		])
		expect([...visibleFieldIds(fields, { fulfilment: 'Pickup' })]).toEqual([
			'fulfilment',
			'notes',
		])
	})

	it('does not send a hidden field even if the browser still holds its value', () => {
		const payload = buildFormPayload(
			fields,
			read({
				fulfilment: ['Pickup'],
				address__street: ['left over'],
				notes: ['hi'],
			}),
		)
		expect(payload.values).toEqual({ fulfilment: 'Pickup', notes: 'hi' })
	})

	it('sends an address as its three parts when it is shown', () => {
		const payload = buildFormPayload(
			fields,
			read({
				fulfilment: ['Delivery'],
				address__street: ['1 Main St'],
				address__city: ['Riyadh'],
				address__postcode: ['11564'],
			}),
		)
		expect(payload.values.address).toEqual({
			street: '1 Main St',
			city: 'Riyadh',
			postcode: '11564',
		})
	})
})
