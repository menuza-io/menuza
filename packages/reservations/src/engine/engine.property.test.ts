import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { assignTables } from '../assign.ts'
import { searchAvailability } from '../engine.ts'
import {
	arbitraryDayScenario,
	bruteForceAssignExists,
	verifyDayInvariants,
} from '../testing/index.ts'

describe('reservations engine fast-check property tests against brute-force oracle', () => {
	it('preserves invariants I1-I7 and matches the brute-force oracle across 300 random day scenarios', () => {
		const rawSeed = (
			globalThis as {
				process?: { env?: Record<string, string | undefined> }
			}
		).process?.env?.FC_SEED
		const envSeed = rawSeed ? Number.parseInt(rawSeed, 10) : undefined

		fc.assert(
			fc.property(arbitraryDayScenario(), (scenario) => {
				// 1. Verify existing bookings in scenario satisfy invariants I1-I7
				const initialCheck = verifyDayInvariants({
					config: scenario.config,
					existingBookings: scenario.existingBookings,
					existingHolds: scenario.existingHolds,
					tableBlocks: scenario.tableBlocks,
					nowMs: scenario.nowMs,
				})
				expect(initialCheck.valid).toBe(true)

				// 2. Run assignTables for the probe request
				const assigned = assignTables({
					config: scenario.config,
					request: scenario.probeRequest,
					existingBookings: scenario.existingBookings,
					existingHolds: scenario.existingHolds,
					tableBlocks: scenario.tableBlocks,
					nowMs: scenario.nowMs,
				})

				// 3. Compare against brute-force oracle (direct single/combo + 1-step & 2-step swap)
				const oracleHasSolution = bruteForceAssignExists({
					config: scenario.config,
					request: scenario.probeRequest,
					existingBookings: scenario.existingBookings,
					existingHolds: scenario.existingHolds,
					tableBlocks: scenario.tableBlocks,
					nowMs: scenario.nowMs,
				})

				if (assigned.assigned) {
					expect(assigned.expansions).toBeLessThanOrEqual(200)
					expect(oracleHasSolution).toBe(true)

					// Apply assignment and any swaps to existing bookings and verify all invariants I1-I7
					const swapMap = new Map(
						assigned.swaps.map((s) => [s.bookingId, s] as const),
					)
					const updatedBookings = scenario.existingBookings.map((b) => {
						const swap = swapMap.get(b.id)
						if (!swap) return b
						return {
							...b,
							tableIds: [...swap.toTableIds],
							combinationId: swap.toCombinationId,
						}
					})
					updatedBookings.push({
						id: 'probe_booking',
						kind: 'reservation',
						serviceId: scenario.probeRequest.serviceId,
						localStartMin: scenario.probeRequest.slotMin,
						startAt: scenario.probeRequest.startAt,
						endAt: scenario.probeRequest.endAt,
						partySize: scenario.probeRequest.partySize,
						status: 'confirmed',
						tableIds: [...assigned.tableIds],
						combinationId: assigned.combinationId,
						tableLocked: false,
					})

					const postCheck = verifyDayInvariants({
						config: scenario.config,
						existingBookings: updatedBookings,
						existingHolds: scenario.existingHolds,
						tableBlocks: scenario.tableBlocks,
						nowMs: scenario.nowMs,
					})
					expect(postCheck.valid).toBe(true)
				} else {
					// When our engine returns assigned: false on this small floor (<= 6 tables, well under 200 expansions),
					// the brute-force oracle must also find no valid assignment.
					expect(oracleHasSolution).toBe(false)
				}

				// 4. Verify searchAvailability never returns an available slot without valid tableIds
				const availability = searchAvailability({
					config: scenario.config,
					businessDate: scenario.probeRequest.businessDate,
					partySize: scenario.probeRequest.partySize,
					preferredSlotMin: scenario.probeRequest.slotMin,
					channel: scenario.probeRequest.channel,
					seatingPreference: scenario.probeRequest.seatingPreference,
					requestedAttributes: scenario.probeRequest.requestedAttributes,
					existingBookings: scenario.existingBookings,
					existingHolds: scenario.existingHolds,
					tableBlocks: scenario.tableBlocks,
					nowMs: scenario.nowMs,
				})
				for (const slot of availability.slots) {
					expect(slot.tableIds.length).toBeGreaterThan(0)
				}
			}),
			{
				numRuns: 300,
				...(envSeed !== undefined && Number.isFinite(envSeed)
					? { seed: envSeed }
					: {}),
			},
		)
	})
})
