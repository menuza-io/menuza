import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@libsql/client'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/libsql'
import { afterEach, describe, expect, it } from 'vitest'
import { applyTenantMigrations } from './migrations.ts'
import * as schema from './schema.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const ALL_RSV_TABLES = [
	'rsv_location_settings',
	'rsv_areas',
	'rsv_tables',
	'rsv_table_combos',
	'rsv_table_combo_members',
	'rsv_floor_elements',
	'rsv_services',
	'rsv_service_availability',
	'rsv_turn_times',
	'rsv_pacing_rules',
	'rsv_special_days',
	'rsv_blocks',
	'rsv_policies',
	'rsv_section_layouts',
	'rsv_sections',
	'rsv_section_tables',
	'rsv_section_assignments',
	'rsv_message_texts',
	'rsv_experiences',
	'rsv_experience_schedules',
	'rsv_guests',
	'rsv_tags',
	'rsv_guest_tags',
	'rsv_guest_notes',
	'rsv_guest_merges',
	'rsv_reservations',
	'rsv_reservation_tags',
	'rsv_table_occupancies',
	'rsv_holds',
	'rsv_reservation_events',
	'rsv_service_notes',
	'rsv_waitlist_entries',
	'rsv_notify_requests',
	'rsv_messages',
	'rsv_payments',
	'rsv_outbox',
	'rsv_journey_emissions',
	'rsv_idempotency_keys',
	'rsv_day_versions',
	'rsv_rate_counters',
	'rsv_audit_log',
] as const

async function expectRejectsWith(
	promise: Promise<unknown>,
	substring: string,
): Promise<void> {
	let caught: unknown
	try {
		await promise
	} catch (error) {
		caught = error
	}
	expect(caught).toBeDefined()
	const text =
		caught instanceof Error
			? `${caught.message} ${String((caught as { cause?: unknown }).cause ?? '')}`
			: String(caught)
	expect(text).toContain(substring)
}

