// @vitest-environment jsdom
import { fireEvent, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { FloorPlanCanvas } from '#app/components/reservations/floor-plan-canvas.tsx'
import {
	type DiningAreaDto,
	type FloorElementDto,
	type TableDto,
} from '#app/utils/reservations/setup-api.ts'
import { renderStaff as renderWithI18n } from '#tests/staff-render.tsx'

const SAMPLE_AREAS: DiningAreaDto[] = [
	{
		id: 'area-main',
		locationId: 'loc-1',
		name: 'Main Dining',
		nameI18n: { en: 'Main Dining' },
		floorLabel: 'Ground',
		sortOrder: 0,
		isOutdoor: false,
		isBookableOnline: true,
		onlinePriority: 0,
		isActive: true,
		archivedAt: null,
		version: 1,
	},
	{
		id: 'area-patio',
		locationId: 'loc-1',
		name: 'Patio',
		nameI18n: { en: 'Patio' },
		floorLabel: 'Outdoor',
		sortOrder: 1,
		isOutdoor: true,
		isBookableOnline: true,
		onlinePriority: 1,
		isActive: true,
		archivedAt: null,
		version: 1,
	},
]

const SAMPLE_TABLES: TableDto[] = [
	{
		id: 'table-1',
		locationId: 'loc-1',
		areaId: 'area-main',
		label: 'T1',
		minCovers: 2,
		maxCovers: 4,
		shape: 'round',
		x: 100,
		y: 120,
		width: 60,
		height: 60,
		rotation: 0,
		combinable: true,
		isBookableOnline: true,
		isAccessible: false,
		isHighTop: false,
		isPatio: false,
		resetBufferMin: 15,
		priority: 0,
		notes: null,
		isActive: true,
		archivedAt: null,
		version: 1,
	},
	{
		id: 'table-2',
		locationId: 'loc-1',
		areaId: 'area-main',
		label: 'T2',
		minCovers: 4,
		maxCovers: 6,
		shape: 'rect',
		x: 240,
		y: 120,
		width: 90,
		height: 60,
		rotation: 0,
		combinable: true,
		isBookableOnline: true,
		isAccessible: true,
		isHighTop: false,
		isPatio: false,
		resetBufferMin: 15,
		priority: 1,
		notes: null,
		isActive: true,
		archivedAt: null,
		version: 1,
	},
]

const SAMPLE_ELEMENTS: FloorElementDto[] = [
	{
		id: 'el-1',
		locationId: 'loc-1',
		areaId: 'area-main',
		kind: 'bar',
		label: 'Main Bar',
		x: 400,
		y: 80,
		width: 140,
		height: 50,
		rotation: 0,
		style: {},
	},
]

describe('FloorPlanCanvas', () => {
	it('renders the floor plan canvas with dir="ltr", nudges selected table via keyboard arrows (+1 and +10 with Shift), and announces coordinates via aria-live', () => {
		const onSave = vi.fn(async () => {})
		const onDiscard = vi.fn()

		renderWithI18n(
			<FloorPlanCanvas
				locationName="Downtown"
				floorPlanVersion={4}
				areas={SAMPLE_AREAS}
				tables={SAMPLE_TABLES}
				elements={SAMPLE_ELEMENTS}
				canWrite={true}
				saving={false}
				conflictMessage={null}
				onSave={onSave}
				onReloadLatest={vi.fn()}
				onLeave={onDiscard}
			/>,
		)

		const canvas = screen.getByTestId('floor-plan-canvas-surface')
		expect(canvas.getAttribute('dir')).toBe('ltr')

		// Select table T1
		const tableNode = screen.getByTestId('floor-table-T1')
		fireEvent.click(tableNode)

		// ArrowRight nudges x by +1 (100 -> 101)
		fireEvent.keyDown(tableNode, { key: 'ArrowRight' })
		const liveRegion = screen.getByTestId('floor-plan-live-region')
		expect(liveRegion.textContent).toContain('T1')
		expect(liveRegion.textContent).toContain('101')
		expect(liveRegion.textContent).toContain('120')

		// Shift+ArrowDown nudges y by +10 (120 -> 130)
		fireEvent.keyDown(tableNode, { key: 'ArrowDown', shiftKey: true })
		expect(liveRegion.textContent).toContain('101')
		expect(liveRegion.textContent).toContain('130')

		// Rotate 90 deg via quick button
		fireEvent.click(screen.getByRole('button', { name: '90°' }))

		// Draft was not auto-saved
		expect(onSave).not.toHaveBeenCalled()

		// Explicit Save sends expectedFloorPlanVersion and updated table coordinates
		fireEvent.click(screen.getByTestId('floor-plan-save-button'))
		expect(onSave).toHaveBeenCalledTimes(1)
		const saveArg = (onSave.mock.calls[0] as any)?.[0]
		expect(saveArg.expectedFloorPlanVersion).toBe(4)
		const savedT1 = saveArg.tables.find((t: TableDto) => t.label === 'T1')
		expect(savedT1).toMatchObject({
			x: 101,
			y: 130,
			rotation: 90,
		})
	})

	it('discards unsaved changes when clicking Leave without saving and shows 409 stale-version banner when conflictMessage is set', () => {
		const onSave = vi.fn(async () => {})
		const onReloadLatest = vi.fn()
		const onLeave = vi.fn()

		renderWithI18n(
			<FloorPlanCanvas
				locationName="Downtown"
				floorPlanVersion={5}
				areas={SAMPLE_AREAS}
				tables={SAMPLE_TABLES}
				elements={SAMPLE_ELEMENTS}
				canWrite={true}
				saving={false}
				conflictMessage="This floor plan was updated by another operator."
				onSave={onSave}
				onReloadLatest={onReloadLatest}
				onLeave={onLeave}
			/>,
		)

		// Conflict banner is visible
		expect(
			screen.getByTestId('floor-plan-conflict-banner').textContent,
		).toContain('This floor plan was updated by another operator.')

		// Select T1 and nudge it
		const tableNode = screen.getByTestId('floor-table-T1')
		fireEvent.click(tableNode)
		fireEvent.keyDown(tableNode, { key: 'ArrowRight', shiftKey: true })

		// Click Discard draft changes
		fireEvent.click(screen.getByTestId('floor-plan-discard-button'))
		expect(onSave).not.toHaveBeenCalled()

		// Click Reload latest
		fireEvent.click(screen.getByTestId('floor-plan-reload-button'))
		expect(onReloadLatest).toHaveBeenCalledTimes(1)
	})

	it('disables mutation controls when canWrite is false (read-only operator)', () => {
		renderWithI18n(
			<FloorPlanCanvas
				locationName="Downtown"
				floorPlanVersion={2}
				areas={SAMPLE_AREAS}
				tables={SAMPLE_TABLES}
				elements={SAMPLE_ELEMENTS}
				canWrite={false}
				saving={false}
				conflictMessage={null}
				onSave={vi.fn(async () => {})}
				onReloadLatest={vi.fn()}
				onLeave={vi.fn()}
			/>,
		)

		const saveButton = screen.getByTestId('floor-plan-save-button')
		expect(saveButton).toBeDisabled()
		expect(screen.queryByTestId('floor-plan-add-table-button')).toBeNull()
	})
})
