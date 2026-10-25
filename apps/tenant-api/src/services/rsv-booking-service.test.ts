import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
	destroyTenantDb,
	getTenantDb,
	provisionTenantDb,
	rsvAreas,
	rsvAuditLog,
	rsvGuestNotes,
	rsvGuests,
	rsvGuestTags,
	rsvLocationSettings,
	rsvPacingRules,
	rsvReservationEvents,
	rsvReservations,
	rsvServiceAvailability,
	rsvServices,
	rsvSpecialDays,
	rsvTableOccupancies,
	rsvTables,
	rsvTags,
} from '@repo/tenant-db'
import { eq, inArray } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
	assignReservationTables,
	createOperatorReservation,
	createWalkIn,
	getReservationDetail,
	transitionReservationStatus,
	tillUndoable,
	undoReservationTransition,
	updateReservation,
	updateReservationContactStatus,
	updateReservationCourseStatus,
	updateReservationNotes,
	updateReservationRunningLate,
} from './rsv-booking-service.ts'
import {
	getDayChanges,
	getDayFeed,
	getMonthCalendar,
	getOperatorAvailability,
	getPreServiceOverview,
	getSectionAssignments,
	getServiceNotes,
	putSectionAssignments,
	upsertServiceNotes,
} from './rsv-day-feed-service.ts'
import {
	createGuestProfile,
	eraseGuestProfile,
	exportGuestProfile,
	getGuestSummary,
	lookupGuests,
} from './rsv-guest-service.ts'
import {
	createSectionLayoutForLocation,
	deleteSectionLayoutForLocation,
	listSectionLayoutsForLocation,
	updateSectionLayoutForLocation,
} from './rsv-setup-service.ts'

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rsv-book-svc-test-'))
process.env.TENANT_DB_DIR = TEST_DIR

const ORG_ID = 'org_rsv_book_svc'
const LOC_ID = 'loc_main'
const DATE = '2026-08-15' // Saturday

