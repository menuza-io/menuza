// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	closeSiteDisclosure,
	mountSiteInteractions,
	nearestNavItem,
} from './site-interactions'

let dispose: (() => void) | undefined
let reduced = false
let hover = true

beforeEach(() => {
	vi.useFakeTimers()
	reduced = false
	hover = true
	vi.stubGlobal('matchMedia', (query: string) => ({
		matches: query.includes('hover') ? hover : reduced,
	}))
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

	it('closes dropdowns when keyboard focus leaves them', () => {
		const { details, trigger, panel } = disclosure()
		const link = document.createElement('a')
		link.href = '#profile'
		panel.append(link)
		const after = document.createElement('button')
		document.body.append(after)
		dispose = mountSiteInteractions()
		trigger.click()
		link.focus()
		expect(trigger.getAttribute('aria-expanded')).toBe('true')
		after.focus()
		expect(trigger.getAttribute('aria-expanded')).toBe('false')
		vi.runAllTimers()
		expect(details.open).toBe(false)
	})

	it('keeps menus that survive a content update open', () => {
		const { details, trigger } = disclosure()
		dispose = mountSiteInteractions()
		trigger.click()
		document.dispatchEvent(new Event('sites:content-updated'))
		expect(details.dataset.open).toBe('true')
		trigger.click()
		vi.runAllTimers()
		expect(details.open).toBe(false)
	})

	it('closes through the close request, enhanced or not', () => {
		const enhanced = disclosure()
		dispose = mountSiteInteractions()
		enhanced.trigger.click()
		closeSiteDisclosure(enhanced.details)
		expect(enhanced.trigger.getAttribute('aria-expanded')).toBe('false')
		vi.runAllTimers()
		expect(enhanced.details.open).toBe(false)
		const plain = document.createElement('details')
		plain.open = true
		closeSiteDisclosure(plain)
		expect(plain.open).toBe(false)
	})

	it('leaves closed FAQ answers findable and follows native toggles', () => {
		const { details, trigger, panel } = disclosure(false)
		dispose = mountSiteInteractions()
		expect(panel.inert).toBeFalsy()
		trigger.click()
		trigger.click()
		vi.runAllTimers()
		expect(details.open).toBe(false)
		expect(panel.inert).toBe(false)
		// Find-in-page expands a closed <details> natively.
		details.open = true
		details.dispatchEvent(new Event('toggle'))
		expect(details.dataset.open).toBe('true')
		expect(trigger.getAttribute('aria-expanded')).toBe('true')
		details.open = false
		details.dispatchEvent(new Event('toggle'))
		expect(details.dataset.open).toBe('false')
		expect(panel.inert).toBe(false)
	})

	it('ignores a stale open toggle while the exit runs', () => {
		const { details, trigger } = disclosure(false)
		dispose = mountSiteInteractions()
		trigger.click()
		trigger.click()
		details.dispatchEvent(new Event('toggle'))
		expect(trigger.getAttribute('aria-expanded')).toBe('false')
		vi.runAllTimers()
		expect(details.open).toBe(false)
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

describe('fluid navigation mounting', () => {
	function nav(tag: 'nav' | 'ul') {
		vi.stubGlobal(
			'ResizeObserver',
			class {
				observe() {}
				disconnect() {}
			},
		)
		const container = document.createElement(tag)
		container.dataset.fluidNav = 'x'
		const link = document.createElement('a')
		link.href = '#menu'
		const rect = {
			left: 0,
			right: 80,
			top: 0,
			bottom: 44,
			width: 80,
			height: 44,
		}
		link.getClientRects = () => [rect] as unknown as DOMRectList
		link.getBoundingClientRect = () => rect as DOMRect
		if (tag === 'ul') {
			const item = document.createElement('li')
			item.append(link)
			container.append(item)
		} else container.append(link)
		container.getBoundingClientRect = () =>
			({ left: 0, top: 0, width: 200, height: 44 }) as DOMRect
		document.body.append(container)
		const followed = vi.fn((event: Event) => event.preventDefault())
		link.addEventListener('click', followed)
		return { container, link, followed }
	}

	it('keeps list content valid with a hidden list item highlight', () => {
		const list = nav('ul')
		const plain = nav('nav')
		dispose = mountSiteInteractions()
		const highlight = list.container.firstElementChild
		expect(highlight?.tagName).toBe('LI')
		expect(highlight?.getAttribute('aria-hidden')).toBe('true')
		expect(plain.container.firstElementChild?.tagName).toBe('SPAN')
	})

	it('forwards gap clicks only for hover pointers', () => {
		const { container, followed } = nav('nav')
		dispose = mountSiteInteractions()
		const gap = () =>
			container.dispatchEvent(
				new MouseEvent('click', { bubbles: true, clientX: 84, clientY: 20 }),
			)
		hover = false
		gap()
		expect(followed).not.toHaveBeenCalled()
		hover = true
		gap()
		expect(followed).toHaveBeenCalledTimes(1)
	})

	it('does not activate a link twice when it is clicked directly', () => {
		const { link, followed } = nav('nav')
		dispose = mountSiteInteractions()
		link.click()
		expect(followed).toHaveBeenCalledTimes(1)
	})
})