describe('reservations tenant schema (0019_reservations)', () => {
	const tempDirs: string[] = []

	afterEach(() => {
		while (tempDirs.length > 0) {
			const dir = tempDirs.pop()!
			rmSync(dir, { recursive: true, force: true })
		}
	})

	async function openMigratedDb() {
		const dir = mkdtempSync(path.join(tmpdir(), 'tenant-rsv-schema-'))
		tempDirs.push(dir)
		const dbFile = path.join(dir, 'tenant_test.db')
		const client = createClient({ url: `file:${dbFile}` })
		await client.execute('PRAGMA foreign_keys = ON')
		const db = drizzle(client, { schema })
		await applyTenantMigrations(db, 'org_test')
		return { client, db }
	}

	it('creates all 41 rsv_* tables and is idempotent on re-run (VAL-FND-010)', async () => {
		const { client, db } = await openMigratedDb()
		await applyTenantMigrations(db, 'org_test')

		const tablesResult = await client.execute(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'rsv_%' ORDER BY name",
		)
		const tableNames = tablesResult.rows.map((r) => String(r.name))
		expect(ALL_RSV_TABLES.length).toBe(41)
		for (const expectedTable of ALL_RSV_TABLES) {
			expect(tableNames).toContain(expectedTable)
		}
		expect(tableNames.length).toBe(ALL_RSV_TABLES.length)

		// Verify all 9 reservations triggers exist
		const triggersResult = await client.execute(
			"SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'rsv_%' ORDER BY name",
		)
		const triggerNames = triggersResult.rows.map((r) => String(r.name))
		expect(triggerNames).toEqual([
			'rsv_audit_log_no_delete',
			'rsv_audit_log_no_update',
			'rsv_guest_merges_no_delete',
			'rsv_guest_merges_no_update',
			'rsv_holds_single_conversion',
			'rsv_occupancy_no_overlap_insert',
			'rsv_occupancy_no_overlap_update',
			'rsv_reservation_events_no_delete',
			'rsv_reservation_events_no_update',
		])

		client.close()
	})

	it('keeps apps/tenant-api/workers/migrations.generated.ts in sync with 0019_reservations.sql', () => {
		const sqlPath = path.resolve(__dirname, '../drizzle/0019_reservations.sql')
		const generatedPath = path.resolve(
			__dirname,
			'../../../apps/tenant-api/workers/migrations.generated.ts',
		)
		const generatorScriptPath = path.resolve(
			__dirname,
			'../../../apps/tenant-api/scripts/generate-do-migrations.mjs',
		)
		// Always regenerated: the file is gitignored, so an old copy from before a
		// renumbering would otherwise be compared against the new migration.
		execFileSync(process.execPath, [generatorScriptPath], {
			stdio: 'ignore',
		})
		const sqlContent = readFileSync(sqlPath, 'utf8')
		const generatedContent = readFileSync(generatedPath, 'utf8')

		expect(generatedContent).toContain(`"m0019": ${JSON.stringify(sqlContent)}`)
	})

	it('round-trips inserts across all 41 rsv_* tables via Drizzle', async () => {
		const { client, db } = await openMigratedDb()

		await db.insert(schema.rsvPolicies).values({
			id: 'pol_1',
			locationId: 'loc_1',
			name: 'Standard Deposit',
			kind: 'deposit',
			amountMinor: 2500,
			perCover: true,
			currency: 'USD',
		})

		await db.insert(schema.rsvLocationSettings).values({
			locationId: 'loc_1',
			enabled: true,
			onlineEnabled: true,
			timeZone: 'America/New_York',
			currency: 'USD',
			defaultPolicyId: 'pol_1',
		})

		await db.insert(schema.rsvAreas).values({
			id: 'area_1',
			locationId: 'loc_1',
			name: 'Main Dining',
		})

		await db.insert(schema.rsvTables).values({
			id: 'tbl_1',
			locationId: 'loc_1',
			areaId: 'area_1',
			label: 'T1',
			minCovers: 2,
			maxCovers: 4,
			combinable: true,
		})
		await db.insert(schema.rsvTables).values({
			id: 'tbl_2',
			locationId: 'loc_1',
			areaId: 'area_1',
			label: 'T2',
			minCovers: 2,
			maxCovers: 4,
			combinable: true,
		})

		await db.insert(schema.rsvTableCombos).values({
			id: 'cmb_1',
			locationId: 'loc_1',
			label: 'T1+T2',
			minCovers: 5,
			maxCovers: 8,
		})

		await db.insert(schema.rsvTableComboMembers).values([
			{ comboId: 'cmb_1', tableId: 'tbl_1' },
			{ comboId: 'cmb_1', tableId: 'tbl_2' },
		])

		await db.insert(schema.rsvFloorElements).values({
			id: 'fel_1',
			areaId: 'area_1',
			kind: 'bar',
			label: 'Front Bar',
		})

		await db.insert(schema.rsvSectionLayouts).values({
			id: 'lay_1',
			locationId: 'loc_1',
			name: 'Dinner Floor',
		})

		await db.insert(schema.rsvSections).values({
			id: 'sec_1',
			layoutId: 'lay_1',
			name: 'Section A',
		})

		await db.insert(schema.rsvSectionTables).values({
			sectionId: 'sec_1',
			tableId: 'tbl_1',
			layoutId: 'lay_1',
		})

		await db.insert(schema.rsvServices).values({
			id: 'svc_1',
			locationId: 'loc_1',
			name: 'Dinner',
			firstSeatingMin: 1020,
			lastSeatingMin: 1320,
			endMin: 1410,
			policyId: 'pol_1',
			sectionLayoutId: 'lay_1',
		})

		await db.insert(schema.rsvServiceAvailability).values({
			id: 'sa_1',
			serviceId: 'svc_1',
			areaId: 'area_1',
			mode: 'online',
		})

		await db.insert(schema.rsvTurnTimes).values({
			id: 'tt_1',
			locationId: 'loc_1',
			serviceId: 'svc_1',
			partyMin: 1,
			partyMax: 4,
			minutes: 90,
		})

		await db.insert(schema.rsvPacingRules).values({
			id: 'pr_1',
			serviceId: 'svc_1',
			bucketMin: 15,
			maxCovers: 20,
		})

		await db.insert(schema.rsvSpecialDays).values({
			id: 'sd_1',
			locationId: 'loc_1',
			fromDate: '2026-12-25',
			toDate: '2026-12-25',
			kind: 'closed',
			name: 'Holiday',
		})

		await db.insert(schema.rsvBlocks).values({
			id: 'blk_1',
			locationId: 'loc_1',
			tableId: 'tbl_2',
			businessDate: '2026-05-01',
			startAt: 1_800_000_000_000,
			endAt: 1_800_003_600_000,
			reason: 'maintenance',
		})

		await db.insert(schema.rsvSectionAssignments).values({
			id: 'asgn_1',
			locationId: 'loc_1',
			businessDate: '2026-05-01',
			serviceId: 'svc_1',
			sectionId: 'sec_1',
			staffId: 'stf_opaque',
			serverLabel: 'Alex',
		})

		await db.insert(schema.rsvMessageTexts).values({
			id: 'mt_1',
			locationId: 'loc_1',
			kind: 'confirmation',
			locale: 'en',
			customNote: 'Valet available at rear entrance.',
		})

		await db.insert(schema.rsvExperiences).values({
			id: 'exp_1',
			locationId: 'loc_1',
			slug: 'chefs-table',
			kind: 'ticketed',
			nameI18n: { en: "Chef's Table" },
			priceMinor: 15000,
			policyId: 'pol_1',
			status: 'published',
		})

		await db.insert(schema.rsvExperienceSchedules).values({
			id: 'exps_1',
			experienceId: 'exp_1',
			fromDate: '2026-05-01',
			toDate: '2026-05-31',
			seatingMins: [1080, 1230],
			turnMin: 120,
		})

		await db.insert(schema.rsvGuests).values([
			{
				id: 'gst_1',
				firstName: 'Sam',
				lastName: 'Rivera',
				phoneE164: '+14155550101',
				emailNorm: 'sam@example.com',
			},
			{
				id: 'gst_2',
				firstName: 'SamDuplicate',
				lastName: 'Rivera',
			},
		])

		await db.insert(schema.rsvTags).values([
			{
				id: 'tag_vip',
				scope: 'guest',
				category: 'vip',
				name: 'VIP',
			},
			{
				id: 'tag_bday',
				scope: 'reservation',
				category: 'occasion',
				name: 'Birthday',
				guestSelectable: true,
			},
		])

		await db.insert(schema.rsvGuestTags).values({
			guestId: 'gst_1',
			tagId: 'tag_vip',
		})

		await db.insert(schema.rsvGuestNotes).values({
			id: 'gn_1',
			guestId: 'gst_1',
			body: 'Prefers corner booth.',
			authorId: 'usr_1',
		})

		await db.insert(schema.rsvGuestMerges).values({
			id: 'gm_1',
			keptGuestId: 'gst_1',
			mergedGuestId: 'gst_2',
			actorId: 'usr_1',
			movedCounts: { reservations: 1 },
		})

		await db.insert(schema.rsvHolds).values({
			id: 'hld_1',
			locationId: 'loc_1',
			tokenHash: 'hash_hold_1',
			businessDate: '2026-05-01',
			localStartMin: 1140,
			startAt: 1_800_010_000_000,
			endAt: 1_800_015_400_000,
			partySize: 2,
			serviceId: 'svc_1',
			expiresAt: 1_800_000_420_000,
		})

		await db.insert(schema.rsvReservations).values({
			id: 'rsv_1',
			locationId: 'loc_1',
			guestId: 'gst_1',
			confirmationCode: 'MNZ-234567',
			businessDate: '2026-05-01',
			localStartMin: 1140,
			timeZone: 'America/New_York',
			startAt: 1_800_010_000_000,
			endAt: 1_800_015_400_000,
			durationMin: 90,
			serviceId: 'svc_1',
			partySize: 2,
			holdId: 'hld_1',
			occasionTagId: 'tag_bday',
		})

		await db.insert(schema.rsvReservationTags).values({
			reservationId: 'rsv_1',
			tagId: 'tag_bday',
		})

		await db.insert(schema.rsvTableOccupancies).values({
			id: 'occ_1',
			locationId: 'loc_1',
			tableId: 'tbl_1',
			kind: 'reservation',
			reservationId: 'rsv_1',
			startAt: 1_800_010_000_000,
			endAt: 1_800_015_400_000,
			active: true,
			overbook: false,
		})

		await db.insert(schema.rsvReservationEvents).values({
			id: 'evt_1',
			reservationId: 'rsv_1',
			actorKind: 'guest',
			type: 'created',
			toStatus: 'booked',
			data: { channel: 'online' },
		})

		await db.insert(schema.rsvServiceNotes).values({
			id: 'sn_1',
			locationId: 'loc_1',
			businessDate: '2026-05-01',
			serviceId: 'svc_1',
			body: '86 halibut tonight.',
		})

		await db.insert(schema.rsvWaitlistEntries).values({
			id: 'wl_1',
			locationId: 'loc_1',
			businessDate: '2026-05-01',
			guestId: 'gst_1',
			displayName: 'Sam R.',
			partySize: 2,
			sortKey: 1000,
		})

		await db.insert(schema.rsvNotifyRequests).values({
			id: 'nr_1',
			locationId: 'loc_1',
			businessDate: '2026-05-01',
			partySize: 2,
			fromLocalMin: 1080,
			toLocalMin: 1200,
			contactEmailNorm: 'sam@example.com',
			expiresAt: 1_800_020_000_000,
		})

		await db.insert(schema.rsvMessages).values({
			id: 'msg_1',
			locationId: 'loc_1',
			reservationId: 'rsv_1',
			kind: 'confirmation',
			channel: 'email',
			sendAt: 1_800_000_000_000,
			dedupeKey: 'rsv_1:confirmation:email:1',
		})

		await db.insert(schema.rsvPayments).values({
			id: 'pay_1',
			locationId: 'loc_1',
			reservationId: 'rsv_1',
			provider: 'stripe',
			kind: 'deposit_charge',
			amountMinor: 5000,
			currency: 'USD',
			providerRef: 'pi_test_1',
			idempotencyKey: 'idem_pay_1',
		})

		await db.insert(schema.rsvOutbox).values({
			id: 'out_1',
			kind: 'manager_alert',
			dedupeKey: 'alert:rsv_1',
			payload: { kind: 'large_party_request', locationId: 'loc_1', count: 1 },
		})

		await db.insert(schema.rsvJourneyEmissions).values({
			reservationId: 'rsv_1',
			eventType: 'reservation.visited',
		})

		await db.insert(schema.rsvIdempotencyKeys).values({
			scope: 'public_create',
			key: 'idem_1',
			requestHash: 'sha256_abc',
			statusCode: 201,
			responseJson: '{"id":"rsv_1"}',
			expiresAt: 1_800_090_000_000,
		})

		await db.insert(schema.rsvDayVersions).values({
			locationId: 'loc_1',
			businessDate: '2026-05-01',
			version: 1,
		})

		await db.insert(schema.rsvRateCounters).values({
			bucket: 'hold_ip',
			subjectHash: 'ip_hash_1',
			windowStart: 1_800_000_000_000,
			count: 1,
		})

		await db.insert(schema.rsvAuditLog).values({
			id: 'aud_1',
			actorKind: 'operator',
			actorId: 'usr_1',
			locationId: 'loc_1',
			action: 'settings.update',
			entityType: 'location_settings',
			entityId: 'loc_1',
			changes: { enabled: true },
		})

		const [savedReservation] = await db
			.select()
			.from(schema.rsvReservations)
			.where(eq(schema.rsvReservations.id, 'rsv_1'))
		expect(savedReservation?.confirmationCode).toBe('MNZ-234567')

		client.close()
	})

	it('enforces CHECK constraints and unique indexes across rsv_* tables (VAL-FND-010)', async () => {
		const { client, db } = await openMigratedDb()

		await db.insert(schema.rsvAreas).values({
			id: 'area_1',
			locationId: 'loc_1',
			name: 'Main',
		})

		// rsv_tables cover bounds check: min_covers >= 1 AND min_covers <= max_covers AND max_covers <= 99
		await expectRejectsWith(
			db.insert(schema.rsvTables).values({
				id: 'tbl_bad_min',
				locationId: 'loc_1',
				areaId: 'area_1',
				label: 'B1',
				minCovers: 0,
				maxCovers: 4,
			}),
			'chk_rsv_tables_covers',
		)
		await expectRejectsWith(
			db.insert(schema.rsvTables).values({
				id: 'tbl_bad_invert',
				locationId: 'loc_1',
				areaId: 'area_1',
				label: 'B2',
				minCovers: 6,
				maxCovers: 4,
			}),
			'chk_rsv_tables_covers',
		)
		await expectRejectsWith(
			db.insert(schema.rsvTables).values({
				id: 'tbl_bad_max',
				locationId: 'loc_1',
				areaId: 'area_1',
				label: 'B3',
				minCovers: 2,
				maxCovers: 100,
			}),
			'chk_rsv_tables_covers',
		)

		// rsv_tables reset_buffer_min check: BETWEEN 0 AND 120
		await expectRejectsWith(
			db.insert(schema.rsvTables).values({
				id: 'tbl_bad_buf_neg',
				locationId: 'loc_1',
				areaId: 'area_1',
				label: 'B4',
				minCovers: 2,
				maxCovers: 4,
				resetBufferMin: -5,
			}),
			'chk_rsv_tables_reset_buffer',
		)
		await expectRejectsWith(
			db.insert(schema.rsvTables).values({
				id: 'tbl_bad_buf_high',
				locationId: 'loc_1',
				areaId: 'area_1',
				label: 'B5',
				minCovers: 2,
				maxCovers: 4,
				resetBufferMin: 125,
			}),
			'chk_rsv_tables_reset_buffer',
		)

		// rsv_tables partial unique index on (location_id, label) WHERE archived_at IS NULL
		await db.insert(schema.rsvTables).values({
			id: 'tbl_ok_1',
			locationId: 'loc_1',
			areaId: 'area_1',
			label: 'T1',
		})
		await expectRejectsWith(
			db.insert(schema.rsvTables).values({
				id: 'tbl_dup',
				locationId: 'loc_1',
				areaId: 'area_1',
				label: 'T1',
			}),
			'UNIQUE',
		)
		// Archiving allows label reuse
		await db
			.update(schema.rsvTables)
			.set({ archivedAt: 1_800_000_000_000 })
			.where(eq(schema.rsvTables.id, 'tbl_ok_1'))
		await db.insert(schema.rsvTables).values({
			id: 'tbl_ok_2',
			locationId: 'loc_1',
			areaId: 'area_1',
			label: 'T1',
		})

		// rsv_services checks: first_seating_min <= last_seating_min <= end_min and span <= 1440
		await expectRejectsWith(
			db.insert(schema.rsvServices).values({
				id: 'svc_bad_order',
				locationId: 'loc_1',
				name: 'Bad Dinner',
				firstSeatingMin: 1200,
				lastSeatingMin: 1100,
				endMin: 1300,
			}),
			'chk_rsv_services_seating_order',
		)
		await expectRejectsWith(
			db.insert(schema.rsvServices).values({
				id: 'svc_bad_end',
				locationId: 'loc_1',
				name: 'Bad End',
				firstSeatingMin: 1000,
				lastSeatingMin: 1200,
				endMin: 1150,
			}),
			'chk_rsv_services_seating_order',
		)
		await expectRejectsWith(
			db.insert(schema.rsvServices).values({
				id: 'svc_bad_span',
				locationId: 'loc_1',
				name: 'Too Long',
				firstSeatingMin: 300,
				lastSeatingMin: 1700,
				endMin: 1750,
			}),
			'chk_rsv_services_max_span',
		)

		await db.insert(schema.rsvServices).values({
			id: 'svc_ok',
			locationId: 'loc_1',
			name: 'Dinner',
			firstSeatingMin: 1020,
			lastSeatingMin: 1320,
			endMin: 1410,
		})

		// rsv_service_availability single-owner check: area_id xor table_id xor combo_id
		await expectRejectsWith(
			db.insert(schema.rsvServiceAvailability).values({
				id: 'sa_none',
				serviceId: 'svc_ok',
				mode: 'online',
			}),
			'chk_rsv_service_availability_target',
		)
		await expectRejectsWith(
			db.insert(schema.rsvServiceAvailability).values({
				id: 'sa_two',
				serviceId: 'svc_ok',
				areaId: 'area_1',
				tableId: 'tbl_ok_2',
				mode: 'online',
			}),
			'chk_rsv_service_availability_target',
		)

		// rsv_blocks single-owner and time range checks
		await expectRejectsWith(
			db.insert(schema.rsvBlocks).values({
				id: 'blk_none',
				locationId: 'loc_1',
				businessDate: '2026-05-01',
				startAt: 1000,
				endAt: 2000,
			}),
			'chk_rsv_blocks_target',
		)
		await expectRejectsWith(
			db.insert(schema.rsvBlocks).values({
				id: 'blk_both',
				locationId: 'loc_1',
				areaId: 'area_1',
				tableId: 'tbl_ok_2',
				businessDate: '2026-05-01',
				startAt: 1000,
				endAt: 2000,
			}),
			'chk_rsv_blocks_target',
		)
		await expectRejectsWith(
			db.insert(schema.rsvBlocks).values({
				id: 'blk_bad_time',
				locationId: 'loc_1',
				tableId: 'tbl_ok_2',
				businessDate: '2026-05-01',
				startAt: 2000,
				endAt: 2000,
			}),
			'chk_rsv_blocks_time_range',
		)

		// rsv_reservations time range and party_size checks + unique confirmation_code & hold_id
		await db.insert(schema.rsvGuests).values({
			id: 'gst_1',
			firstName: 'Jordan',
		})
		await expectRejectsWith(
			db.insert(schema.rsvReservations).values({
				id: 'rsv_bad_time',
				locationId: 'loc_1',
				guestId: 'gst_1',
				confirmationCode: 'MNZ-BADTM1',
				businessDate: '2026-05-01',
				localStartMin: 1080,
				timeZone: 'UTC',
				startAt: 5000,
				endAt: 4000,
				durationMin: 90,
				partySize: 2,
			}),
			'chk_rsv_reservations_time_range',
		)
		await expectRejectsWith(
			db.insert(schema.rsvReservations).values({
				id: 'rsv_bad_party',
				locationId: 'loc_1',
				guestId: 'gst_1',
				confirmationCode: 'MNZ-BADPT1',
				businessDate: '2026-05-01',
				localStartMin: 1080,
				timeZone: 'UTC',
				startAt: 4000,
				endAt: 5000,
				durationMin: 90,
				partySize: 0,
			}),
			'chk_rsv_reservations_party_size',
		)

		await db.insert(schema.rsvReservations).values({
			id: 'rsv_ok',
			locationId: 'loc_1',
			guestId: 'gst_1',
			confirmationCode: 'MNZ-UNIQ01',
			businessDate: '2026-05-01',
			localStartMin: 1080,
			timeZone: 'UTC',
			startAt: 4000,
			endAt: 9000,
			durationMin: 90,
			partySize: 4,
			holdId: 'hld_uniq_1',
		})
		await expectRejectsWith(
			db.insert(schema.rsvReservations).values({
				id: 'rsv_dup_code',
				locationId: 'loc_1',
				guestId: 'gst_1',
				confirmationCode: 'MNZ-UNIQ01',
				businessDate: '2026-05-01',
				localStartMin: 1080,
				timeZone: 'UTC',
				startAt: 4000,
				endAt: 9000,
				durationMin: 90,
				partySize: 4,
			}),
			'UNIQUE',
		)
		await expectRejectsWith(
			db.insert(schema.rsvReservations).values({
				id: 'rsv_dup_hold',
				locationId: 'loc_1',
				guestId: 'gst_1',
				confirmationCode: 'MNZ-UNIQ02',
				businessDate: '2026-05-01',
				localStartMin: 1080,
				timeZone: 'UTC',
				startAt: 4000,
				endAt: 9000,
				durationMin: 90,
				partySize: 4,
				holdId: 'hld_uniq_1',
			}),
			'UNIQUE',
		)

		// rsv_table_occupancies owner check & time range check
		await expectRejectsWith(
			db.insert(schema.rsvTableOccupancies).values({
				id: 'occ_bad_owner',
				locationId: 'loc_1',
				tableId: 'tbl_ok_2',
				kind: 'reservation',
				// missing reservationId
				startAt: 4000,
				endAt: 9000,
			}),
			'chk_rsv_table_occupancies_owner',
		)
		await expectRejectsWith(
			db.insert(schema.rsvTableOccupancies).values({
				id: 'occ_bad_time',
				locationId: 'loc_1',
				tableId: 'tbl_ok_2',
				kind: 'reservation',
				reservationId: 'rsv_ok',
				startAt: 9000,
				endAt: 4000,
			}),
			'chk_rsv_table_occupancies_time_range',
		)

		// rsv_turn_times unique index (including null serviceId and daysMask)
		await db.insert(schema.rsvTurnTimes).values({
			id: 'tt_null_1',
			locationId: 'loc_1',
			serviceId: null,
			partyMin: 1,
			partyMax: 2,
			minutes: 60,
			daysMask: null,
		})
		await expectRejectsWith(
			db.insert(schema.rsvTurnTimes).values({
				id: 'tt_null_2',
				locationId: 'loc_1',
				serviceId: null,
				partyMin: 1,
				partyMax: 2,
				minutes: 75,
				daysMask: null,
			}),
			'UNIQUE',
		)

		// rsv_section_tables (layout_id, table_id) unique index
		await db.insert(schema.rsvSectionLayouts).values({
			id: 'lay_1',
			locationId: 'loc_1',
			name: 'Floor 1',
		})
		await db.insert(schema.rsvSections).values([
			{ id: 'sec_1', layoutId: 'lay_1', name: 'A' },
			{ id: 'sec_2', layoutId: 'lay_1', name: 'B' },
		])
		await db.insert(schema.rsvSectionTables).values({
			sectionId: 'sec_1',
			tableId: 'tbl_ok_2',
			layoutId: 'lay_1',
		})
		await expectRejectsWith(
			db.insert(schema.rsvSectionTables).values({
				sectionId: 'sec_2',
				tableId: 'tbl_ok_2',
				layoutId: 'lay_1',
			}),
			'UNIQUE',
		)

		// rsv_section_assignments (business_date, service_id, section_id) unique index
		await db.insert(schema.rsvSectionAssignments).values({
			id: 'sa_ok_1',
			locationId: 'loc_1',
			businessDate: '2026-05-01',
			serviceId: 'svc_ok',
			sectionId: 'sec_1',
		})
		await expectRejectsWith(
			db.insert(schema.rsvSectionAssignments).values({
				id: 'sa_dup_1',
				locationId: 'loc_1',
				businessDate: '2026-05-01',
				serviceId: 'svc_ok',
				sectionId: 'sec_1',
			}),
			'UNIQUE',
		)

		// rsv_message_texts (location_id, kind, locale) including null location_id
		await db.insert(schema.rsvMessageTexts).values({
			id: 'mt_org_1',
			locationId: null,
			kind: 'confirmation',
			locale: 'en',
			customNote: 'Org default',
		})
		await expectRejectsWith(
			db.insert(schema.rsvMessageTexts).values({
				id: 'mt_org_2',
				locationId: null,
				kind: 'confirmation',
				locale: 'en',
				customNote: 'Dup org default',
			}),
			'UNIQUE',
		)

		// rsv_experiences (location_id, slug) WHERE status <> 'archived'
		await db.insert(schema.rsvExperiences).values({
			id: 'exp_1',
			locationId: 'loc_1',
			slug: 'tasting-menu',
			kind: 'prix_fixe',
			status: 'published',
		})
		await expectRejectsWith(
			db.insert(schema.rsvExperiences).values({
				id: 'exp_dup',
				locationId: 'loc_1',
				slug: 'tasting-menu',
				kind: 'prix_fixe',
				status: 'draft',
			}),
			'UNIQUE',
		)
		await db
			.update(schema.rsvExperiences)
			.set({ status: 'archived' })
			.where(eq(schema.rsvExperiences.id, 'exp_1'))
		await db.insert(schema.rsvExperiences).values({
			id: 'exp_2',
			locationId: 'loc_1',
			slug: 'tasting-menu',
			kind: 'prix_fixe',
			status: 'draft',
		})

		// rsv_guests (customer_id) WHERE customer_id IS NOT NULL
		await db.insert(schema.customers).values({
			id: 'cust_1',
			name: 'Customer One',
		})
		await db.insert(schema.rsvGuests).values({
			id: 'gst_cust_1',
			customerId: 'cust_1',
			firstName: 'Customer',
		})
		await expectRejectsWith(
			db.insert(schema.rsvGuests).values({
				id: 'gst_cust_2',
				customerId: 'cust_1',
				firstName: 'DuplicateCustomer',
			}),
			'UNIQUE',
		)

		// rsv_tags (system_key) WHERE system_key IS NOT NULL
		await db.insert(schema.rsvTags).values({
			id: 'tag_sys_1',
			scope: 'guest',
			category: 'system',
			name: 'First Visit',
			systemKey: 'first_visit',
		})
		await expectRejectsWith(
			db.insert(schema.rsvTags).values({
				id: 'tag_sys_2',
				scope: 'guest',
				category: 'system',
				name: 'First Visit Dup',
				systemKey: 'first_visit',
			}),
			'UNIQUE',
		)

		// rsv_holds (token_hash)
		await db.insert(schema.rsvHolds).values({
			id: 'hld_u1',
			locationId: 'loc_1',
			tokenHash: 'tok_u1',
			businessDate: '2026-05-01',
			localStartMin: 1080,
			startAt: 4000,
			endAt: 9000,
			partySize: 2,
			expiresAt: 9500,
		})
		await expectRejectsWith(
			db.insert(schema.rsvHolds).values({
				id: 'hld_u2',
				locationId: 'loc_1',
				tokenHash: 'tok_u1',
				businessDate: '2026-05-01',
				localStartMin: 1080,
				startAt: 4000,
				endAt: 9000,
				partySize: 2,
				expiresAt: 9500,
			}),
			'UNIQUE',
		)

		// rsv_service_notes (location_id, business_date, service_id) including null service_id
		await db.insert(schema.rsvServiceNotes).values({
			id: 'sn_day_1',
			locationId: 'loc_1',
			businessDate: '2026-05-01',
			serviceId: null,
			body: 'General day note',
		})
		await expectRejectsWith(
			db.insert(schema.rsvServiceNotes).values({
				id: 'sn_day_2',
				locationId: 'loc_1',
				businessDate: '2026-05-01',
				serviceId: null,
				body: 'Duplicate general day note',
			}),
			'UNIQUE',
		)

		// rsv_messages (dedupe_key)
		await db.insert(schema.rsvMessages).values({
			id: 'msg_u1',
			locationId: 'loc_1',
			kind: 'confirmation',
			channel: 'email',
			sendAt: 1000,
			dedupeKey: 'dedupe_1',
		})
		await expectRejectsWith(
			db.insert(schema.rsvMessages).values({
				id: 'msg_u2',
				locationId: 'loc_1',
				kind: 'confirmation',
				channel: 'email',
				sendAt: 1000,
				dedupeKey: 'dedupe_1',
			}),
			'UNIQUE',
		)

		// rsv_payments (idempotency_key) and (provider, provider_ref) WHERE provider_ref IS NOT NULL
		await db.insert(schema.rsvPayments).values({
			id: 'pay_u1',
			locationId: 'loc_1',
			reservationId: 'rsv_ok',
			provider: 'stripe',
			kind: 'deposit_charge',
			providerRef: 'pi_uniq_1',
			idempotencyKey: 'idem_u1',
		})
		await expectRejectsWith(
			db.insert(schema.rsvPayments).values({
				id: 'pay_u2',
				locationId: 'loc_1',
				reservationId: 'rsv_ok',
				provider: 'stripe',
				kind: 'deposit_charge',
				providerRef: 'pi_uniq_2',
				idempotencyKey: 'idem_u1',
			}),
			'UNIQUE',
		)
		await expectRejectsWith(
			db.insert(schema.rsvPayments).values({
				id: 'pay_u3',
				locationId: 'loc_1',
				reservationId: 'rsv_ok',
				provider: 'stripe',
				kind: 'deposit_charge',
				providerRef: 'pi_uniq_1',
				idempotencyKey: 'idem_u3',
			}),
			'UNIQUE',
		)

		// 0019: a provider session binds to one payment row, and the new
		// columns default so older rows stay valid.
		await db.insert(schema.rsvPayments).values({
			id: 'pay_s1',
			locationId: 'loc_1',
			reservationId: 'rsv_ok',
			provider: 'stripe',
			kind: 'deposit_charge',
			providerSessionId: 'cs_uniq_1',
			idempotencyKey: 'idem_s1',
		})
		await expectRejectsWith(
			db.insert(schema.rsvPayments).values({
				id: 'pay_s2',
				locationId: 'loc_1',
				reservationId: 'rsv_ok',
				provider: 'stripe',
				kind: 'deposit_charge',
				providerSessionId: 'cs_uniq_1',
				idempotencyKey: 'idem_s2',
			}),
			'UNIQUE',
		)
		const defaults = await db
			.select()
			.from(schema.rsvPayments)
			.where(eq(schema.rsvPayments.id, 'pay_s1'))
			.get()
		expect(defaults).toMatchObject({
			refundedMinor: 0,
			platformFeeBp: 0,
			attempt: 1,
			version: 1,
			declineCode: null,
			parentPaymentId: null,
		})

		// rsv_outbox (dedupe_key)
		await db.insert(schema.rsvOutbox).values({
			id: 'out_u1',
			kind: 'manager_alert',
			dedupeKey: 'out_dedupe_1',
			payload: { ok: true },
		})
		await expectRejectsWith(
			db.insert(schema.rsvOutbox).values({
				id: 'out_u2',
				kind: 'manager_alert',
				dedupeKey: 'out_dedupe_1',
				payload: { ok: true },
			}),
			'UNIQUE',
		)

		client.close()
	})

	it('enforces table occupancy overlap triggers and allows back-to-back, overbook = 1, and active = 0 (VAL-FND-011)', async () => {
		const { client, db } = await openMigratedDb()

		await db.insert(schema.rsvAreas).values({
			id: 'area_1',
			locationId: 'loc_1',
			name: 'Main',
		})
		await db.insert(schema.rsvTables).values([
			{ id: 'tbl_1', locationId: 'loc_1', areaId: 'area_1', label: 'T1' },
			{ id: 'tbl_2', locationId: 'loc_1', areaId: 'area_1', label: 'T2' },
		])
		await db.insert(schema.rsvGuests).values({
			id: 'gst_1',
			firstName: 'Taylor',
		})

		for (const id of ['rsv_1', 'rsv_2', 'rsv_3', 'rsv_4', 'rsv_5']) {
			await db.insert(schema.rsvReservations).values({
				id,
				locationId: 'loc_1',
				guestId: 'gst_1',
				confirmationCode: `CODE-${id}`,
				businessDate: '2026-05-01',
				localStartMin: 1080,
				timeZone: 'UTC',
				startAt: 1000,
				endAt: 2000,
				durationMin: 60,
				partySize: 2,
			})
		}

		// Base occupancy on tbl_1: [1000, 2000)
		await db.insert(schema.rsvTableOccupancies).values({
			id: 'occ_base',
			locationId: 'loc_1',
			tableId: 'tbl_1',
			kind: 'reservation',
			reservationId: 'rsv_1',
			startAt: 1000,
			endAt: 2000,
			active: true,
			overbook: false,
		})

		// 1. Overlapping INSERT on same table with active=1, overbook=0 fails with 'rsv_table_occupancies overlap'
		await expectRejectsWith(
			db.insert(schema.rsvTableOccupancies).values({
				id: 'occ_overlap',
				locationId: 'loc_1',
				tableId: 'tbl_1',
				kind: 'reservation',
				reservationId: 'rsv_2',
				startAt: 1500,
				endAt: 2500,
				active: true,
				overbook: false,
			}),
			'rsv_table_occupancies overlap',
		)

		// 2. Back-to-back INSERT [2000, 3000) and [500, 1000) succeeds
		await db.insert(schema.rsvTableOccupancies).values({
			id: 'occ_after',
			locationId: 'loc_1',
			tableId: 'tbl_1',
			kind: 'reservation',
			reservationId: 'rsv_2',
			startAt: 2000,
			endAt: 3000,
			active: true,
			overbook: false,
		})
		await db.insert(schema.rsvTableOccupancies).values({
			id: 'occ_before',
			locationId: 'loc_1',
			tableId: 'tbl_1',
			kind: 'reservation',
			reservationId: 'rsv_3',
			startAt: 500,
			endAt: 1000,
			active: true,
			overbook: false,
		})

		// 3. Overlapping UPDATE into [1000, 2000) fails with 'rsv_table_occupancies overlap'
		await expectRejectsWith(
			db
				.update(schema.rsvTableOccupancies)
				.set({ startAt: 1800 })
				.where(eq(schema.rsvTableOccupancies.id, 'occ_after')),
			'rsv_table_occupancies overlap',
		)

		// 4. Updating a row's own window without overlapping others succeeds
		await db
			.update(schema.rsvTableOccupancies)
			.set({ endAt: 3200 })
			.where(eq(schema.rsvTableOccupancies.id, 'occ_after'))

		// 5. Overlapping INSERT with overbook = 1 succeeds
		await db.insert(schema.rsvTableOccupancies).values({
			id: 'occ_overbook',
			locationId: 'loc_1',
			tableId: 'tbl_1',
			kind: 'reservation',
			reservationId: 'rsv_4',
			startAt: 1200,
			endAt: 1800,
			active: true,
			overbook: true,
		})

		// 5b. Normal (overbook = 0) INSERT and UPDATE overlapping an overbook = 1 row succeeds
		await db.insert(schema.rsvTableOccupancies).values({
			id: 'occ_overbook_solo',
			locationId: 'loc_1',
			tableId: 'tbl_1',
			kind: 'reservation',
			reservationId: 'rsv_4',
			startAt: 4000,
			endAt: 5000,
			active: true,
			overbook: true,
		})
		await db.insert(schema.rsvTableOccupancies).values({
			id: 'occ_normal_over_overbook',
			locationId: 'loc_1',
			tableId: 'tbl_1',
			kind: 'reservation',
			reservationId: 'rsv_5',
			startAt: 4200,
			endAt: 4800,
			active: true,
			overbook: false,
		})
		await db
			.update(schema.rsvTableOccupancies)
			.set({ startAt: 4100, endAt: 4900 })
			.where(eq(schema.rsvTableOccupancies.id, 'occ_normal_over_overbook'))

		// 6. Overlapping INSERT with active = 0 succeeds
		await db.insert(schema.rsvTableOccupancies).values({
			id: 'occ_inactive',
			locationId: 'loc_1',
			tableId: 'tbl_1',
			kind: 'reservation',
			reservationId: 'rsv_5',
			startAt: 1200,
			endAt: 1800,
			active: false,
			overbook: false,
		})

		// Reactivating that inactive row while [1000, 2000) is active fails with 'rsv_table_occupancies overlap'
		await expectRejectsWith(
			db
				.update(schema.rsvTableOccupancies)
				.set({ active: true })
				.where(eq(schema.rsvTableOccupancies.id, 'occ_inactive')),
			'rsv_table_occupancies overlap',
		)

		// 7. Overlapping window on a different table (tbl_2) succeeds
		await db.insert(schema.rsvTableOccupancies).values({
			id: 'occ_other_table',
			locationId: 'loc_1',
			tableId: 'tbl_2',
			kind: 'reservation',
			reservationId: 'rsv_5',
			startAt: 1000,
			endAt: 2000,
			active: true,
			overbook: false,
		})

		client.close()
	})

	it('enforces single hold conversion and append-only event/audit/merge triggers with redaction exception (VAL-FND-012)', async () => {
		const { client, db } = await openMigratedDb()

		// 1. rsv_holds single conversion
		await db.insert(schema.rsvHolds).values({
			id: 'hld_1',
			locationId: 'loc_1',
			tokenHash: 'tok_hash_1',
			businessDate: '2026-05-01',
			localStartMin: 1140,
			startAt: 1000,
			endAt: 2000,
			partySize: 2,
			status: 'active',
			expiresAt: 9000,
		})

		// First conversion succeeds
		await db
			.update(schema.rsvHolds)
			.set({ status: 'converted', reservationId: 'rsv_1' })
			.where(eq(schema.rsvHolds.id, 'hld_1'))

		// Second conversion fails with 'hold_already_converted'
		await expectRejectsWith(
			db
				.update(schema.rsvHolds)
				.set({ status: 'converted', reservationId: 'rsv_2' })
				.where(eq(schema.rsvHolds.id, 'hld_1')),
			'hold_already_converted',
		)

		// Updating a converted hold to any other status (e.g. 'expired' or 'released') also fails with 'hold_already_converted'
		await expectRejectsWith(
			db
				.update(schema.rsvHolds)
				.set({ status: 'expired' })
				.where(eq(schema.rsvHolds.id, 'hld_1')),
			'hold_already_converted',
		)

		// 2. rsv_reservation_events append-only + redaction exception
		await db.insert(schema.rsvGuests).values([
			{ id: 'gst_1', firstName: 'Casey' },
			{ id: 'gst_2', firstName: 'Casey2' },
		])
		await db.insert(schema.rsvReservations).values({
			id: 'rsv_1',
			locationId: 'loc_1',
			guestId: 'gst_1',
			confirmationCode: 'MNZ-EVT001',
			businessDate: '2026-05-01',
			localStartMin: 1140,
			timeZone: 'UTC',
			startAt: 1000,
			endAt: 2000,
			durationMin: 60,
			partySize: 2,
		})
		await db.insert(schema.rsvReservationEvents).values({
			id: 'evt_1',
			reservationId: 'rsv_1',
			actorKind: 'guest',
			type: 'note',
			data: { note: 'Secret allergy info' },
		})

		// DELETE on rsv_reservation_events fails with 'append_only'
		await expectRejectsWith(
			db
				.delete(schema.rsvReservationEvents)
				.where(eq(schema.rsvReservationEvents.id, 'evt_1')),
			'append_only',
		)

		// Arbitrary UPDATE on rsv_reservation_events fails with 'append_only'
		await expectRejectsWith(
			db
				.update(schema.rsvReservationEvents)
				.set({ data: { note: 'Tampered' } })
				.where(eq(schema.rsvReservationEvents.id, 'evt_1')),
			'append_only',
		)

		// Redaction UPDATE setting data = '{"redacted":true}' while mutating type still fails
		await expectRejectsWith(
			client.execute({
				sql: `UPDATE rsv_reservation_events SET data = '{"redacted":true}', type = 'created' WHERE id = 'evt_1'`,
				args: [],
			}),
			'append_only',
		)

		// Redaction UPDATE setting data = '{"redacted":true}' succeeds
		await client.execute({
			sql: `UPDATE rsv_reservation_events SET data = '{"redacted":true}' WHERE id = 'evt_1'`,
			args: [],
		})
		const [redactedEvent] = await db
			.select()
			.from(schema.rsvReservationEvents)
			.where(eq(schema.rsvReservationEvents.id, 'evt_1'))
		expect(redactedEvent?.data).toEqual({ redacted: true })

		// 3. rsv_audit_log append-only + redaction exception
		await db.insert(schema.rsvAuditLog).values({
			id: 'aud_1',
			actorKind: 'operator',
			actorId: 'usr_1',
			locationId: 'loc_1',
			action: 'guest.update',
			entityType: 'guest',
			entityId: 'gst_1',
			changes: { field: 'notes' },
		})

		await expectRejectsWith(
			db.delete(schema.rsvAuditLog).where(eq(schema.rsvAuditLog.id, 'aud_1')),
			'append_only',
		)
		await expectRejectsWith(
			db
				.update(schema.rsvAuditLog)
				.set({ action: 'tampered' })
				.where(eq(schema.rsvAuditLog.id, 'aud_1')),
			'append_only',
		)
		await client.execute({
			sql: `UPDATE rsv_audit_log SET changes = '{"redacted":true}' WHERE id = 'aud_1'`,
			args: [],
		})
		const [redactedAudit] = await db
			.select()
			.from(schema.rsvAuditLog)
			.where(eq(schema.rsvAuditLog.id, 'aud_1'))
		expect(redactedAudit?.changes).toEqual({ redacted: true })

		// 4. rsv_guest_merges append-only (no delete, no update)
		await db.insert(schema.rsvGuestMerges).values({
			id: 'mrg_1',
			keptGuestId: 'gst_1',
			mergedGuestId: 'gst_2',
			actorId: 'usr_1',
			movedCounts: { reservations: 2 },
		})

		await expectRejectsWith(
			db
				.delete(schema.rsvGuestMerges)
				.where(eq(schema.rsvGuestMerges.id, 'mrg_1')),
			'append_only',
		)
		await expectRejectsWith(
			db
				.update(schema.rsvGuestMerges)
				.set({ actorId: 'usr_2' })
				.where(eq(schema.rsvGuestMerges.id, 'mrg_1')),
			'append_only',
		)

		client.close()
	})
})
