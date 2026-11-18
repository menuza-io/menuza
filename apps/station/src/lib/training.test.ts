 
// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import Dexie from 'dexie'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type PosSettings } from './config.ts'
import { type OrderDraft } from './orders.ts'
import { TRAINING_DB_NAME, TRAINING_FLAG_KEY } from './training-flag.ts'

const settings = {
	appUrl: 'https://app.test',
	slug: 'demo',
	tenantApiUrl: 'https://api.test',
	terminalCode: 'T1',
	locationId: 'loc-1',
	locationLocked: false,
	scopeId: 'main',
	signInRequired: false,
	dayStartMinutes: 0,
	shiftsRequired: false,
	idleLockSeconds: 120,
	deviceToken: 'device-secret',
	deviceLabel: 'Front counter',
	demo: false,
	locale: null,
	apps: { timeclock: true, reservations: true, inventory: true, orders: true },
	activeApp: 'kitchen',
} as PosSettings

const draft: OrderDraft = {
	terminalCode: 'T1',
	locationId: 'loc-1',
	currency: 'USD',
	taxRatePercent: 10,
	orderType: 'dine_in',
	customerName: '',
	tableLabel: '4',
	lines: [
		{
			id: 'l1',
			itemId: 'burger',
			name: 'Burger',
			variantId: null,
			variantLabel: null,
			quantity: 1,
			baseCents: 1000,
			instructions: '',
			options: [],
		},
	],
	adjustments: [],
	tipCents: 0,
}

/** A fresh copy of the modules, as a page load would see them. */
async function load() {
	vi.resetModules()
	const db = await import('./db.ts')
	const training = await import('./training.ts')
	const orders = await import('./orders.ts')
	const outbox = await import('./outbox.ts')
	const config = await import('./config.ts')
	return { ...db, ...training, ...orders, ...outbox, ...config }
}

beforeEach(async () => {
	localStorage.clear()
	await Dexie.delete('pos')
	await Dexie.delete(TRAINING_DB_NAME)
})
afterEach(() => vi.unstubAllGlobals())

