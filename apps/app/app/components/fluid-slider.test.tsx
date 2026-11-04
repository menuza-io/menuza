// @vitest-environment jsdom

import { FluidSlider } from '@repo/ui/fluid-slider'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

beforeEach(() => {
	vi.stubGlobal(
		'matchMedia',
		vi.fn(() => ({
			matches: false,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
		})),
	)
})

describe('FluidSlider', () => {
	it('shows the label and the formatted value', () => {
		render(
			<FluidSlider
				variant="scrubber"
				label="Brightness"
				min={50}
				max={150}
				value={100}
				formatValue={(value) => `${value}%`}
				onChange={() => {}}
			/>,
		)
		expect(screen.getAllByText('Brightness').length).toBeGreaterThan(0)
		expect(screen.getByText('100%')).toBeTruthy()
	})

	it('exposes a named slider thumb that the arrow keys move', () => {
		const onChange = vi.fn()
		render(
			<FluidSlider
				variant="scrubber"
				label="Contrast"
				min={50}
				max={150}
				value={100}
				onChange={onChange}
			/>,
		)
		const thumb = screen.getByRole('slider', { name: 'Contrast' })
		expect(thumb.getAttribute('aria-valuenow')).toBe('100')
		fireEvent.keyDown(thumb, { key: 'ArrowRight' })
		expect(onChange).toHaveBeenCalledWith(101)
	})

	it('does not respond when disabled', () => {
		const onChange = vi.fn()
		const { container } = render(
			<FluidSlider
				variant="scrubber"
				label="Grayscale"
				value={0}
				disabled
				onChange={onChange}
			/>,
		)
		const row = container.querySelector('.cursor-ew-resize')
		if (row) fireEvent.pointerDown(row, { clientX: 10, pointerType: 'mouse' })
		expect(onChange).not.toHaveBeenCalled()
	})

	it('never renders NaN when min equals max', () => {
		const { container } = render(
			<FluidSlider
				variant="scrubber"
				label="Fixed"
				min={5}
				max={5}
				value={5}
				onChange={() => {}}
			/>,
		)
		const row = container.querySelector('.cursor-ew-resize')
		if (!row) throw new Error('row not found')
		fireEvent.pointerDown(row, { clientX: 10, pointerType: 'mouse' })
		expect(container.innerHTML).not.toContain('NaN')
	})

	it('names the slider from aria-label when there is no visible label', () => {
		render(
			<FluidSlider
				variant="scrubber"
				aria-label="Volume"
				value={10}
				onChange={() => {}}
			/>,
		)
		expect(screen.getByRole('slider', { name: 'Volume' })).toBeTruthy()
	})

	it('moves to the ends with Home and End', () => {
		const onChange = vi.fn()
		render(
			<FluidSlider
				variant="scrubber"
				label="Level"
				min={0}
				max={100}
				value={50}
				onChange={onChange}
			/>,
		)
		const thumb = screen.getByRole('slider', { name: 'Level' })
		fireEvent.keyDown(thumb, { key: 'Home' })
		expect(onChange).toHaveBeenLastCalledWith(0)
		fireEvent.keyDown(thumb, { key: 'End' })
		expect(onChange).toHaveBeenLastCalledWith(100)
	})

	it('reports the formatted value to assistive technology and forwards the description', () => {
		render(
			<>
				<p id="hint">Adjusts the exposure</p>
				<FluidSlider
					variant="scrubber"
					label="Brightness"
					min={50}
					max={150}
					value={120}
					formatValue={(value) => `${value}%`}
					aria-describedby="hint"
					onChange={() => {}}
				/>
			</>,
		)
		const thumb = screen.getByRole('slider', { name: 'Brightness' })
		expect(thumb.getAttribute('aria-valuetext')).toBe('120%')
		expect(thumb.getAttribute('aria-describedby')).toBe('hint')
	})

	it('runs a caller pointer handler as well as its own', () => {
		const onChange = vi.fn()
		const onPointerDown = vi.fn()
		const { container } = render(
			<FluidSlider
				variant="scrubber"
				label="Level"
				min={0}
				max={100}
				value={0}
				onPointerDown={onPointerDown}
				onChange={onChange}
			/>,
		)
		const row = container.querySelector('.cursor-ew-resize.relative')
		if (!row) throw new Error('row not found')
		row.getBoundingClientRect = () =>
			({
				left: 0,
				width: 100,
				top: 0,
				height: 32,
				right: 100,
				bottom: 32,
			}) as DOMRect
		fireEvent.pointerDown(row, { clientX: 50, pointerType: 'mouse', button: 0 })
		expect(onPointerDown).toHaveBeenCalledTimes(1)
		expect(onChange).toHaveBeenCalledWith(50)
	})

	it('never offers a pip past the maximum', () => {
		const onChange = vi.fn()
		const { container } = render(
			<FluidSlider
				variant="pips"
				label="Steps"
				min={0}
				max={10}
				step={6}
				value={0}
				onChange={onChange}
			/>,
		)
		const row = container.querySelector('.cursor-ew-resize.relative')
		if (!row) throw new Error('row not found')
		row.getBoundingClientRect = () =>
			({
				left: 0,
				width: 100,
				top: 0,
				height: 32,
				right: 100,
				bottom: 32,
			}) as DOMRect
		fireEvent.pointerDown(row, {
			clientX: 100,
			pointerType: 'mouse',
			button: 0,
		})
		expect(onChange).toHaveBeenCalledWith(6)
		for (const call of onChange.mock.calls) {
			expect(call[0] as number).toBeLessThanOrEqual(10)
		}
	})

	it('keeps keyboard changes inside the range when min equals max', () => {
		const onChange = vi.fn()
		render(
			<FluidSlider
				variant="scrubber"
				label="Fixed"
				min={5}
				max={5}
				value={5}
				onChange={onChange}
			/>,
		)
		const thumb = screen.getByRole('slider', { name: 'Fixed' })
		fireEvent.keyDown(thumb, { key: 'ArrowRight' })
		fireEvent.keyDown(thumb, { key: 'End' })
		for (const call of onChange.mock.calls) expect(call[0]).toBe(5)
	})
})
