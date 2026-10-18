// @vitest-environment jsdom
import { RESERVATION_STATUSES } from '@repo/reservations'
import {
	RSV_RESERVATION_STATUS_VALUES,
	RSV_WAITLIST_STATUS_VALUES,
} from '@repo/tenant-db'
import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { type LiveTableState } from '#app/utils/reservations/book-api.ts'
import { renderStaff } from '#tests/staff-render.tsx'
import {
	ALL_RESERVATION_STATUSES,
	RESERVATION_STATUS_STYLES,
	reservationStatusStyle,
	StatusLabel,
	TABLE_STATE_KEYS,
	TABLE_STATE_STYLES,
	WAITLIST_STATE_STYLES,
} from './status-style.tsx'

const PALETTE = [
	'emerald',
	'amber',
	'sl' + 'ate',
	'sky',
	'blue',
	'red',
	'orange',
	'yellow',
	'gray',
	'zinc',
].join('|')
const RAW = new RegExp(`(${PALETTE})-\\d|#[0-9a-f]{3,6}\\b`, 'i')

describe('status-style', () => {
	it('maps every reservation status the tenant DB can store', () => {
		for (const status of RSV_RESERVATION_STATUS_VALUES) {
			expect(RESERVATION_STATUS_STYLES).toHaveProperty(status)
		}
	})

	it('maps every state-machine status and the legacy ones', () => {
		for (const status of [...RESERVATION_STATUSES, 'completed']) {
			expect(RESERVATION_STATUS_STYLES).toHaveProperty(status)
		}
		expect(Object.keys(RESERVATION_STATUS_STYLES).sort()).toEqual(
			[...ALL_RESERVATION_STATUSES].sort(),
		)
	})

	it('maps every waitlist status', () => {
		for (const status of RSV_WAITLIST_STATUS_VALUES) {
			expect(WAITLIST_STATE_STYLES).toHaveProperty(status)
		}
	})

	it('maps every live table state the day feed can send', () => {
		const fromFeed: LiveTableState['status'][] = [
			'open',
			'reserved_soon',
			'seated',
			'entree',
			'dessert',
			'check_dropped',
			'bussing',
			'blocked',
		]
		for (const status of [...fromFeed, ...TABLE_STATE_KEYS]) {
			expect(TABLE_STATE_STYLES).toHaveProperty(status)
		}
	})

	it('has a label for every style, and uses semantic tokens only', () => {
		const all = [
			...Object.values(RESERVATION_STATUS_STYLES),
			...Object.values(TABLE_STATE_STYLES),
			...Object.values(WAITLIST_STATE_STYLES),
		]
		for (const s of all) {
			expect(s.label.message).toBeTruthy()
			expect(`${s.dot} ${s.text} ${s.surface} ${s.surfaceText}`).not.toMatch(
				RAW,
			)
		}
	})

	it('follows the C6 grouping', () => {
		expect(reservationStatusStyle('seated').tone).toBe('success')
		expect(reservationStatusStyle('arrived').tone).toBe('primary')
		expect(reservationStatusStyle('requested').tone).toBe('warning')
		expect(reservationStatusStyle('no_show').tone).toBe('destructive')
		expect(reservationStatusStyle('cancelled').strike).toBe(true)
		expect(reservationStatusStyle('nope').tone).toBe('neutral')
	})

	it('renders a dot and the translated word', () => {
		renderStaff(<StatusLabel status="seated" testId="s" />)
		expect(screen.getByTestId('s')).toHaveTextContent('Seated')
		expect(screen.getByTestId('s')).toHaveAttribute(
			'data-status-tone',
			'success',
		)
	})
})
