import { type ReportField, type ReportSubject } from './catalog.ts'

/**
 * Inventory report subjects (#507): regional tenant database in tenant-api,
 * gated by `inventory.enabled` + `read:inventory:any` + `read:inventory_cost:any`.
 * Shares the exact underlying query & totals computation with the Purchasing
 * "Export for accountant" endpoint so totals match identically.
 */
export const INVENTORY_REPORT_SUBJECTS = ['inventory_deliveries'] as const
export type InventoryReportSubject = (typeof INVENTORY_REPORT_SUBJECTS)[number]

export function isInventoryReportSubject(
	subject: string,
): subject is InventoryReportSubject {
	return INVENTORY_REPORT_SUBJECTS.some((item) => item === subject)
}

const deliveryFields: ReportField[] = [
	{
		id: 'receivedAt',
		label: 'Received at',
		type: 'datetime',
		timeframe: true,
		groupable: true,
		showTime: true,
	},
	{
		id: 'businessDate',
		label: 'Business date',
		type: 'string',
		filterable: true,
		groupable: true,
	},
	{
		id: 'invoiceDate',
		label: 'Invoice date',
		type: 'string',
		filterable: true,
		groupable: true,
	},
	{
		id: 'location',
		label: 'Location',
		type: 'string',
		filterable: true,
		groupable: true,
	},
	{
		id: 'supplierName',
		label: 'Supplier',
		type: 'string',
		filterable: true,
		groupable: true,
	},
	{
		id: 'supplierVatNumber',
		label: 'Supplier VAT number',
		type: 'string',
		filterable: true,
		groupable: true,
	},
	{
		id: 'invoiceNumber',
		label: 'Invoice number',
		type: 'string',
		filterable: true,
	},
	{
		id: 'zatcaReference',
		label: 'ZATCA reference',
		type: 'string',
		filterable: true,
	},
	{
		id: 'paid',
		label: 'Paid',
		type: 'boolean',
		filterable: true,
		groupable: true,
	},
	{
		id: 'isCredit',
		label: 'Credit / return',
		type: 'boolean',
		filterable: true,
		groupable: true,
	},
	{
		id: 'netMinor',
		label: 'Net',
		type: 'currency',
		sumLabel: 'Net purchases',
	},
	{
		id: 'vatMinor',
		label: 'VAT',
		type: 'currency',
		sumLabel: 'VAT',
	},
	{
		id: 'totalMinor',
		label: 'Total',
		type: 'currency',
		sumLabel: 'Total purchases',
	},
	{
		id: 'currency',
		label: 'Currency',
		type: 'string',
		listable: false,
	},
]

export const inventoryReportSubjects: ReportSubject[] = [
	{
		id: 'inventory_deliveries',
		label: 'Deliveries',
		description:
			'Received deliveries and supplier credits with net, VAT, total, ZATCA reference and paid state.',
		scope: 'organization',
		source: 'tenant-api',
		fields: deliveryFields,
		currencyField: 'currency',
		splitCurrencies: true,
		defaultColumns: [
			'businessDate',
			'supplierName',
			'invoiceNumber',
			'zatcaReference',
			'netMinor',
			'vatMinor',
			'totalMinor',
			'paid',
		],
	},
]