describe('Reservations Book, Host Stand & Guest services', () => {
	beforeAll(async () => {
		await provisionTenantDb(ORG_ID)
		const db = await getTenantDb(ORG_ID)
		const now = Date.now()

		await db.insert(rsvLocationSettings).values({
			locationId: LOC_ID,
			timeZone: 'America/New_York',
			dayStartMin: 240,
			intervalMin: 15,
			freezeMin: 30,
			contactStatusesEnabled: true,
			courseStatusesEnabled: true,
			enabled: true,
			version: 1,
			updatedAt: now,
		})

		await db.insert(rsvAreas).values([
			{
				id: 'area_main',
				locationId: LOC_ID,
				name: 'Main Dining',
				sort: 0,
				onlineBookable: true,
				guestSelectable: true,
			},
			{
				id: 'area_patio',
				locationId: LOC_ID,
				name: 'Patio',
				sort: 1,
				onlineBookable: true,
				guestSelectable: true,
			},
		])

		await db.insert(rsvTables).values([
			{
				id: 'tbl_1',
				locationId: LOC_ID,
				areaId: 'area_main',
				label: 'T1',
				minCovers: 1,
				maxCovers: 2,
				onlineBookable: true,
				resetBufferMin: 15,
			},
			{
				id: 'tbl_2',
				locationId: LOC_ID,
				areaId: 'area_main',
				label: 'T2',
				minCovers: 1,
				maxCovers: 2,
				onlineBookable: true,
				resetBufferMin: 15,
			},
			{
				id: 'tbl_staff',
				locationId: LOC_ID,
				areaId: 'area_main',
				label: 'VIP-1',
				minCovers: 1,
				maxCovers: 4,
				onlineBookable: false,
				resetBufferMin: 15,
			},
			{
				id: 'tbl_walkin',
				locationId: LOC_ID,
				areaId: 'area_patio',
				label: 'W1',
				minCovers: 1,
				maxCovers: 4,
				onlineBookable: false,
				resetBufferMin: 10,
			},
			{
				id: 'tbl_large',
				locationId: LOC_ID,
				areaId: 'area_main',
				label: 'T10',
				minCovers: 4,
				maxCovers: 8,
				onlineBookable: true,
				resetBufferMin: 15,
			},
		])

		await db.insert(rsvServices).values({
			id: 'svc_dinner',
			locationId: LOC_ID,
			name: 'Dinner',
			daysMask: 127,
			firstSeatingMin: 17 * 60,
			lastSeatingMin: 21 * 60 + 30,
			endMin: 22 * 60,
			onlineEnabled: true,
			sort: 0,
		})

		await db.insert(rsvServiceAvailability).values([
			{
				id: 'sa_staff',
				serviceId: 'svc_dinner',
				tableId: 'tbl_staff',
				mode: 'staff_only',
			},
			{
				id: 'sa_walkin',
				serviceId: 'svc_dinner',
				tableId: 'tbl_walkin',
				mode: 'walk_in_only',
			},
		])

		await db.insert(rsvTags).values([
			{
				id: 'tag_vip',
				scope: 'guest',
				category: 'vip',
				name: 'VIP',
				colorToken: 'amber',
				sensitive: false,
				guestSelectable: false,
			},
			{
				id: 'tag_shellfish',
				scope: 'guest',
				category: 'dietary',
				name: 'Shellfish Allergy',
				colorToken: 'red',
				sensitive: true,
				guestSelectable: true,
			},
		])
	})

	afterAll(async () => {
		await destroyTenantDb(ORG_ID)
		fs.rmSync(TEST_DIR, { recursive: true, force: true })
	})

	it('enforces section layout unique table membership (table_in_multiple_sections)', async () => {
		const db = await getTenantDb(ORG_ID)

		await expect(
			createSectionLayoutForLocation(db, {
				locationId: LOC_ID,
				actorId: 'user_kody',
				name: 'Duplicate Table Layout',
				serviceId: 'svc_dinner',
				isDefault: true,
				sections: [
					{
						name: 'Section 1',
						colorToken: 'blue',
						tableIds: ['tbl_1', 'tbl_2'],
					},
					{
						name: 'Section 2',
						colorToken: 'emerald',
						tableIds: ['tbl_1', 'tbl_large'],
					},
				],
			}),
		).rejects.toMatchObject({
			status: 409,
			code: 'table_in_multiple_sections',
		})

		const created = await createSectionLayoutForLocation(db, {
			locationId: LOC_ID,
			actorId: 'user_kody',
			name: 'Dinner Floor Sections',
			serviceId: 'svc_dinner',
			isDefault: true,
			sections: [
				{
					name: 'Section A',
					colorToken: 'blue',
					tableIds: ['tbl_1', 'tbl_2'],
				},
				{
					name: 'Section B',
					colorToken: 'emerald',
					tableIds: ['tbl_staff', 'tbl_large'],
				},
			],
		})

		expect(created.layout.sections).toHaveLength(2)
		expect(created.layout.sections[0]?.tableIds).toEqual(['tbl_1', 'tbl_2'])

		const updated = await updateSectionLayoutForLocation(
			db,
			created.layout.id,
			{
				actorId: 'user_kody',
				name: 'Updated Dinner Sections',
				sections: [
					{
						name: 'Section A',
						colorToken: 'blue',
						tableIds: ['tbl_1'],
					},
					{
						name: 'Section B',
						colorToken: 'emerald',
						tableIds: ['tbl_2', 'tbl_staff', 'tbl_large'],
					},
				],
			},
		)
		expect(updated.layout.name).toBe('Updated Dinner Sections')

		const listed = await listSectionLayoutsForLocation(db, LOC_ID)
		expect(listed).toHaveLength(1)

		const temp = await createSectionLayoutForLocation(db, {
			locationId: LOC_ID,
			actorId: 'user_kody',
			name: 'Temp Layout',
			sections: [
				{ name: 'Patio Sec', colorToken: 'amber', tableIds: ['tbl_walkin'] },
			],
		})
		await deleteSectionLayoutForLocation(db, temp.layout.id, 'user_kody')
		const listedAfter = await listSectionLayoutsForLocation(db, LOC_ID)
		expect(listedAfter).toHaveLength(1)
	})

	it('creates phone bookings with idempotency, staff_only table eligibility, and custom fields', async () => {
		const booking = await createOperatorReservation({
			orgId: ORG_ID,
			locationId: LOC_ID,
			actorId: 'user_kody',
			idempotencyKey: 'idem-book-1',
			canReadGuestSensitive: true,
			input: {
				locationId: LOC_ID,
				date: DATE,
				time: '19:00',
				partySize: 2,
				durationMin: 120,
				diningAreaId: 'area_main',
				occasion: 'anniversary',
				dietaryNotes: 'contract-dietary-book003',
				internalNotes: 'contract-internal-book003',
				guest: {
					firstName: 'Alice',
					lastName: 'Monroe',
					phone: '+14155550101',
					email: 'alice@example.com',
					allergyNotes: 'contract-allergy-host023',
				},
			},
		})

		expect(booking.reservation.status).toBe('booked')
		expect(booking.reservation.durationMin).toBe(120)
		expect(booking.reservation.occasion).toBe('anniversary')
		expect(booking.reservation.dietaryNotes).toBe('contract-dietary-book003')
		expect(booking.reservation.internalNotes).toBe('contract-internal-book003')
		expect(booking.reservation.tableIds.length).toBeGreaterThan(0)

		// Replay with identical Idempotency-Key returns same reservation
		const replay = await createOperatorReservation({
			orgId: ORG_ID,
			locationId: LOC_ID,
			actorId: 'user_kody',
			idempotencyKey: 'idem-book-1',
			input: {
				locationId: LOC_ID,
				date: DATE,
				time: '19:00',
				partySize: 2,
				durationMin: 120,
				diningAreaId: 'area_main',
				occasion: 'anniversary',
				dietaryNotes: 'contract-dietary-book003',
				internalNotes: 'contract-internal-book003',
				guest: {
					firstName: 'Alice',
					lastName: 'Monroe',
					phone: '+14155550101',
					email: 'alice@example.com',
					allergyNotes: 'contract-allergy-host023',
				},
			},
		})
		expect(replay.reservation.id).toBe(booking.reservation.id)

		// Replay with different payload and same Idempotency-Key throws 409 idempotency_conflict
		await expect(
			createOperatorReservation({
				orgId: ORG_ID,
				locationId: LOC_ID,
				actorId: 'user_kody',
				idempotencyKey: 'idem-book-1',
				input: {
					locationId: LOC_ID,
					date: DATE,
					time: '20:00',
					partySize: 4,
					guest: {
						firstName: 'Alice',
						lastName: 'Monroe',
					},
				},
			}),
		).rejects.toMatchObject({
			status: 409,
			code: 'idempotency_conflict',
		})
	})

	it('enforces pacing limits and allows audited overbook override', async () => {
		const db = await getTenantDb(ORG_ID)
		await db.insert(rsvPacingRules).values({
			id: 'pace_dinner_cap',
			serviceId: 'svc_dinner',
			bucketMin: 15,
			maxCovers: 2,
			maxParties: null,
			channel: 'all',
		})

		// 19:00 already has 2 covers from Alice Monroe -> next booking at 19:00 without overbook fails with 409
		await expect(
			createOperatorReservation({
				orgId: ORG_ID,
				locationId: LOC_ID,
				actorId: 'user_kody',
				idempotencyKey: 'idem-overbook-fail',
				input: {
					locationId: LOC_ID,
					date: DATE,
					time: '19:00',
					partySize: 2,
					guest: { firstName: 'Bob', lastName: 'Pace' },
				},
			}),
		).rejects.toMatchObject({ status: 409 })

		// With overbook: true and overbookReason, succeeds and writes reservation.overbook audit log
		const overbooked = await createOperatorReservation({
			orgId: ORG_ID,
			locationId: LOC_ID,
			actorId: 'user_kody',
			idempotencyKey: 'idem-overbook-ok',
			input: {
				locationId: LOC_ID,
				date: DATE,
				time: '19:00',
				partySize: 2,
				overbook: true,
				overbookReason: 'VIP regular',
				guest: { firstName: 'Bob', lastName: 'Pace' },
			},
		})
		expect(overbooked.reservation.overbook).toBe(true)

		const auditRows = await db
			.select()
			.from(rsvAuditLog)
			.where(eq(rsvAuditLog.entityId, overbooked.reservation.id))
			.all()
		expect(auditRows.some((a) => a.action === 'reservation.overbook')).toBe(
			true,
		)

		// Clean up pacing rule and overbooked reservation for subsequent tests
		await db
			.delete(rsvPacingRules)
			.where(eq(rsvPacingRules.id, 'pace_dinner_cap'))
		await transitionReservationStatus({
			orgId: ORG_ID,
			reservationId: overbooked.reservation.id,
			actorId: 'user_kody',
			input: { status: 'cancelled', cancelReason: 'cleanup' },
		})
	})

	it('operator availability flags a max_parties breach the same way the booking write rejects it', async () => {
		const db = await getTenantDb(ORG_ID)
		await db.insert(rsvPacingRules).values({
			id: 'pace_dinner_parties',
			serviceId: 'svc_dinner',
			bucketMin: 15,
			maxCovers: null,
			maxParties: 1,
			channel: 'all',
		})
		try {
			const avail = await getOperatorAvailability(db, LOC_ID, {
				date: DATE,
				partySize: 2,
				serviceId: 'svc_dinner',
			})
			const at = (time: string) => avail.slots.find((s) => s.time === time)!
			// Alice's 19:00 booking already fills the one-party bucket 19:00-19:15.
			expect(at('19:00')).toMatchObject({
				pacingWarning: true,
				available: false,
			})
			expect(at('19:15').pacingWarning).toBe(false)

			await expect(
				createOperatorReservation({
					orgId: ORG_ID,
					locationId: LOC_ID,
					actorId: 'user_kody',
					idempotencyKey: 'idem-parties-fail',
					input: {
						locationId: LOC_ID,
						date: DATE,
						time: '19:00',
						partySize: 2,
						guest: { firstName: 'Cara', lastName: 'Pace' },
					},
				}),
			).rejects.toMatchObject({ status: 409, code: 'pacing_parties_exceeded' })
		} finally {
			await db
				.delete(rsvPacingRules)
				.where(eq(rsvPacingRules.id, 'pace_dinner_parties'))
		}
	})

	it('supports Assign (soft), Assign & Lock (locked), unlock, atomic Swap, soft reflow, and refuses displacing locked/seated/frozen bookings', async () => {
		const swapDate = '2026-08-16'
		// Create Booking A at 20:30 on T1 (soft) and Booking B at 20:30 on T2 (soft)
		const bA = await createOperatorReservation({
			orgId: ORG_ID,
			locationId: LOC_ID,
			actorId: 'user_kody',
			idempotencyKey: 'idem-swap-a',
			input: {
				locationId: LOC_ID,
				date: swapDate,
				time: '20:30',
				partySize: 2,
				tableIds: ['tbl_1'],
				lock: false,
				guest: { firstName: 'Swap', lastName: 'Alpha' },
			},
		})
		expect(bA.reservation.tableIds).toEqual(['tbl_1'])
		expect(bA.reservation.assignment).toBe('soft')

		// Lock and unlock Booking A
		const lockedA = await assignReservationTables({
			orgId: ORG_ID,
			reservationId: bA.reservation.id,
			actorId: 'user_kody',
			input: {
				tableIds: ['tbl_1'],
				lock: true,
				expectedVersion: bA.reservation.version,
			},
		})
		expect(lockedA.reservation.assignment).toBe('locked')
		expect(lockedA.reservation.tableLocked).toBe(true)

		// Create Booking B at 20:30 on T2
		const bB = await createOperatorReservation({
			orgId: ORG_ID,
			locationId: LOC_ID,
			actorId: 'user_kody',
			idempotencyKey: 'idem-swap-b',
			input: {
				locationId: LOC_ID,
				date: swapDate,
				time: '20:30',
				partySize: 2,
				tableIds: ['tbl_2'],
				lock: false,
				guest: { firstName: 'Swap', lastName: 'Beta' },
			},
		})
		expect(bB.reservation.tableIds).toEqual(['tbl_2'])

		// Attempting to move Booking B onto T1 while Booking A is locked (without swap/overbook) -> 409
		await expect(
			assignReservationTables({
				orgId: ORG_ID,
				reservationId: bB.reservation.id,
				actorId: 'user_kody',
				input: {
					tableIds: ['tbl_1'],
					lock: false,
				},
			}),
		).rejects.toMatchObject({ status: 409 })

		// Unlock Booking A
		const unlockedA = await assignReservationTables({
			orgId: ORG_ID,
			reservationId: bA.reservation.id,
			actorId: 'user_kody',
			input: {
				unlock: true,
				expectedVersion: lockedA.reservation.version,
			},
		})
		expect(unlockedA.reservation.assignment).toBe('soft')

		// Atomic Swap: move Booking A onto T2 (held by Booking B) -> Booking A gets T2, Booking B moves to T1!
		const swapped = await assignReservationTables({
			orgId: ORG_ID,
			reservationId: bA.reservation.id,
			actorId: 'user_kody',
			input: {
				tableIds: ['tbl_2'],
				swap: true,
				expectedVersion: unlockedA.reservation.version,
			},
		})
		expect(swapped.reservation.tableIds).toEqual(['tbl_2'])
		expect(swapped.moves).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					reservationId: bB.reservation.id,
					fromTableIds: ['tbl_2'],
					toTableIds: ['tbl_1'],
				}),
			]),
		)
	})

	it('creates walk-ins in seated status using walk_in_only tables and defaults to Walk-in Guest', async () => {
		const walkIn = await createWalkIn({
			orgId: ORG_ID,
			locationId: LOC_ID,
			actorId: 'user_kody',
			idempotencyKey: 'idem-walkin-1',
			input: {
				locationId: LOC_ID,
				date: DATE,
				time: '18:00',
				partySize: 3,
				tableIds: ['tbl_walkin'],
			},
		})
		expect(walkIn.reservation.status).toBe('seated')
		expect(walkIn.reservation.channel).toBe('walk_in')
		expect(walkIn.reservation.tableIds).toEqual(['tbl_walkin'])
		expect(walkIn.reservation.guest?.name).toBe('Walk-in Guest')
	})

	it('walk-in start minute uses the location day start, like its business date', async () => {
		const db = await getTenantDb(ORG_ID)
		await db.insert(rsvLocationSettings).values({
			locationId: 'loc_midnight',
			timeZone: 'UTC',
			dayStartMin: 0,
			intervalMin: 15,
			freezeMin: 30,
			enabled: true,
			version: 1,
			updatedAt: Date.now(),
		})
		await db.insert(rsvTables).values({
			id: 'tbl_midnight',
			locationId: 'loc_midnight',
			areaId: 'area_main',
			label: 'M1',
			minCovers: 1,
			maxCovers: 4,
			resetBufferMin: 10,
		})
		const at = Date.parse('2026-08-15T02:00:00Z')
		vi.useFakeTimers({ toFake: ['Date'] })
		vi.setSystemTime(at)
		try {
			const walkIn = await createWalkIn({
				orgId: ORG_ID,
				locationId: 'loc_midnight',
				actorId: 'user_kody',
				idempotencyKey: 'idem-walkin-midnight',
				input: {
					locationId: 'loc_midnight',
					partySize: 2,
					tableIds: ['tbl_midnight'],
				},
			})
			const row = await db
				.select()
				.from(rsvReservations)
				.where(eq(rsvReservations.id, walkIn.reservation.id))
				.get()
			expect(row?.businessDate).toBe('2026-08-15')
			expect(row?.startAt).toBe(at)
		} finally {
			vi.useRealTimers()
		}
	})

	it('enforces state machine transitions, seatedPartySize covers, and 30-min undo window', async () => {
		const created = await createOperatorReservation({
			orgId: ORG_ID,
			locationId: LOC_ID,
			actorId: 'user_kody',
			idempotencyKey: 'idem-lifecycle-1',
			input: {
				locationId: LOC_ID,
				date: DATE,
				time: '17:30',
				partySize: 4,
				tableIds: ['tbl_large'],
				guest: { firstName: 'Lifecycle', lastName: 'Guest' },
			},
		})

		// Invalid transition booked -> finished -> 409
		await expect(
			transitionReservationStatus({
				orgId: ORG_ID,
				reservationId: created.reservation.id,
				actorId: 'user_kody',
				input: {
					status: 'finished',
					expectedVersion: created.reservation.version,
				},
			}),
		).rejects.toMatchObject({
			status: 409,
			code: 'invalid_status_transition',
		})

		// Contact status pre-arrival -> 200
		const contacted = await updateReservationContactStatus({
			orgId: ORG_ID,
			reservationId: created.reservation.id,
			actorId: 'user_kody',
			input: {
				contactStatus: 'left_message',
				expectedVersion: created.reservation.version,
			},
		})
		expect(contacted.reservation.contactStatus).toBe('left_message')

		// Running late note -> 200
		const late = await updateReservationRunningLate({
			orgId: ORG_ID,
			reservationId: created.reservation.id,
			actorId: 'user_kody',
			input: {
				runningLateNote: 'Running 15 min late',
				expectedVersion: contacted.reservation.version,
			},
		})
		expect(late.reservation.runningLateNote).toBe('Running 15 min late')

		// Course status before seated -> 409
		await expect(
			updateReservationCourseStatus({
				orgId: ORG_ID,
				reservationId: created.reservation.id,
				actorId: 'user_kody',
				input: { courseStatus: 'appetizer' },
			}),
		).rejects.toMatchObject({ status: 409 })

		// Step through confirmed -> arrived -> seated (with seatedPartySize: 3)
		const confirmed = await transitionReservationStatus({
			orgId: ORG_ID,
			reservationId: created.reservation.id,
			actorId: 'user_kody',
			input: { status: 'confirmed', expectedVersion: late.reservation.version },
		})
		const arrived = await transitionReservationStatus({
			orgId: ORG_ID,
			reservationId: created.reservation.id,
			actorId: 'user_kody',
			input: {
				status: 'arrived',
				expectedVersion: confirmed.reservation.version,
			},
		})

		// Contact status after arrival -> 409
		await expect(
			updateReservationContactStatus({
				orgId: ORG_ID,
				reservationId: created.reservation.id,
				actorId: 'user_kody',
				input: { contactStatus: 'confirmed_by_phone' },
			}),
		).rejects.toMatchObject({ status: 409 })

		const seated = await transitionReservationStatus({
			orgId: ORG_ID,
			reservationId: created.reservation.id,
			actorId: 'user_kody',
			input: {
				status: 'seated',
				seatedPartySize: 3,
				expectedVersion: arrived.reservation.version,
			},
		})
		expect(seated.reservation.seatedPartySize).toBe(3)

		// Course status while seated -> 200
		const coursed = await updateReservationCourseStatus({
			orgId: ORG_ID,
			reservationId: created.reservation.id,
			actorId: 'user_kody',
			input: {
				courseStatus: 'entree',
				expectedVersion: seated.reservation.version,
			},
		})
		expect(coursed.reservation.courseStatus).toBe('entree')

		// Finish -> increments visits by 1 and covers by 3 (seatedPartySize)
		const finished = await transitionReservationStatus({
			orgId: ORG_ID,
			reservationId: created.reservation.id,
			actorId: 'user_kody',
			input: {
				status: 'finished',
				expectedVersion: coursed.reservation.version,
			},
		})
		expect(finished.reservation.status).toBe('finished')

		const db = await getTenantDb(ORG_ID)
		const guestAfterFinish = await db
			.select()
			.from(rsvGuests)
			.where(eq(rsvGuests.id, created.reservation.guestId))
			.get()
		expect(guestAfterFinish?.visits).toBe(1)
		expect(guestAfterFinish?.covers).toBe(3)

		// Undo finished -> seated within 30m restores occupancy and decrements guest counters
		const undone = await undoReservationTransition({
			orgId: ORG_ID,
			reservationId: created.reservation.id,
			actorId: 'user_kody',
			input: { expectedVersion: finished.reservation.version },
		})
		expect(undone.reservation.status).toBe('seated')
		const guestAfterUndo = await db
			.select()
			.from(rsvGuests)
			.where(eq(rsvGuests.id, created.reservation.guestId))
			.get()
		expect(guestAfterUndo?.visits).toBe(0)
		expect(guestAfterUndo?.covers).toBe(0)

		// Re-finish and backdate finishedAt by 35 minutes -> undo fails with 409
		const refinished = await transitionReservationStatus({
			orgId: ORG_ID,
			reservationId: created.reservation.id,
			actorId: 'user_kody',
			input: {
				status: 'finished',
				expectedVersion: undone.reservation.version,
			},
		})
		await db
			.update(rsvReservations)
			.set({ finishedAt: Date.now() - 35 * 60_000 })
			.where(eq(rsvReservations.id, created.reservation.id))

		await expect(
			undoReservationTransition({
				orgId: ORG_ID,
				reservationId: created.reservation.id,
				actorId: 'user_kody',
				input: { expectedVersion: refinished.reservation.version },
			}),
		).rejects.toMatchObject({ status: 409 })
	})

	it('undo restores only the occupancies the undone transition released and cannot undo itself', async () => {
		const db = await getTenantDb(ORG_ID)
		const created = await createOperatorReservation({
			orgId: ORG_ID,
			locationId: LOC_ID,
			actorId: 'user_kody',
			idempotencyKey: 'idem-undo-occ-1',
			input: {
				locationId: LOC_ID,
				date: DATE,
				time: '21:00',
				partySize: 2,
				tableIds: ['tbl_1'],
				guest: { firstName: 'Undo', lastName: 'Occupancy' },
			},
		})
		const reassigned = await assignReservationTables({
			orgId: ORG_ID,
			reservationId: created.reservation.id,
			actorId: 'user_kody',
			input: { tableIds: ['tbl_2'] },
		})
		const cancelled = await transitionReservationStatus({
			orgId: ORG_ID,
			reservationId: created.reservation.id,
			actorId: 'user_kody',
			input: {
				status: 'cancelled',
				expectedVersion: reassigned.reservation.version,
			},
		})

		// A cancelled reservation cannot be given tables.
		await expect(
			assignReservationTables({
				orgId: ORG_ID,
				reservationId: created.reservation.id,
				actorId: 'user_kody',
				input: { tableIds: ['tbl_1'] },
			}),
		).rejects.toMatchObject({ status: 409, code: 'reservation_not_active' })

		const undone = await undoReservationTransition({
			orgId: ORG_ID,
			reservationId: created.reservation.id,
			actorId: 'user_kody',
			input: { expectedVersion: cancelled.reservation.version },
		})
		expect(undone.reservation.status).not.toBe('cancelled')
		const occs = await db
			.select()
			.from(rsvTableOccupancies)
			.where(eq(rsvTableOccupancies.reservationId, created.reservation.id))
			.all()
		const activeTables = occs.filter((o) => o.active).map((o) => o.tableId)
		expect(activeTables).toEqual(['tbl_2'])

		// The latest status change is now an undo: a second undo is refused.
		await expect(
			undoReservationTransition({
				orgId: ORG_ID,
				reservationId: created.reservation.id,
				actorId: 'user_kody',
				input: {},
			}),
		).rejects.toMatchObject({ status: 409, code: 'cannot_undo' })
		const afterSecond = await db
			.select()
			.from(rsvReservations)
			.where(eq(rsvReservations.id, created.reservation.id))
			.get()
		expect(afterSecond?.status).toBe(undone.reservation.status)
	})

	describe('a till undoing a no-show', () => {
		const book = async (key: string, time: string, tableId: string) => {
			const created = await createOperatorReservation({
				orgId: ORG_ID,
				locationId: LOC_ID,
				actorId: 'user_kody',
				idempotencyKey: key,
				input: {
					locationId: LOC_ID,
					date: DATE,
					time,
					partySize: 2,
					tableIds: [tableId],
					guest: { firstName: 'Late', lastName: 'Guest' },
				},
			})
			return created.reservation
		}
		const activeTables = async (id: string) => {
			const db = await getTenantDb(ORG_ID)
			return (
				await db
					.select()
					.from(rsvTableOccupancies)
					.where(eq(rsvTableOccupancies.reservationId, id))
					.all()
			)
				.filter((o) => o.active)
				.map((o) => o.tableId)
		}
		const till = { ownRecentOnly: { withinMs: 30 * 60_000 } }

		it('brings the guest back without a table when theirs was given away, but not a cancellation', async () => {
			const maya = await book('idem-till-undo-1', '10:00', 'tbl_1')
			const noShow = await transitionReservationStatus({
				orgId: ORG_ID,
				reservationId: maya.id,
				actorId: 'host_1',
				input: { status: 'no_show', expectedVersion: maya.version },
			})
			// The host gives T1 to someone else; then Maya turns up.
			const other = await book('idem-till-undo-2', '10:00', 'tbl_1')
			const back = await undoReservationTransition({
				orgId: ORG_ID,
				reservationId: maya.id,
				actorId: 'host_1',
				...till,
				input: { expectedVersion: noShow.reservation.version },
			})
			expect(back.reservation.status).not.toBe('no_show')
			expect(await activeTables(maya.id)).toEqual([])
			expect(await activeTables(other.id)).toEqual(['tbl_1'])

			// A cancellation is only put back with its tables.
			const cancelled = await transitionReservationStatus({
				orgId: ORG_ID,
				reservationId: other.id,
				actorId: 'host_1',
				input: { status: 'cancelled', reason: 'test' },
			})
			const third = await book('idem-till-undo-3', '10:00', 'tbl_1')
			await expect(
				undoReservationTransition({
					orgId: ORG_ID,
					reservationId: other.id,
					actorId: 'host_1',
					input: { expectedVersion: cancelled.reservation.version },
				}),
			).rejects.toMatchObject({ status: 409, code: 'table_occupied' })
			expect(await activeTables(third.id)).toEqual(['tbl_1'])
		})

		it('keeps a still-free table with the party it comes back to', async () => {
			const r = await book('idem-till-undo-4', '08:00', 'tbl_2')
			const noShow = await transitionReservationStatus({
				orgId: ORG_ID,
				reservationId: r.id,
				actorId: 'host_1',
				input: { status: 'no_show', expectedVersion: r.version },
			})
			await undoReservationTransition({
				orgId: ORG_ID,
				reservationId: r.id,
				actorId: 'host_1',
				...till,
				input: { expectedVersion: noShow.reservation.version },
			})
			expect(await activeTables(r.id)).toEqual(['tbl_2'])
		})

		it('lets a till undo its own person’s change or the system’s, not another host’s', async () => {
			const own = await book('idem-till-undo-5', '07:00', 'tbl_1')
			await transitionReservationStatus({
				orgId: ORG_ID,
				reservationId: own.id,
				actorId: 'host_1',
				input: { status: 'no_show' },
			})
			const auto = await book('idem-till-undo-6', '06:00', 'tbl_2')
			await transitionReservationStatus({
				orgId: ORG_ID,
				reservationId: auto.id,
				actorId: 'staff-tick',
				actorKind: 'system',
				input: { status: 'no_show', reason: 'auto_no_show' },
			})
			const db = await getTenantDb(ORG_ID)
			const rows = (
				await db
					.select()
					.from(rsvReservations)
					.where(inArray(rsvReservations.id, [own.id, auto.id]))
			).map((r) => ({ id: r.id, status: r.status, noShowAt: r.noShowAt }))
			const asHost = await tillUndoable(db, rows, 'host_1', Date.now())
			expect([...asHost.candidates].sort()).toEqual([own.id, auto.id].sort())
			expect([...asHost.allowed].sort()).toEqual([own.id, auto.id].sort())
			const asOther = await tillUndoable(db, rows, 'host_2', Date.now())
			// Another host sees the system's no-show as theirs to undo, not the first host's.
			expect([...asOther.allowed]).toEqual([auto.id])
			await expect(
				undoReservationTransition({
					orgId: ORG_ID,
					reservationId: own.id,
					actorId: 'host_2',
					...till,
					input: {},
				}),
			).rejects.toMatchObject({ status: 409, code: 'undo_not_allowed' })
			// Past the window nobody's is offered.
			const later = await tillUndoable(
				db,
				rows,
				'host_1',
				Date.now() + 31 * 60_000,
			)
			expect(later.candidates.size).toBe(0)
			// Money on a no-show is the app's, unless the till may settle money.
			await db
				.update(rsvReservations)
				.set({ paymentStatus: 'guaranteed' })
				.where(eq(rsvReservations.id, auto.id))
			const noMoney = await tillUndoable(db, rows, 'host_1', Date.now(), false)
			expect([...noMoney.allowed]).toEqual([own.id])
			const withMoney = await tillUndoable(db, rows, 'host_1', Date.now(), true)
			expect(withMoney.allowed.has(auto.id)).toBe(true)
		})

		it('does not open any other system change to a till', async () => {
			const erased = await book('idem-till-undo-7', '05:00', 'tbl_1')
			await transitionReservationStatus({
				orgId: ORG_ID,
				reservationId: erased.id,
				actorId: 'person-erasure',
				actorKind: 'system',
				input: { status: 'cancelled', reason: 'guest_erased' },
			})
			await expect(
				undoReservationTransition({
					orgId: ORG_ID,
					reservationId: erased.id,
					actorId: 'host_1',
					...till,
					input: {},
				}),
			).rejects.toMatchObject({ status: 409, code: 'undo_not_allowed' })
		})
	})

	it('the generic status route cannot approve a pending_approval request', async () => {
		const db = await getTenantDb(ORG_ID)
		const created = await createOperatorReservation({
			orgId: ORG_ID,
			locationId: LOC_ID,
			actorId: 'user_kody',
			idempotencyKey: 'idem-pending-approval-1',
			input: {
				locationId: LOC_ID,
				date: DATE,
				time: '20:00',
				partySize: 2,
				guest: { firstName: 'Pending', lastName: 'Approval' },
			},
		})
		await db
			.update(rsvReservations)
			.set({ status: 'pending_approval' })
			.where(eq(rsvReservations.id, created.reservation.id))
		for (const status of ['booked', 'confirmed']) {
			await expect(
				transitionReservationStatus({
					orgId: ORG_ID,
					reservationId: created.reservation.id,
					actorId: 'user_kody',
					input: { status },
				}),
			).rejects.toMatchObject({
				status: 409,
				code: 'invalid_status_transition',
			})
		}
	})

	it('serves day feed with composite ETag, changes, calendar, overview (redacting allergy text without guest grant), service notes, and section assignments', async () => {
		const db = await getTenantDb(ORG_ID)

		await db.insert(rsvSpecialDays).values({
			id: 'sp_closed',
			locationId: LOC_ID,
			fromDate: '2026-08-04',
			toDate: '2026-08-04',
			kind: 'closed',
			name: 'Maintenance Day',
		})

		await upsertServiceNotes(db, {
			locationId: LOC_ID,
			businessDate: DATE,
			serviceId: 'svc_dinner',
			note: '86 halibut tonight',
			actorId: 'user_kody',
		})

		const notes = await getServiceNotes(db, LOC_ID, DATE, 'svc_dinner')
		expect(notes.note).toBe('86 halibut tonight')

		const layouts = await listSectionLayoutsForLocation(db, LOC_ID)
		const secA = layouts[0]?.sections[0]
		expect(secA).toBeDefined()

		await putSectionAssignments(db, {
			locationId: LOC_ID,
			businessDate: DATE,
			serviceId: 'svc_dinner',
			assignments: [
				{
					sectionId: secA!.id,
					serverLabel: 'Alex M.',
				},
			],
		})

		const secAssigns = await getSectionAssignments(
			db,
			LOC_ID,
			DATE,
			'svc_dinner',
		)
		expect(secAssigns.assignments[0]?.serverLabel).toBe('Alex M.')

		const feed = await getDayFeed(db, ORG_ID, LOC_ID, DATE, {
			canReadGuestSensitive: false,
		})
		expect(feed.etag).toBe(
			`"${LOC_ID}:${DATE}:${feed.dayVersion}:${feed.settingsVersion}:${feed.floorPlanVersion}"`,
		)

		const changesUnchanged = await getDayChanges(
			db,
			LOC_ID,
			DATE,
			feed.dayVersion,
		)
		expect(changesUnchanged.changed).toBe(false)

		const cal = await getMonthCalendar(db, LOC_ID, '2026-08')
		const aug4 = cal.days.find((d) => d.date === '2026-08-04')
		expect(aug4?.closed).toBe(true)
		const aug15 = cal.days.find((d) => d.date === DATE)
		expect(aug15?.partyCount).toBeGreaterThan(0)

		const overviewHost = await getPreServiceOverview(
			db,
			ORG_ID,
			LOC_ID,
			DATE,
			'svc_dinner',
			{ canReadGuestSensitive: false },
		)
		expect(JSON.stringify(overviewHost)).not.toContain(
			'contract-allergy-host023',
		)

		const overviewAdmin = await getPreServiceOverview(
			db,
			ORG_ID,
			LOC_ID,
			DATE,
			'svc_dinner',
			{ canReadGuestSensitive: true },
		)
		expect(JSON.stringify(overviewAdmin)).toContain('contract-allergy-host023')

		const avail = await getOperatorAvailability(db, LOC_ID, {
			date: DATE,
			partySize: 2,
			serviceId: 'svc_dinner',
		})
		expect(avail.slots.length).toBeGreaterThan(0)
	})

	it('exports and erases guest profiles with event/audit redaction and zero row deletions (VAL-GUEST-022, VAL-GUEST-025)', async () => {
		const db = await getTenantDb(ORG_ID)
		const createdGuest = await createGuestProfile(db, {
			actorId: 'user_kody',
			firstName: 'Erase',
			lastName: 'Target',
			phone: '+14155550999',
			email: 'erase.target@example.com',
			allergyNotes: 'contract-sensitive-book026',
			tagIds: ['tag_vip', 'tag_shellfish'],
			note: 'Private guest note',
		})

		const futureRes = await createOperatorReservation({
			orgId: ORG_ID,
			locationId: LOC_ID,
			actorId: 'user_kody',
			idempotencyKey: 'idem-erase-future',
			input: {
				locationId: LOC_ID,
				date: '2026-08-20',
				time: '19:00',
				partySize: 2,
				guestId: createdGuest.id,
				dietaryNotes: 'contract-erase-note-book027',
			},
		})
		await updateReservationNotes({
			orgId: ORG_ID,
			reservationId: futureRes.reservation.id,
			actorId: 'user_kody',
			input: { internalNotes: 'contract-erase-note-book027' },
		})

		// Default export (includeSensitive = false) omits allergyNotes and sensitive tags
		const defaultExport = await exportGuestProfile(db, {
			guestId: createdGuest.id,
			actorId: 'user_viewer',
			includeSensitive: false,
		})
		expect(JSON.stringify(defaultExport)).not.toContain(
			'contract-sensitive-book026',
		)
		expect(JSON.stringify(defaultExport)).not.toContain('Shellfish Allergy')

		// Sensitive export (includeSensitive = true) includes allergyNotes and writes guest.export audit row
		const sensitiveExport = await exportGuestProfile(db, {
			guestId: createdGuest.id,
			actorId: 'user_kody',
			includeSensitive: true,
		})
		expect(JSON.stringify(sensitiveExport)).toContain(
			'contract-sensitive-book026',
		)

		const eventsBefore = await db.select().from(rsvReservationEvents).all()
		const auditsBefore = await db.select().from(rsvAuditLog).all()

		await eraseGuestProfile({
			orgId: ORG_ID,
			guestId: createdGuest.id,
			actorId: 'user_kody',
		})

		const guestRow = await db
			.select()
			.from(rsvGuests)
			.where(eq(rsvGuests.id, createdGuest.id))
			.get()
		expect(guestRow?.erasedAt).not.toBeNull()
		expect(guestRow?.phoneE164).toBeNull()
		expect(guestRow?.emailNorm).toBeNull()
		expect(guestRow?.allergyNotes).toBeNull()
		expect(`${guestRow?.firstName} ${guestRow?.lastName}`).toBe('Erased guest')

		const resRow = await db
			.select()
			.from(rsvReservations)
			.where(eq(rsvReservations.id, futureRes.reservation.id))
			.get()
		expect(resRow?.status).toBe('cancelled')
		expect(resRow?.cancelledBy).toBe('restaurant')

		const occRows = await db
			.select()
			.from(rsvTableOccupancies)
			.where(eq(rsvTableOccupancies.reservationId, futureRes.reservation.id))
			.all()
		expect(occRows.every((o) => !o.active)).toBe(true)

		const notesLeft = await db
			.select()
			.from(rsvGuestNotes)
			.where(eq(rsvGuestNotes.guestId, createdGuest.id))
			.all()
		const tagsLeft = await db
			.select()
			.from(rsvGuestTags)
			.where(eq(rsvGuestTags.guestId, createdGuest.id))
			.all()
		expect(notesLeft).toHaveLength(0)
		expect(tagsLeft).toHaveLength(0)

		const eventsAfter = await db.select().from(rsvReservationEvents).all()
		const auditsAfter = await db.select().from(rsvAuditLog).all()
		expect(eventsAfter.length).toBeGreaterThanOrEqual(eventsBefore.length)
		expect(auditsAfter.length).toBeGreaterThan(auditsBefore.length)

		const resEvents = eventsAfter.filter(
			(e) => e.reservationId === futureRes.reservation.id,
		)
		expect(resEvents.length).toBeGreaterThan(0)
		for (const ev of resEvents) {
			expect(ev.data).toEqual({ redacted: true })
		}

		expect(
			auditsAfter.some(
				(a) => a.action === 'guest.erase' && a.entityId === createdGuest.id,
			),
		).toBe(true)
	})
})
