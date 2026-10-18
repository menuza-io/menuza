import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import {
	type ReportByKind,
	type ReportKind,
} from '#app/utils/reservations/reports-api.ts'

type Cell = string | number | null
export type ReportTable = { header: MessageDescriptor[]; rows: Cell[][] }

/**
 * The main table of each report as plain rows, for a CSV download. Reports
 * carry no guest contact details, so neither does the export. Values stay
 * machine-readable (ISO dates, plain numbers).
 */
export function reportTable<K extends ReportKind>(
	kind: K,
	report: ReportByKind[K],
): ReportTable {
	switch (kind) {
		case 'summary': {
			const r = report as ReportByKind['summary']
			return {
				header: [msg`Service`, msg`Parties`, msg`Covers`],
				rows: r.byService.map((row) => [row.name, row.parties, row.covers]),
			}
		}
		case 'no-shows': {
			const r = report as ReportByKind['no-shows']
			return {
				header: [msg`Date`, msg`Time`, msg`Service`, msg`Party`, msg`Source`],
				rows: r.rows.map((row) => [
					row.businessDate,
					row.time,
					row.service,
					row.partySize,
					row.channel,
				]),
			}
		}
		case 'cancellations': {
			const r = report as ReportByKind['cancellations']
			return {
				header: [
					msg`Date`,
					msg`Time`,
					msg`Service`,
					msg`Party`,
					msg`Cancelled by`,
					msg`Late`,
				],
				rows: r.rows.map((row) => [
					row.businessDate,
					row.time,
					row.service,
					row.partySize,
					row.cancelledBy,
					row.late ? 1 : 0,
				]),
			}
		}
		case 'turn-times': {
			const r = report as ReportByKind['turn-times']
			return {
				header: [
					msg`Party size`,
					msg`Parties`,
					msg`Actual (min)`,
					msg`Configured (min)`,
					msg`Booked (min)`,
					msg`Difference (min)`,
				],
				rows: r.byPartySize.map((row) => [
					row.partySize,
					row.count,
					row.actualAvgMin,
					row.configuredMin,
					row.bookedAvgMin,
					row.varianceMin,
				]),
			}
		}
		case 'waitlist': {
			const r = report as ReportByKind['waitlist']
			return {
				header: [
					msg`Date`,
					msg`Party`,
					msg`Outcome`,
					msg`Quoted (min)`,
					msg`Actual (min)`,
				],
				rows: r.rows.map((row) => [
					row.businessDate,
					row.partySize,
					row.outcome,
					row.quotedMin,
					row.actualMin,
				]),
			}
		}
		case 'pacing': {
			const r = report as ReportByKind['pacing']
			return {
				header: [
					msg`Date`,
					msg`Time`,
					msg`Service`,
					msg`Bookings`,
					msg`Covers`,
					msg`Max covers`,
					msg`Max parties`,
				],
				rows: r.slots.map((row) => [
					row.businessDate,
					row.time,
					row.service,
					row.bookings,
					row.covers,
					row.maxCovers,
					row.maxParties,
				]),
			}
		}
		default:
			return { header: [], rows: [] }
	}
}

/** Text cells that a spreadsheet would run as a formula get a leading quote. */
function csvCell(value: Cell): string {
	if (value === null) return ''
	if (typeof value === 'number') return String(value)
	const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
	return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

export function reportCsv(
	table: ReportTable,
	translate: (descriptor: MessageDescriptor) => string,
): string {
	const lines = [
		table.header.map((cell) => csvCell(translate(cell))).join(','),
		...table.rows.map((row) => row.map(csvCell).join(',')),
	]
	return `${lines.join('\r\n')}\r\n`
}

/** Triggers a browser download of text; returns false when there is no DOM. */
export function downloadCsv(filename: string, csv: string): boolean {
	if (typeof document === 'undefined') return false
	const blob = new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' })
	const url = URL.createObjectURL(blob)
	const link = document.createElement('a')
	link.href = url
	link.download = filename
	document.body.appendChild(link)
	link.click()
	link.remove()
	URL.revokeObjectURL(url)
	return true
}
