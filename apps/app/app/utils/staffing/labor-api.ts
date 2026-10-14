import { type SalesSource } from '@repo/staffing'
import {
	bulkResultSchema,
	exportSchema,
	salesEntrySchema,
	settingsSchema,
	tipSettingsSchema,
	type BulkResult,
	type LaborSettings,
	type SalesEntry,
	type TipSettings,
} from './labor-types.ts'
import { type StaffClient } from './staff-client.ts'

/**
 * The labor writes, one function each, over the browser-direct client. Every
 * response is parsed, so a node that answers something unexpected fails loudly
 * here instead of half-updating a screen.
 */

export async function saveSettings(
	client: StaffClient,
	body: {
		scopeId: string
		salesSource?: SalesSource
		ordersPerLaborHour?: Record<string, number>
	},
): Promise<LaborSettings> {
	return settingsSchema.parse(
		await client.request('/settings', { method: 'PUT', json: body }),
	)
}

export async function saveSale(
	client: StaffClient,
	body: {
		scopeId: string
		date: string
		netSalesMinor: number
		currency: string
		note?: string | null
	},
): Promise<SalesEntry> {
	return salesEntrySchema.parse(
		await client.request('/sales', { method: 'PUT', json: body }),
	)
}

export async function deleteSale(
	client: StaffClient,
	input: { scopeId: string; date: string },
): Promise<void> {
	const query = new URLSearchParams(input)
	await client.request(`/sales?${query.toString()}`, { method: 'DELETE' })
}

export async function saveSalesBulk(
	client: StaffClient,
	body: {
		scopeId: string
		currency: string
		entries: Array<{
			date: string
			netSalesMinor: number
			note?: string | null
		}>
	},
): Promise<BulkResult> {
	return bulkResultSchema.parse(
		await client.request('/sales/bulk', { method: 'POST', json: body }),
	)
}

export async function saveTipSettings(
	client: StaffClient,
	body: Omit<TipSettings, 'configured' | 'updatedAt'>,
): Promise<TipSettings> {
	return tipSettingsSchema.parse(
		await client.request('/tips/settings', { method: 'PUT', json: body }),
	)
}

export async function fetchExport(client: StaffClient, path: string) {
	return exportSchema.parse(await client.request(path))
}
