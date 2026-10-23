// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mountSiteInteractions, nearestNavItem } from './site-interactions'

let dispose: (() => void) | undefined
let reduced = false

beforeEach(() => {
	vi.useFakeTimers()
	reduced = false
	vi.stubGlobal('matchMedia', () => ({ matches: reduced }))
})

afterEach(() => {
	dispose?.()
	dispose = undefined
	document.body.replaceChildren()
	vi.useRealTimers()
	vi.unstubAllGlobals()
})

function disclosure(dropdown = true) {
	const details = document.createElement('details')
	details.dataset.siteDisclosure = ''
	details.className = dropdown ? '' : 't-acc'
	details.style.setProperty('--dropdown-close-dur', '150ms')
	details.style.setProperty('--acc-collapse', '250ms')
	const trigger = document.createElement('summary')
	trigger.textContent = dropdown ? 'Open menu' : 'Question'
	const panel = document.createElement('div')
	panel.className = dropdown ? 't-dropdown' : 't-acc-panel'
	details.append(trigger, panel)
	document.body.append(details)
	return { details, trigger, panel }
}

describe('native disclosure enhancement', () => {
	it('keeps close animation mounted and cancels it when reopened', () => {
		const { details, trigger, panel } = disclosure()
		dispose = mountSiteInteractions()
		trigger.click()
		expect(details.open).toBe(true)
		expect(trigger.getAttribute('aria-expanded')).toBe('true')
		trigger.click()
		expect(panel.inert).toBe(true)
		expect(trigger.getAttribute('aria-expanded')).toBe('false')
		expect(details.open).toBe(true)
		trigger.click()
		vi.runAllTimers()
		expect(details.open).toBe(true)
		expect(panel.inert).toBe(false)
		expect(panel.classList.contains('is-closing')).toBe(false)
	})

	it('closes dropdowns with Escape and restores trigger focus', () => {
		const { details, trigger, panel } = disclosure()
		const link = document.createElement('a')
		link.href = '#profile'
		panel.append(link)
		dispose = mountSiteInteractions()
		trigger.click()
		link.focus()
		link.dispatchEvent(
			new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
		)
		expect(trigger.matches(':focus')).toBe(true)
		vi.runAllTimers()
		expect(details.open).toBe(false)
	})

	it('closes dropdowns on outside clicks, but leaves FAQs independent', () => {
		const menu = disclosure()
		const faq = disclosure(false)
		dispose = mountSiteInteractions()
		menu.trigger.click()
		faq.trigger.click()
		vi.runAllTimers()
		expect(menu.details.open).toBe(false)
		expect(faq.details.open).toBe(true)
		document.body.click()
		expect(faq.details.open).toBe(true)
	})

	it('cleans up accordion panels after the symmetric collapse duration', () => {
		const { details, trigger } = disclosure(false)
		dispose = mountSiteInteractions()
		trigger.click()
		expect(details.dataset.open).toBe('true')
		trigger.click()
		vi.advanceTimersByTime(249)
		expect(details.open).toBe(true)
		vi.advanceTimersByTime(1)
		expect(details.open).toBe(false)
	})

	it('does not delay dismissal when reduced motion is enabled', () => {
		reduced = true
		const { details, trigger } = disclosure()
		dispose = mountSiteInteractions()
		trigger.click()
		trigger.click()
		expect(details.open).toBe(false)
		expect(details.querySelector('.is-closing')).toBeNull()
	})

	it('rebinds replaced editor previews without duplicate event handlers', () => {
		const first = disclosure()
		dispose = mountSiteInteractions()
		first.details.remove()
		const next = disclosure()
		document.dispatchEvent(new Event('sites:content-updated'))
		document.dispatchEvent(new Event('sites:content-updated'))
		next.trigger.click()
		expect(next.details.open).toBe(true)
		next.trigger.click()
		vi.runAllTimers()
		expect(next.details.open).toBe(false)
	})
})

describe('fluid navigation picking', () => {
	const rects = [
		{ left: 0, right: 80, top: 0, bottom: 44 },
		{ left: 84, right: 184, top: 0, bottom: 44 },
	]
	it('prefers the item containing the pointer', () => {
		expect(nearestNavItem(rects, 100, 20, 'x')).toBe(1)
	})
	it('keeps gaps lit with the nearest item instead of blinking off', () => {
		expect(nearestNavItem(rects, 81, 20, 'x')).toBe(0)
		expect(nearestNavItem(rects, 83, 20, 'x')).toBe(0)
	})
	it('uses physical rectangles correctly in RTL layouts', () => {
		expect(nearestNavItem([...rects].reverse(), 100, 20, 'x')).toBe(0)
	})
	it('returns no item for an empty navigation', () => {
		expect(nearestNavItem([], 0, 0, 'y')).toBe(-1)
	})
})
