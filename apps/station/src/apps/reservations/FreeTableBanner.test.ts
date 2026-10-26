// @vitest-environment jsdom
import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { createElement as h, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type FreeTableOffer } from './freeTable.ts'
import { FreeTableBanner, offerText } from './FreeTableBanner.tsx'
import { day, entry, rsv } from './testing.ts'

;(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

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

const table = day([]).tables[1]!
const offer: FreeTableOffer = {
	table,
	placing: {
		kind: 'waitlist',
		entry: entry({ displayName: 'Sofia', partySize: 4 }),
	},
	size: 4,
	waitedMin: 13,
	key: 't2|w:1',
}
const _ = i18n._.bind(i18n)

describe('the free table offer', () => {
	it('says the same words to the bar and to the news region', () => {
		expect(offerText(_, offer)).toBe(
			'Table 2 is free: Sofia (4, waited 13 min).',
		)
		// eslint-disable-next-line testing-library/no-unnecessary-act
		act(() =>
			root.render(
				h(
					I18nProvider,
					{ i18n },
					h(FreeTableBanner, {
						offer,
						onSeat: () => undefined,
						onDismiss: () => undefined,
					}),
				),
			),
		)
		expect(host.textContent).toContain(offerText(_, offer))
	})
	it('is not a live region of its own: it mounts filled, and the stand’s news region says it at once', () => {
		// eslint-disable-next-line testing-library/no-unnecessary-act
		act(() =>
			root.render(
				h(
					I18nProvider,
					{ i18n },
					h(FreeTableBanner, {
						offer,
						onSeat: () => undefined,
						onDismiss: () => undefined,
					}),
				),
			),
		)
		expect(host.querySelector('[role="status"]')).toBeNull()
	})
	it('says a booking at the stand is at the stand', () => {
		expect(
			offerText(_, {
				...offer,
				placing: {
					kind: 'reservation',
					reservation: rsv({ start: 12 * 60, status: 'arrived' }),
				},
				waitedMin: null,
			}),
		).toContain('at the stand')
	})
})
