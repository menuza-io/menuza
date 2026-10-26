import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_KDS_CONFIG, type KdsFeed } from '@repo/common/kds'
import {
	formatPosDeviceSecret,
	POS_STAFF_SESSION_HEADER,
} from '@repo/common/pos-orders'
import {
	destroyTenantDb,
	getTenantDb,
	kdsEvents,
	posManagers,
	posDevices,
	posOrderRevisions,
	posOrders,
	provisionTenantDb,
	restaurantOrders,
	staffMembers,
	staffScopeAssignments,
} from '@repo/tenant-db'
import { ORG_A, ORG_B, stubStaffEnv } from '../../tests/staff-harness.ts'
import { hashPosSecret } from '../lib/pos-auth.ts'
import { mintPosStaffSession } from '../lib/pos-staff-session.ts'
import { posKdsRoutes } from './pos-kds.ts'

describe('Station kitchen API', () => {
	let dir: string
	const app = new Hono().route('/pos/kds', posKdsRoutes)
	let secret: string
	let deviceId: string
	let orderId: string
	const line = {
		id: crypto.randomUUID(),
		itemId: 'burger',
		name: 'Burger',
		quantity: 2,
		variantLabel: 'Large',
		instructions: 'No onion',
		options: [{ optionName: 'Cheese', quantity: 1 }],
	}

	beforeEach(async () => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'station-kds-'))
		stubStaffEnv(dir)
		vi.stubEnv('POS_ENABLED', '')
		for (const org of [ORG_A, ORG_B]) await provisionTenantDb(org)
		const db = await getTenantDb(ORG_A)
		deviceId = crypto.randomUUID()
		secret = formatPosDeviceSecret(ORG_A, deviceId, 'x'.repeat(43))
		await db.insert(posDevices).values({
			id: deviceId,
			label: 'Kitchen',
			terminalCode: 'K1',
			locationId: 'loc-1',
			secretHash: hashPosSecret(secret),
			pairedBy: 'operator',
		})
		orderId = crypto.randomUUID()
		await db.insert(posOrders).values({
			id: orderId,
			deviceId,
			number: 'T1-0001',
			businessDate: '2026-10-23',
			revision: 1,
			status: 'paid',
			orderType: 'dine_in',
			locationId: 'loc-1',
			guestName: 'Private guest',
			customerPhone: '+15551234567',
			staffName: 'Private staff',
			tableLabel: '12',
			currency: 'USD',
			subtotalCents: 2000,
			taxCents: 0,
			totalCents: 2000,
			lines: [line],
			adjustments: [],
			rungUpAt: Date.now(),
		})
	})
	afterEach(async () => {
		for (const org of [ORG_A, ORG_B]) await destroyTenantDb(org)
		fs.rmSync(dir, { recursive: true, force: true })
		vi.unstubAllEnvs()
	})

	async function request(
		method = 'GET',
		suffix = '',
		body?: unknown,
		token = secret,
		staffSession?: string,
	) {
		return app.request(`/pos/kds${suffix}`, {
			method,
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json',
				...(staffSession ? { [POS_STAFF_SESSION_HEADER]: staffSession } : {}),
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		})
	}
	async function feed() {
		return (await (await request()).json()) as KdsFeed
	}
	async function stage(stage: string, current?: KdsFeed) {
		const ticket = (current ?? (await feed())).tickets[0]!
		return request('POST', '/command', {
			source: ticket.source,
			orderId: ticket.id,
			expectedVersion: ticket.version,
			action: 'stage',
			stage,
		})
	}

	it('lists saved and paid Station food, with no contacts, money or staff names', async () => {
		const response = await request()
		expect(response.headers.get('cache-control')).toContain('no-store')
		const raw = await response.text()
		expect(raw).not.toMatch(
			/Private|15551234567|subtotalCents|currency|secretHash/,
		)
		const data = JSON.parse(raw) as KdsFeed
		expect(data.tickets[0]).toMatchObject({
			number: 'T1-0001',
			tableLabel: '12',
			lines: [
				{ name: 'Burger', quantity: 2, instructions: 'No onion', stage: 'new' },
			],
		})
	})

	it('prepares, readies, bumps and recalls without altering the bill', async () => {
		expect((await stage('preparing')).status).toBe(200)
		expect((await stage('ready')).status).toBe(200)
		let ticket = (await feed()).tickets[0]!
		expect(
			(
				await request('POST', '/command', {
					source: 'pos',
					orderId,
					expectedVersion: ticket.version,
					action: 'done',
				})
			).status,
		).toBe(200)
		ticket = (await feed()).tickets[0]!
		expect(ticket.completedAt).not.toBeNull()
		expect(
			(
				await request('POST', '/command', {
					source: 'pos',
					orderId,
					expectedVersion: ticket.version,
					action: 'recall',
				})
			).status,
		).toBe(200)
		expect((await feed()).tickets[0]!.completedAt).toBeNull()
		const db = await getTenantDb(ORG_A)
		const [row] = await db
			.select()
			.from(posOrders)
			.where(eq(posOrders.id, orderId))
		expect(row).toMatchObject({ revision: 1, status: 'paid', totalCents: 2000 })
		expect(await db.select().from(kdsEvents)).toHaveLength(4)
	})

	it('refuses stale screens and a second tap after a lost response', async () => {
		const old = await feed()
		expect((await stage('preparing', old)).status).toBe(200)
		const stale = await stage('ready', old)
		expect(stale.status).toBe(409)
		expect(await stale.json()).toMatchObject({ error: 'stale_ticket' })
	})

	it('does not bump unprepared food', async () => {
		const ticket = (await feed()).tickets[0]!
		const response = await request('POST', '/command', {
			source: 'pos',
			orderId,
			expectedVersion: ticket.version,
			action: 'done',
		})
		expect(response.status).toBe(409)
	})

	it('routes items and rejects conflicting configuration changes', async () => {
		const config = {
			...DEFAULT_KDS_CONFIG,
			workflow: 'item',
			stations: [
				...DEFAULT_KDS_CONFIG.stations,
				{ id: 'grill', name: 'Grill', itemIds: ['burger'] },
			],
		}
		expect(
			(await request('PUT', '/settings', { expectedVersion: 0, config }))
				.status,
		).toBe(200)
		expect((await feed()).tickets[0]!.lines[0]!.stationId).toBe('grill')
		expect(
			(await request('PUT', '/settings', { expectedVersion: 0, config }))
				.status,
		).toBe(409)
	})

	it('keeps unchanged dishes ready, but reopens a bumped ticket when food is added', async () => {
		await stage('ready')
		const done = (await feed()).tickets[0]!
		await request('POST', '/command', {
			source: 'pos',
			orderId,
			expectedVersion: done.version,
			action: 'done',
		})
		const db = await getTenantDb(ORG_A)
		const addedAt = Date.now() + 60_000
		await db
			.update(posOrders)
			.set({
				lines: [
					line,
					{ ...line, id: crypto.randomUUID(), itemId: 'fries', name: 'Fries' },
				],
				revision: 2,
				updatedAt: addedAt,
			})
			.where(eq(posOrders.id, orderId))
		const ticket = (await feed()).tickets[0]!
		expect(ticket.completedAt).toBeNull()
		expect(ticket.lines.map((entry) => entry.stage)).toEqual(['ready', 'new'])
		// The added dish says when it came, so the screen treats it as a later round.
		expect(ticket.lines.map((entry) => entry.firedAt)).toEqual([
			undefined,
			addedAt,
		])
		expect(
			(await stage('ready', { ...(await feed()), tickets: [done] })).status,
		).toBe(409)
		// Starting the added round leaves the dish already made ready.
		expect((await stage('preparing')).status).toBe(200)
		const started = (await feed()).tickets[0]!
		expect(started.lines.map((entry) => entry.stage)).toEqual([
			'ready',
			'preparing',
		])
		// What went out stays marked as served.
		expect(started.lines[0]!.servedAt).toEqual(expect.any(Number))
		expect(started.lines[1]!.servedAt).toBeUndefined()
	})

	it('dates each dish by the revision that first sent it, also once the round is started', async () => {
		const db = await getTenantDb(ORG_A)
		const fries = { ...line, id: crypto.randomUUID(), itemId: 'fries' }
		const openedAt = Date.now() - 50 * 60_000
		const addedAt = Date.now() - 5 * 60_000
		await db
			.update(posOrders)
			.set({ status: 'open', rungUpAt: openedAt })
			.where(eq(posOrders.id, orderId))
		await stage('ready')
		const served = (await feed()).tickets[0]!
		await request('POST', '/command', {
			source: 'pos',
			orderId,
			expectedVersion: served.version,
			action: 'done',
		})
		await db.insert(posOrderRevisions).values([
			{
				orderId,
				revision: 1,
				deviceId,
				snapshot: { lines: [line] },
				receivedAt: openedAt,
			},
			{
				orderId,
				revision: 2,
				deviceId,
				snapshot: { lines: [line, fries] },
				receivedAt: addedAt,
			},
		])
		await db
			.update(posOrders)
			.set({ lines: [line, fries], revision: 2, updatedAt: Date.now() })
			.where(eq(posOrders.id, orderId))
		const fired = (ticket: KdsFeed['tickets'][number]) =>
			ticket.lines.map((entry) => entry.firedAt)
		expect(fired((await feed()).tickets[0]!)).toEqual([openedAt, addedAt])
		expect((await stage('preparing')).status).toBe(200)
		const started = (await feed()).tickets[0]!
		expect(fired(started)).toEqual([openedAt, addedAt])
		expect(started.lines.map((entry) => Boolean(entry.servedAt))).toEqual([
			true,
			false,
		])
		// Made again, the dish is no longer the one that went out.
		expect(
			(
				await request('POST', '/command', {
					source: 'pos',
					orderId,
					expectedVersion: started.version,
					action: 'stage',
					stage: 'new',
					lineId: started.lines[0]!.id,
				})
			).status,
		).toBe(200)
		expect((await feed()).tickets[0]!.lines[0]!.servedAt).toBeUndefined()
	})

	it('keeps when each round went out, so a recall takes back only the last', async () => {
		const db = await getTenantDb(ORG_A)
		await db
			.update(posOrders)
			.set({ status: 'open' })
			.where(eq(posOrders.id, orderId))
		const clear = async () => {
			await stage('ready')
			const ready = (await feed()).tickets[0]!
			return request('POST', '/command', {
				source: 'pos',
				orderId,
				expectedVersion: ready.version,
				action: 'done',
			})
		}
		expect((await clear()).status).toBe(200)
		const first = (await feed()).tickets[0]!
		const firstOut = first.lines[0]!.servedAt
		// Clearing it again is refused: it is done already.
		expect(
			(
				await request('POST', '/command', {
					source: 'pos',
					orderId,
					expectedVersion: first.version,
					action: 'done',
				})
			).status,
		).toBe(409)
		const fries = { ...line, id: crypto.randomUUID(), itemId: 'fries' }
		await db
			.update(posOrders)
			.set({ lines: [line, fries], revision: 2, updatedAt: Date.now() + 1 })
			.where(eq(posOrders.id, orderId))
		await new Promise((resolve) => setTimeout(resolve, 5))
		expect((await clear()).status).toBe(200)
		const both = (await feed()).tickets[0]!
		expect(both.lines[0]!.servedAt).toBe(firstOut)
		await request('POST', '/command', {
			source: 'pos',
			orderId,
			expectedVersion: both.version,
			action: 'recall',
		})
		const recalled = (await feed()).tickets[0]!
		expect(recalled.lines.map((entry) => entry.servedAt)).toEqual([
			firstOut,
			undefined,
		])
	})

	it('keeps later dishes’ progress when an earlier one is taken off (lines keep their ids)', async () => {
		const db = await getTenantDb(ORG_A)
		const fries = { ...line, id: crypto.randomUUID(), itemId: 'fries' }
		await db
			.update(posOrders)
			.set({ lines: [line, fries] })
			.where(eq(posOrders.id, orderId))
		const before = (await feed()).tickets[0]!
		await request('POST', '/command', {
			source: 'pos',
			orderId,
			expectedVersion: before.version,
			action: 'stage',
			stage: 'ready',
			lineId: before.lines[1]!.id,
		})
		await db
			.update(posOrders)
			.set({ lines: [fries], revision: 2 })
			.where(eq(posOrders.id, orderId))
		const after = (await feed()).tickets[0]!
		expect(after.lines.map((entry) => [entry.itemId, entry.stage])).toEqual([
			['fries', 'ready'],
		])
	})

	it('shows an unreadable order without dishes instead of failing the kitchen', async () => {
		const db = await getTenantDb(ORG_A)
		const broken = crypto.randomUUID()
		await db.insert(posOrders).values({
			id: broken,
			deviceId,
			number: 'T1-0002',
			businessDate: '2026-10-23',
			revision: 1,
			status: 'paid',
			orderType: 'dine_in',
			locationId: 'loc-1',
			currency: 'USD',
			subtotalCents: 100,
			taxCents: 0,
			totalCents: 100,
			lines: [{ itemId: 'burger', quantity: 'many' }],
			adjustments: [],
			rungUpAt: Date.now(),
		})
		const r = await request()
		expect(r.status).toBe(200)
		const tickets = ((await r.json()) as KdsFeed).tickets
		expect(tickets.map((ticket) => ticket.id)).toEqual([orderId])
	})

	it('dates dishes by when the till sent them, never later than it arrived', async () => {
		const db = await getTenantDb(ORG_A)
		const sentAt = Date.now() - 20 * 60_000
		const future = Date.now() + 60 * 60_000
		await db
			.update(posOrders)
			.set({
				lines: [
					{ ...line, sentAt: new Date(sentAt).toISOString() },
					{
						...line,
						id: crypto.randomUUID(),
						itemId: 'fries',
						sentAt: new Date(future).toISOString(),
					},
				],
			})
			.where(eq(posOrders.id, orderId))
		const [first, second] = (await feed()).tickets[0]!.lines
		expect(first!.firedAt).toBe(sentAt)
		expect(second!.firedAt).toBeLessThan(future)
	})

	it('isolates locations, organisations, revoked terminals and the kill switch', async () => {
		const db = await getTenantDb(ORG_A)
		await db
			.update(posDevices)
			.set({ locationId: 'elsewhere' })
			.where(eq(posDevices.id, deviceId))
		expect((await feed()).tickets).toEqual([])
		const response = await request('POST', '/command', {
			source: 'pos',
			orderId,
			expectedVersion: 'a'.repeat(64),
			action: 'stage',
			stage: 'ready',
		})
		expect(response.status).toBe(404)
		expect(
			(await request('GET', '', undefined, secret.replace(ORG_A, ORG_B)))
				.status,
		).toBe(401)
		await db
			.update(posDevices)
			.set({ revokedAt: Date.now() })
			.where(eq(posDevices.id, deviceId))
		expect((await request()).status).toBe(401)
		vi.stubEnv('POS_ENABLED', 'false')
		expect((await request()).status).toBe(503)
	})

	it('requires the signed-in staff session when enabled and a bound location', async () => {
		const db = await getTenantDb(ORG_A)
		await db
			.update(posDevices)
			.set({ signInRequired: true })
			.where(eq(posDevices.id, deviceId))
		expect((await request()).status).toBe(401)
		await db
			.update(posDevices)
			.set({ locationId: null })
			.where(eq(posDevices.id, deviceId))
		expect((await request()).status).toBe(403)
	})

	it('includes only accepted online orders whose payment permits cooking, and never marks them paid or collected', async () => {
		const db = await getTenantDb(ORG_A)
		const onlineId = crypto.randomUUID()
		const values = {
			id: onlineId,
			orgId: ORG_A,
			number: 'WEB-1',
			status: 'accepted' as const,
			paymentMethod: 'handoff' as const,
			paymentStatus: 'unpaid' as const,
			fulfillment: 'pickup' as const,
			locationId: 'loc-1',
			locationName: 'Main',
			contactName: 'Private online guest',
			contactPhone: '+15550000000',
			currency: 'USD',
			subtotalCents: 1000,
			taxCents: 0,
			totalCents: 1000,
			lines: [
				{
					itemId: 'coffee',
					itemName: 'Coffee',
					quantity: 1,
					instructions: 'Oat milk',
					options: [],
				},
			],
			idempotencyKey: crypto.randomUUID(),
			requestHash: 'x',
			receiptTokenHash: 'y',
			pickupDate: '2026-11-15',
			pickupTime: '14:30',
			pickupTimezone: 'Asia/Riyadh',
		}
		await db.insert(restaurantOrders).values(values)
		await db.insert(restaurantOrders).values({
			...values,
			id: crypto.randomUUID(),
			number: 'WEB-2',
			idempotencyKey: crypto.randomUUID(),
			paymentMethod: 'online',
			paymentStatus: 'pending',
		})
		let data = await feed()
		expect(data.tickets).toHaveLength(2)
		const ticket = data.tickets.find((entry) => entry.source === 'online')!
		expect(ticket.dueAt).toBe(Date.parse('2026-11-15T11:30:00Z'))
		expect(JSON.stringify(ticket)).not.toMatch(/Private|15550000000/)
		expect(
			(
				await request('POST', '/command', {
					source: 'online',
					orderId: onlineId,
					expectedVersion: ticket.version,
					action: 'stage',
					stage: 'ready',
				})
			).status,
		).toBe(200)
		data = await feed()
		const ready = data.tickets.find((entry) => entry.source === 'online')!
		await request('POST', '/command', {
			source: 'online',
			orderId: onlineId,
			expectedVersion: ready.version,
			action: 'done',
		})
		const [order] = await db
			.select()
			.from(restaurantOrders)
			.where(
				and(
					eq(restaurantOrders.id, onlineId),
					eq(restaurantOrders.orgId, ORG_A),
				),
			)
		expect(order).toMatchObject({
			status: 'ready',
			paymentStatus: 'unpaid',
			completedAt: null,
		})
	})

	it('keeps prepared dishes ready when configuration reroutes them', async () => {
		await stage('ready')
		const before = (await feed()).tickets[0]!
		const response = await request('PUT', '/settings', {
			expectedVersion: 0,
			config: {
				...DEFAULT_KDS_CONFIG,
				stations: [
					{ id: 'kitchen', name: 'Kitchen', itemIds: [] },
					{ id: 'grill', name: 'Grill', itemIds: ['burger'] },
				],
			},
		})
		expect(response.status).toBe(200)
		const after = (await feed()).tickets[0]!
		expect(after.lines[0]).toMatchObject({
			id: before.lines[0]!.id,
			stage: 'ready',
			stationId: 'grill',
		})
		expect(after.version).not.toBe(before.version)
	})

	it('serializes simultaneous commands, rejecting one stale version', async () => {
		const current = await feed()
		const answers = await Promise.all([
			stage('ready', current),
			stage('preparing', current),
		])
		expect(answers.map((answer) => answer.status).sort()).toEqual([200, 409])
		const db = await getTenantDb(ORG_A)
		expect(await db.select().from(kdsEvents)).toHaveLength(1)
	})

	it('requires a current manager roster entry for shared setup, not a role claimed by the client', async () => {
		const db = await getTenantDb(ORG_A)
		const staffId = crypto.randomUUID()
		await db
			.update(posDevices)
			.set({ signInRequired: true })
			.where(eq(posDevices.id, deviceId))
		await db
			.insert(staffMembers)
			.values({ id: staffId, firstName: 'Private', lastName: 'Staff' })
		// A terminal bound to a location signs in that location's staff.
		await db
			.insert(staffScopeAssignments)
			.values({ staffId, scopeId: 'loc-1', pinLookup: 'set' })
		const session = await mintPosStaffSession({
			orgId: ORG_A,
			deviceId,
			staffId,
			role: 'manager',
		})
		const config = { expectedVersion: 0, config: DEFAULT_KDS_CONFIG }
		expect(
			(await request('GET', '', undefined, secret, session.token)).status,
		).toBe(200)
		expect(
			(await request('PUT', '/settings', config, secret, session.token)).status,
		).toBe(403)
		await db.insert(posManagers).values({ staffId, addedBy: 'operator' })
		expect(
			(await request('PUT', '/settings', config, secret, session.token)).status,
		).toBe(200)
		await db
			.update(staffScopeAssignments)
			.set({ active: false })
			.where(eq(staffScopeAssignments.staffId, staffId))
		expect(
			(await request('GET', '', undefined, secret, session.token)).status,
		).toBe(401)
	})

	it('shows recent cancellations as stop-prep tickets and refuses to prepare them', async () => {
		const db = await getTenantDb(ORG_A)
		await db
			.update(posOrders)
			.set({ status: 'void', voidedAt: Date.now() })
			.where(eq(posOrders.id, orderId))
		expect((await feed()).tickets[0]?.cancelled).toBe(true)
		expect((await stage('ready')).status).toBe(404)
	})
})
