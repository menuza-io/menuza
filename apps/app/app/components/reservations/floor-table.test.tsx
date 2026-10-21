// @vitest-environment jsdom
import { screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { type ComputedTableFloorState } from '#app/utils/reservations/floor-state.ts'
import { renderStaff } from '#tests/staff-render.tsx'
import { FloorTable } from './floor-table.tsx'

const state = (over: Partial<ComputedTableFloorState> = {}) =>
	({
		table: { id: 't1', label: 'M12', minCovers: 2, maxCovers: 4 },
		liveStatus: 'available',
		stage: null,
		currentReservation: null,
		nextReservation: {
			guestName: 'Tariq Al Mansouri',
			partySize: 6,
			hhmm: '18:00',
			courseStage: null,
		},
		elapsedMin: null,
		remainingMin: null,
		isBlocked: false,
		blockId: null,
		blockReason: null,
		reservedAtHhmm: '18:00',
		sectionId: null,
		sectionName: null,
		sectionColorToken: null,
		serverLabel: null,
		...over,
	}) as unknown as ComputedTableFloorState

const render = (width: number, height: number, s = state()) =>
	renderStaff(
		<FloorTable
			state={s}
			placement={{ x: 0, y: 0, width, height, rotation: 0 }}
			isRound={false}
			selected={false}
			dragOver={false}
			highContrast={false}
			canManage
			sectionColor={null}
			showSection={false}
			onSelect={vi.fn()}
			onDragOverTable={vi.fn()}
			onDragLeaveTable={vi.fn()}
			onDropOnTable={vi.fn()}
		/>,
	)

describe('FloorTable', () => {
	it('prints only the table and a short status word on a minimum tile', () => {
		render(72, 72)
		const tile = screen.getByTestId('floor-table-t1')
		expect(tile.getAttribute('data-tile-tier')).toBe('tight')
		expect(screen.getByTestId('floor-table-status-text-t1').textContent).toBe(
			'Held',
		)
		expect(tile.getAttribute('aria-label')).toContain('Reserved')
		expect(screen.getByTestId('floor-table-label-t1').textContent).toBe('M12')
		// The party does not fit: its full name and size live in the title.
		expect(screen.queryByTestId('floor-table-guest-t1')).toBeNull()
		expect(tile.getAttribute('title')).toContain('Tariq Al Mansouri (6)')
	})

	it('adds the party line and the time when the tile has room', () => {
		render(120, 96)
		const tile = screen.getByTestId('floor-table-t1')
		expect(tile.getAttribute('data-tile-tier')).toBe('roomy')
		expect(
			screen.getByTestId('floor-table-status-text-t1').textContent,
		).toContain('18:00')
		expect(screen.getByTestId('floor-table-guest-t1').textContent).toBe(
			'Tariq M.',
		)
		expect(tile.innerHTML).toContain('line-clamp-2')
	})

	it('never scales its text with the tile (fixed readable type)', () => {
		render(200, 160)
		const tile = screen.getByTestId('floor-table-t1')
		expect(tile.innerHTML).not.toMatch(/text-\[|scale\(/)
		expect(screen.getByTestId('floor-table-label-t1').className).toContain(
			'text-sm',
		)
	})

	it('shows Free for an open table with no booking', () => {
		render(88, 88, state({ nextReservation: null, reservedAtHhmm: null }))
		expect(screen.getByTestId('floor-table-status-text-t1').textContent).toBe(
			'Free',
		)
	})

	it('uses Over, not a truncated Overtime', () => {
		render(88, 88, state({ liveStatus: 'overtime' }))
		expect(screen.getByTestId('floor-table-status-text-t1').textContent).toBe(
			'Over',
		)
	})
})
