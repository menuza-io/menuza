import { describe, expect, it } from 'vitest'
import {
	compactTickets,
	DEFAULT_TICKETS,
	fieldClasses,
	fieldStyle,
	printAllowed,
	resolveTickets,
	TICKET_FIELDS,
	TICKET_TYPES,
	visibleFields,
} from './ticket-config.ts'

describe('ticket settings', () => {
	it('with nothing set, every field shows plain and nothing prints by itself', () => {
		for (const type of TICKET_TYPES)
			for (const field of TICKET_FIELDS[type]) {
				const style = fieldStyle(DEFAULT_TICKETS, type, field.key)
				expect(style).toEqual({ show: true, bold: false, large: false })
				expect(fieldClasses(style)).toBe('')
			}
		expect(DEFAULT_TICKETS.when).toEqual({
			receipt: 'manual',
			kitchen: 'manual',
		})
		expect(DEFAULT_TICKETS).toMatchObject({
			excludeDineIn: false,
			changesOnly: false,
			strikeCompleted: false,
			cancellationSlip: false,
		})
		expect(fieldStyle(null, 'receipt', 'tip').show).toBe(true)
	})

	it('hides a field, and styles one, from the stored settings', () => {
		const t = resolveTickets(
			JSON.stringify({
				receipt: {
					servedBy: { show: false },
					total: { bold: true, large: true },
				},
				kitchen: { itemNotes: { bold: true } },
			}),
		)
		expect(fieldStyle(t, 'receipt', 'servedBy').show).toBe(false)
		expect(visibleFields(t, 'receipt')).not.toContain('servedBy')
		expect(visibleFields(t, 'receipt')).toContain('items')
		expect(fieldClasses(fieldStyle(t, 'receipt', 'total'))).toBe(
			'font-bold text-base',
		)
		expect(fieldClasses(fieldStyle(t, 'kitchen', 'itemNotes'))).toBe(
			'font-bold',
		)
		// Other types are untouched.
		expect(fieldStyle(t, 'assembly', 'itemNotes').bold).toBe(false)
	})

	it('never hides a locked field, whatever is stored', () => {
		const t = resolveTickets({
			receipt: {
				vatNumber: { show: false },
				total: { show: false },
				tax: { show: false },
			},
			kitchen: { items: { show: false } },
		})
		for (const key of ['vatNumber', 'total', 'tax', 'items', 'qrCode'])
			expect(fieldStyle(t, 'receipt', key).show).toBe(true)
		expect(fieldStyle(t, 'kitchen', 'items').show).toBe(true)
	})

	it('reads damaged settings as the defaults, one part at a time', () => {
		expect(resolveTickets('not json')).toEqual(DEFAULT_TICKETS)
		expect(resolveTickets(42)).toEqual(DEFAULT_TICKETS)
		const t = resolveTickets({
			when: { receipt: 'sometimes', kitchen: 'on_acceptance' },
			changesOnly: 'yes',
			cancellationSlip: true,
			receipt: { tip: { show: 'no' }, thankYou: { show: false } },
		})
		expect(t.when).toEqual({ receipt: 'manual', kitchen: 'on_acceptance' })
		expect(t.changesOnly).toBe(false)
		expect(t.cancellationSlip).toBe(true)
		expect(fieldStyle(t, 'receipt', 'tip').show).toBe(true)
		expect(fieldStyle(t, 'receipt', 'thankYou').show).toBe(false)
	})

	it('leaves dine-in out of printing when asked', () => {
		const t = resolveTickets({ excludeDineIn: true })
		expect(printAllowed(t, 'dine_in')).toBe(false)
		expect(printAllowed(t, 'takeaway')).toBe(true)
		expect(printAllowed(t, 'delivery')).toBe(true)
		expect(printAllowed(DEFAULT_TICKETS, 'dine_in')).toBe(true)
	})

	it('saves only what differs from the defaults, and drops unknown or locked-hide entries', () => {
		const saved = compactTickets({
			receipt: {
				servedBy: { show: false },
				tip: { show: true },
				vatNumber: { show: false },
				bogus: { show: false },
				total: { bold: true },
			},
			kitchen: {},
			when: { receipt: 'manual', kitchen: 'when_ready' },
			changesOnly: false,
			cancellationSlip: true,
		})
		expect(saved).toEqual({
			receipt: { servedBy: { show: false }, total: { bold: true } },
			when: { kitchen: 'when_ready' },
			cancellationSlip: true,
		})
		expect(compactTickets({})).toEqual({})
	})
})
