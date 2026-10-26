// @vitest-environment jsdom
import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { createElement as h, act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { entry, MIN, at } from './testing.ts'
import { WaitlistSheet } from './WaitlistSheet.tsx'

;(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

beforeEach(() => {
	HTMLDialogElement.prototype.showModal = function showModal() {
		this.setAttribute('open', '')
	}
	HTMLDialogElement.prototype.close = function close() {
		this.removeAttribute('open')
	}
})

const NOW = at(13 * 60)
let host: HTMLDivElement
let root: Root
beforeEach(() => {
	host = document.createElement('div')
	document.body.appendChild(host)
	root = createRoot(host)
})
afterEach(() => {
	act(() => root.unmount())
	host.remove()
})

type Props = ComponentProps<typeof WaitlistSheet>
const fmt = new Intl.DateTimeFormat('en', {
	hour: 'numeric',
	minute: '2-digit',
	timeZone: 'UTC',
})
const base = (over: Partial<Props> = {}): Props => ({
	entry: null,
	canReadGuest: true,
	busy: false,
	now: NOW,
	formatTime: (ms) => fmt.format(ms),
	onNotify: () => undefined,
	onPlace: () => undefined,
	onRemove: () => undefined,
	onBack: () => undefined,
	onClose: () => undefined,
	...over,
})
const draw = (props: Props) =>
	// eslint-disable-next-line testing-library/no-unnecessary-act
	act(() => {
		root.render(h(I18nProvider, { i18n }, h(WaitlistSheet, props)))
	})
const dialog = () => host.querySelector('dialog')!
const button = (label: string) =>
	[...dialog().querySelectorAll('button')].find(
		(b) => b.textContent?.trim() === label,
	)
const press = (label: string) =>
	act(() => {
		const target = button(label)
		if (!target) throw new Error(`no button "${label}"`)
		target.click()
	})
const hasText = (text: string) => dialog().textContent?.includes(text) ?? false
const links = () =>
	[...dialog().querySelectorAll('a[href]')].map((a) => a.getAttribute('href')!)

const told = (over: Parameters<typeof entry>[0] = {}) =>
	entry({
		status: 'notified',
		phone: '+14155550132',
		smsOptIn: true,
		notifiedAt: NOW - 4 * MIN,
		responseDeadlineAt: NOW + 6 * MIN,
		displayName: 'Amira Saad',
		...over,
	})

describe('what the sheet says about being told', () => {
	it('says a text is on its way only when the answer said one was queued', () => {
		draw(base({ entry: told(), textQueued: true }))
		expect(hasText('Told 12:56 PM · text on its way')).toBe(true)
		expect(hasText('text sent')).toBe(false)
		expect(hasText('call them')).toBe(false)
	})
	it('says no text was sent, and makes Call the way to reach them', () => {
		draw(base({ entry: told(), textQueued: false }))
		expect(hasText('Told 12:56 PM · no text sent, call them')).toBe(true)
		expect(links()).toContain('tel:+14155550132')
		const call = [...dialog().querySelectorAll('a')].find((a) =>
			a.getAttribute('href')?.startsWith('tel:'),
		)!
		expect(call.className).toContain('bg-primary')
	})
	it('says only "Told" when the answer did not say (an older server)', () => {
		draw(base({ entry: told(), textQueued: undefined }))
		expect(hasText('Told 12:56 PM')).toBe(true)
		expect(hasText('text sent')).toBe(false)
		expect(hasText('Texted')).toBe(false)
	})
	it('knows a party that could not be texted was not, with no answer to go on', () => {
		draw(
			base({
				entry: told({ smsOptIn: false }),
				textQueued: undefined,
			}),
		)
		expect(hasText('no text sent, call them')).toBe(true)
	})
})

describe('telling a party their table is ready', () => {
	it('works for a party who agreed to texts', () => {
		const onNotify = vi.fn()
		const waiting = entry({
			phone: '+14155550132',
			smsOptIn: true,
			displayName: 'Theo',
		})
		draw(base({ entry: waiting, onNotify }))
		expect(button('Tell them it’s ready')).toBeDefined()
		press('Tell them it’s ready')
		expect(onNotify).toHaveBeenCalledWith(waiting)
	})
	it('is "Mark ready" for a party who cannot be texted, and still works, saying nothing will be sent', () => {
		const onNotify = vi.fn()
		const waiting = entry({
			phone: '+14155550132',
			smsOptIn: false,
			displayName: 'Wei',
		})
		draw(base({ entry: waiting, onNotify }))
		expect(button('Tell them it’s ready')).toBeUndefined()
		const mark = button('Mark ready')!
		expect(mark.disabled).toBe(false)
		expect(hasText('No SMS consent: no text will be sent. Call them.')).toBe(
			true,
		)
		press('Mark ready')
		expect(onNotify).toHaveBeenCalledWith(waiting)
	})
	it('is "Mark ready" for a party with no number too', () => {
		draw(base({ entry: entry({ phone: null }) }))
		expect(button('Mark ready')!.disabled).toBe(false)
		expect(hasText('No phone number: nothing to text.')).toBe(true)
	})
})

describe('taking a party off the list', () => {
	it('records a hold that ran out as no response', () => {
		const onRemove = vi.fn()
		const expired = told({ responseDeadlineAt: NOW - MIN, version: 7 })
		draw(base({ entry: expired, onRemove }))
		press('No response, remove')
		expect(onRemove).not.toHaveBeenCalled()
		press('Tap again: remove')
		expect(onRemove).toHaveBeenCalledWith(expired, 7, 'no_response')
	})
	it('records a party that left as left', () => {
		const onRemove = vi.fn()
		const waiting = entry({ version: 3 })
		draw(base({ entry: waiting, onRemove }))
		press('They left')
		press('Tap again: remove')
		expect(onRemove).toHaveBeenCalledWith(waiting, 3, 'left')
		// A party still holding their table who is taken off by hand left, too.
		const holding = told({ version: 4 })
		draw(base({ entry: holding, onRemove }))
		press('They left')
		press('Tap again: remove')
		expect(onRemove).toHaveBeenLastCalledWith(holding, 4, 'left')
	})
	it('sends the version the host saw when they armed it', () => {
		const onRemove = vi.fn()
		const first = entry({ id: 'w-x', version: 3 })
		draw(base({ entry: first, onRemove }))
		press('They left')
		// Another host changes the entry while the button is armed: it disarms.
		const changed = { ...first, version: 4 }
		draw(base({ entry: changed, onRemove }))
		expect(button('Tap again: remove')).toBeUndefined()
		press('They left')
		press('Tap again: remove')
		// The second round was armed against version 4: that is what is sent.
		expect(onRemove).toHaveBeenCalledTimes(1)
		expect(onRemove).toHaveBeenCalledWith(changed, 4, 'left')
	})
	it('does not send a version that moved between the two taps', () => {
		const onRemove = vi.fn()
		const first = entry({ id: 'w-y', version: 3 })
		draw(base({ entry: first, onRemove }))
		press('They left')
		draw(base({ entry: { ...first, version: 5 }, onRemove }))
		// Disarmed: a stray second tap lands on the first-tap state and sends nothing.
		press('They left')
		expect(onRemove).not.toHaveBeenCalled()
	})
})

describe('putting a party back in line', () => {
	it('is offered to a party told their table is ready, with the version seen', () => {
		const onBack = vi.fn()
		const holding = told({ version: 6 })
		draw(base({ entry: holding, onBack }))
		press('Back in line')
		expect(onBack).toHaveBeenCalledWith(holding, 6)
		// Still can be seated, and can still be taken off.
		expect(button('Choose a table')).toBeDefined()
		expect(button('They left')).toBeDefined()
	})
	it('is offered when the hold ran out too, beside "No response, remove"', () => {
		const onBack = vi.fn()
		const expired = told({ responseDeadlineAt: NOW - MIN, version: 7 })
		draw(base({ entry: expired, onBack }))
		expect(button('No response, remove')).toBeDefined()
		press('Back in line')
		expect(onBack).toHaveBeenCalledWith(expired, 7)
	})
	it('is not offered to a party still waiting their turn', () => {
		draw(base({ entry: entry() }))
		expect(button('Back in line')).toBeUndefined()
	})
	it('is the only way on for a party the server already took off the line', () => {
		const onBack = vi.fn()
		const gone = entry({
			status: 'no_response',
			phone: '+14155550132',
			smsOptIn: true,
			notifiedAt: NOW - 14 * MIN,
			responseDeadlineAt: NOW - 4 * MIN,
			version: 9,
		})
		draw(base({ entry: gone, onBack }))
		expect(hasText('Did not respond')).toBe(true)
		expect(hasText('they left the line')).toBe(true)
		expect(button('Choose a table')).toBeUndefined()
		expect(button('They left')).toBeUndefined()
		expect(button('Mark ready')).toBeUndefined()
		press('Back in line')
		expect(onBack).toHaveBeenCalledWith(gone, 9)
	})
})

describe('saying plainly when a hold ends', () => {
	it('says when it ends and that they leave the line then', () => {
		draw(base({ entry: told() }))
		expect(hasText('Holds until 1:06 PM, then they leave the line')).toBe(true)
	})
	it('says it ended with no response once it has', () => {
		draw(base({ entry: told({ responseDeadlineAt: NOW - MIN }) }))
		expect(hasText('No response by 12:59 PM')).toBe(true)
	})
	it('keeps one live region for the end of the hold, so it is announced when it comes', () => {
		draw(base({ entry: told() }))
		const region = dialog().querySelector('[role="status"]')!
		expect(region.textContent).toBe('')
		// The same sheet a minute later, past the end: the same region now says so.
		draw(base({ entry: told({ responseDeadlineAt: NOW - MIN }), now: NOW }))
		expect(dialog().querySelector('[role="status"]')).toBe(region)
		expect(region.textContent).toContain('No response by')
	})
})