describe('training mode (#383)', () => {
	it('is off by default and uses the real store', async () => {
		const m = await load()
		expect(m.isTrainingMode()).toBe(false)
		expect(m.db.name).toBe('pos')
	})

	it('starts a practice till with the menu and the people who may sign in, and nothing real', async () => {
		const live = await load()
		await live.db.catalog.put({ key: 'menu', fetchedAt: 1 } as never)
		await live.db.staff.put({
			id: 's1',
			name: 'Sam L.',
			role: 'manager',
			key: 'k',
			cachedAt: 1,
		})
		await live.db.meta.bulkPut([
			{ key: 'pin-salt', value: 'salt' },
			{ key: 'zatca-unit', value: { privateKey: 'secret' } },
			{ key: 'fiscal-heads', value: [{ counter: 9 }] },
		])
		const real = await live.createOrder(draft)
		const reload = vi.fn()
		await live.enterTraining(reload)
		expect(reload).toHaveBeenCalledTimes(1)
		expect(localStorage.getItem(TRAINING_FLAG_KEY)).toBe('1')

		const training = new live.PosDatabase(TRAINING_DB_NAME)
		expect(await training.catalog.count()).toBe(1)
		expect(await training.staff.count()).toBe(1)
		// The salt makes offline PIN sign-in work; the ZATCA key and the fiscal
		// chain stay with the real till.
		expect((await training.meta.toArray()).map((row) => row.key)).toEqual([
			'pin-salt',
		])
		expect(await training.orders.count()).toBe(0)
		expect(await training.shifts.count()).toBe(0)
		training.close()
		// The real store is untouched.
		expect(await live.db.orders.get(real.id)).toBeTruthy()
	})

	it('keeps a training order away from the real store, and out of the server, always', async () => {
		const fetchMock = vi.fn(async () => Response.json({ order: {} }))
		vi.stubGlobal('fetch', fetchMock)
		localStorage.setItem(TRAINING_FLAG_KEY, '1')
		const m = await load()
		expect(m.isTrainingMode()).toBe(true)
		expect(m.db.name).toBe(TRAINING_DB_NAME)
		const order = await m.createOrder(draft)
		const paid = await m.addPayment(order.id, {
			method: 'cash',
			amountCents: 1100,
			tenderedCents: 1100,
			changeCents: 0,
		})
		expect(paid.sync).toBe('pending')
		// Whatever asks to send it, nothing goes out.
		expect(await m.flushOutbox(settings, { force: true })).toBe(0)
		expect(fetchMock).not.toHaveBeenCalled()
		expect((await m.db.orders.get(order.id))?.sync).toBe('pending')
		// And the real database never saw it.
		const real = new m.PosDatabase('pos')
		expect(await real.orders.count()).toBe(0)
		real.close()
	})

	it('does send the same order when not in training (the check above would notice)', async () => {
		const fetchMock = vi.fn(async () =>
			Response.json({ order: { number: 'T1-0001' } }),
		)
		vi.stubGlobal('fetch', fetchMock)
		const m = await load()
		const order = await m.createOrder(draft)
		await m.addPayment(order.id, {
			method: 'cash',
			amountCents: 1100,
			tenderedCents: 1100,
			changeCents: 0,
		})
		expect(await m.flushOutbox(settings, { force: true })).toBe(1)
		expect(fetchMock).toHaveBeenCalled()
	})

	it('shows only the till: every other app acts on real data', async () => {
		const real = await load()
		expect(real.shownApp(settings)).toBe('kitchen')
		localStorage.setItem(TRAINING_FLAG_KEY, '1')
		const m = await load()
		expect(m.shownApp(settings)).toBe('pos')
	})

	it('turning it off deletes everything made in training and the flag, and leaves the real till alone', async () => {
		const live = await load()
		const real = await live.createOrder(draft)
		await live.enterTraining(vi.fn())
		const training = new live.PosDatabase(TRAINING_DB_NAME)
		await training.open()
		await training.orders.put({ ...real, id: 'practice', number: 'T1-0099' })
		training.close()
		expect(await Dexie.exists(TRAINING_DB_NAME)).toBe(true)

		const m = await load()
		expect(m.isTrainingMode()).toBe(true)
		const reload = vi.fn()
		await m.leaveTraining(reload)
		expect(reload).toHaveBeenCalledTimes(1)
		expect(localStorage.getItem(TRAINING_FLAG_KEY)).toBeNull()
		expect(await Dexie.exists(TRAINING_DB_NAME)).toBe(false)
		const after = await load()
		expect(after.isTrainingMode()).toBe(false)
		expect(await after.db.orders.get(real.id)).toBeTruthy()
		expect(await after.db.orders.get('practice')).toBeUndefined()
	})
})

describe('training banner', () => {
	const render = async (training: boolean, children = 'SCREEN') => {
		const { TrainingShell } = await import('../screens/TrainingBanner.tsx')
		i18n.loadAndActivate({ locale: 'en', messages: {} })
		return renderToStaticMarkup(
			h(
				I18nProvider,
				{ i18n },
				h(TrainingShell, { training, children: h('p', null, children) }),
			),
		)
	}

	it('sits above whatever screen is shown, the lock screen and every app included', async () => {
		for (const screen of ['REGISTER', 'LOCK SCREEN', 'KITCHEN', 'ORDERS']) {
			const html = await render(true, screen)
			expect(html).toContain('data-training-banner')
			expect(html).toContain('TRAINING MODE')
			expect(html.indexOf('data-training-banner')).toBeLessThan(
				html.indexOf(screen),
			)
			expect(html).toContain(screen)
		}
	})

	it('adds nothing outside training mode', async () => {
		const html = await render(false)
		expect(html).not.toContain('data-training-banner')
		expect(html).toBe('<p>SCREEN</p>')
	})
})
