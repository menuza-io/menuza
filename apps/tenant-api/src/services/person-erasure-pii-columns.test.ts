import * as schema from '@repo/tenant-db'
import { getTableConfig } from 'drizzle-orm/sqlite-core'
import { describe, expect, it } from 'vitest'

/**
 * Schema-driven guard for the person erasure flow (`person-erasure-service.ts`).
 *
 * Every column of every table in the regional tenant schema whose name looks
 * like personal data must be either COVERED by the erasure (with a note on how)
 * or explicitly ALLOWED (with the reason it is not a customer's data). Adding a
 * table or a column that looks like PII fails this test until someone decides
 * which one it is. The behavioral twin is `person-erasure.test.ts`, which seeds
 * a person across the tables and scans a dump of the whole database.
 */

const PII_COLUMN =
	/((^|_)phone|(^|_)email|first_name|last_name|full_name|display_name|caller_name|contact_name|address|postal|_lat$|_lng$|^lat$|^lng$|ip_hash|stripe_|last4|payment_method|customer_ref|card_|allerg|dietary|guest_requests|staff_notes|^transcript$|^summary$|^values$|^details$|^body$|^notes?$|token_hash|date_of_birth|^name$|staff_name$|guest_name)/

/** Columns the erasure removes or scrubs, and how. */
const COVERED: Record<string, string> = {
	'pos_orders.customer_phone':
		'scrubbed by normalised phone; omitted from revision history and held records, also expires after 30 days',
	'customers.name': 'row deleted',
	'customers.email': 'row deleted',
	'customers.phone': 'row deleted',
	'customers.phone_verified': 'row deleted',
	'customers.phone_verification_code': 'row deleted',
	'customers.phone_verification_expires_at': 'row deleted',
	'customers.refresh_token_hash': 'row deleted',
	'customers.stripe_customer_id': 'row deleted',
	'customer_subscriptions.confirmed_email_hash':
		'HMAC of the address, deleted with the subscription by customer id',
	'customer_refresh_tokens.token_hash': 'deleted by customer id',
	'customer_payment_methods.stripe_payment_method_id': 'deleted by customer id',
	'customer_payment_methods.last4': 'deleted by customer id',
	'shop_orders.stripe_checkout_session_id':
		'provider reference, no person data; order totals are kept, customer link nulled',
	'shop_orders.stripe_payment_intent_id':
		'provider reference, no person data; order totals are kept, customer link nulled',
	'restaurant_orders.contact_name':
		'scrubbed by customer id, normalised phone or case-insensitive email',
	'restaurant_orders.contact_phone':
		'scrubbed by customer id, normalised phone or case-insensitive email',
	'restaurant_orders.contact_email':
		'scrubbed by customer id, normalised phone or case-insensitive email',
	'restaurant_orders.delivery_address': 'scrubbed with the order contact',
	'restaurant_orders.delivery_postal_code': 'scrubbed with the order contact',
	'restaurant_orders.delivery_lat': 'scrubbed with the order contact',
	'restaurant_orders.delivery_lng': 'scrubbed with the order contact',
	'restaurant_orders.receipt_token_hash':
		'replaced by a random value, so the old receipt link stops working',
	'restaurant_orders.payment_token_hash': 'nulled with the order contact',
	'website_form_submissions.values':
		'redacted when a field holds the erased phone or email as a whole token (best effort, free text)',
	'voice_calls.caller_phone': 'call deleted by phone or customer id',
	'voice_calls.summary': 'call deleted',
	'voice_calls.transcript': 'call deleted',
	'voice_call_requests.caller_name': 'deleted by phone',
	'voice_call_requests.caller_phone': 'deleted by phone',
	'voice_call_requests.details': 'deleted by phone',
	'voice_sms_sends.to_phone': 'deleted by phone',
	'voice_link_handoffs.sent_to_phone': 'nulled by phone',
	'voice_link_handoffs.token_hash': 'handoff deleted with its call',
	'rsv_guests.first_name': 'anonymized',
	'rsv_guests.last_name': 'anonymized',
	'rsv_guests.phone_e164': 'nulled',
	'rsv_guests.email_norm': 'nulled',
	'rsv_guests.allergy_notes': 'nulled',
	'rsv_guest_notes.body': 'deleted',
	'rsv_holds.token_hash': 'hold deleted with the booking',
	'rsv_holds.ip_hash': 'hold deleted with the booking',
	'rsv_notify_requests.contact_phone_e164': 'nulled',
	'rsv_notify_requests.contact_email_norm': 'nulled',
	'rsv_notify_requests.ip_hash': 'nulled',
	'rsv_waitlist_entries.display_name': 'set to "Removed Guest"',
	'rsv_waitlist_entries.phone_e164': 'nulled',
	'rsv_waitlist_entries.email_norm': 'nulled',
	'rsv_waitlist_entries.notes': 'nulled',
	'rsv_waitlist_entries.ip_hash': 'nulled',
	'rsv_reservations.guest_requests': 'nulled',
	'rsv_reservations.dietary_notes': 'nulled',
	'rsv_reservations.staff_notes': 'nulled',
	'rsv_reservations.ip_hash': 'nulled',
	'rsv_payments.payment_method_ref': 'nulled',
	'rsv_payments.customer_ref': 'nulled',
	'rsv_payments.card_brand': 'nulled',
	'rsv_payments.card_last4': 'nulled',
	'rsv_payments.card_exp_month':
		'card metadata, with the nulled card brand and last4 it identifies no one',
	'rsv_payments.card_exp_year':
		'card metadata, with the nulled card brand and last4 it identifies no one',
	'customers.refresh_token_expires_at': 'row deleted',
	'restaurant_orders.delivery_notes': 'scrubbed with the order contact',
}

/** Whole domains that are not a customer's data, with the reason. */
const ALLOWED_TABLES: Array<[RegExp, string]> = [
	[
		/^(staff_|hiring_|kiosk_|schedule_|shift|time_|sales_|tip_|onboarding_|labor_|staffing_)/,
		'staff module: people who work here or apply to, with their own erasure and retention (docs/staffing.md, ADR 047), not customers',
	],
]

const staffAtTheTill =
	'staff member who worked the till, not a customer; replaced by erasePosStaffNames when that person is erased'

/** Single columns that look like PII but are not a customer's data. */
const ALLOWED_COLUMNS: Record<string, string> = {
	'marketing_campaigns.name': 'campaign title written by the operator',
	'marketing_journeys.name': 'journey title written by the operator',
	'website_forms.name': 'form title written by the operator',
	'restaurant_orders.payment_method':
		'cash or card, not personal data; the order totals are kept',
	'voice_line_verifications.to_phone':
		"the organization's own phone line being verified, not a customer",
	'rsv_areas.name': 'room name written by the operator',
	'rsv_policies.name': 'policy title written by the operator',
	'rsv_section_layouts.name': 'layout title written by the operator',
	'rsv_sections.name': 'section title written by the operator',
	'rsv_services.name': 'service title written by the operator',
	'rsv_special_days.name': 'special day title written by the operator',
	'rsv_tags.name': 'tag catalog entry, not tied to a person',
	'rsv_blocks.note': 'operator note about a table block, not about a guest',
	'rsv_service_notes.body': 'operator note about a service period, not a guest',
	'rsv_message_texts.custom_note':
		'text the organization wrote for its messages',
	'rsv_location_settings.contact_phone': "the restaurant's own phone number",
	'rsv_location_settings.max_active_per_phone': 'a numeric limit',
	'rsv_location_settings.block_same_phone_overlap': 'a boolean setting',
	'rsv_guests.marketing_email_consent_at':
		'deprecated timestamp column, never read or written (single consent source)',
	'rsv_guests.marketing_sms_consent_at':
		'deprecated timestamp column, never read or written (single consent source)',
	'rsv_guests.consent_text_version': 'deprecated, a text version label',
	'voice_calls.transfer_contact_id': 'opaque id of an organization contact',
	'pos_orders.guest_name':
		'phone-order names scrubbed by matching phone, otherwise unlinked counter guest names; all expire after 30 days and are omitted from revision history',
	'pos_orders.staff_name':
		'staff member who worked the till, not a customer; replaced by erasePosStaffNames when that person is erased (revision history keeps ids only)',
	'pos_orders.voided_by_staff_name':
		'staff member who worked the till, not a customer; replaced by erasePosStaffNames when that person is erased (revision history keeps ids only)',
	'pos_orders.void_approved_by_staff_name':
		'staff member who worked the till, not a customer; replaced by erasePosStaffNames when that person is erased (revision history keeps ids only)',
	'pos_payments.staff_name':
		'staff member who worked the till, not a customer; replaced by erasePosStaffNames when that person is erased (revision history keeps ids only)',
	'pos_payments.approved_by_staff_name':
		'staff member who worked the till, not a customer; replaced by erasePosStaffNames when that person is erased (revision history keeps ids only)',
	'pos_order_lines.name': 'menu item name, not personal data',
	'pos_shifts.opened_by_staff_name': staffAtTheTill,
	'pos_shifts.closed_by_staff_name': staffAtTheTill,
	'pos_cash_movements.staff_name': staffAtTheTill,
	'pos_cash_movements.approved_by_staff_name': staffAtTheTill,
	'pos_held_uploads.payload':
		'guest names, callback numbers, table notes and staff names are removed on arrival (ids kept); erasure and the regional tick re-redact any record kept before that, and settled records are deleted after 30 days',
	'pos_cash_movements.note':
		'what cash taken from or put in the drawer was for, written by staff; not about a customer',
	'pos_zatca_settings.postal_code':
		"the restaurant's own business address, as registered with ZATCA",
}

function listColumns() {
	const all: Array<{ table: string; column: string }> = []
	for (const value of Object.values(schema)) {
		let config: ReturnType<typeof getTableConfig> | undefined
		try {
			config = getTableConfig(value as never)
		} catch {
			continue
		}
		if (!config || typeof config.name !== 'string') continue
		for (const column of config.columns) {
			all.push({ table: config.name, column: column.name })
		}
	}
	return all
}

describe('person erasure covers every PII column of the tenant schema', () => {
	const columns = listColumns()
	const names = new Set(columns.map((c) => `${c.table}.${c.column}`))

	it('finds the tenant tables', () => {
		expect(names.has('customers.phone')).toBe(true)
		expect(names.has('rsv_guests.phone_e164')).toBe(true)
		expect(names.has('customer_subscriptions.customer_id')).toBe(true)
		expect(columns.length).toBeGreaterThan(500)
	})

	it('has no PII-looking column that is neither covered nor allow-listed', () => {
		const uncovered = columns
			.filter(({ column }) => PII_COLUMN.test(column))
			.map(({ table, column }) => ({ key: `${table}.${column}`, table }))
			.filter(
				({ key, table }) =>
					!(key in COVERED) &&
					!(key in ALLOWED_COLUMNS) &&
					!ALLOWED_TABLES.some(([pattern]) => pattern.test(table)),
			)
			.map(({ key }) => key)
		expect(
			uncovered,
			"Decide for each column: erase it in person-erasure-service.ts and add it to COVERED, or add it to ALLOWED_* with the reason it is not a customer's data",
		).toEqual([])
	})

	it('erases every table keyed by a customer id', () => {
		// A table with a customer_id column holds a person's rows. It must be one
		// the erasure deletes from or unlinks (listed here), so a new one fails.
		const handled = new Set([
			'customer_refresh_tokens',
			'customer_subscriptions',
			'customer_payment_methods',
			'journey_runs',
			'journey_step_executions',
			'marketing_messages',
			'restaurant_orders',
			'rsv_guests',
			'rsv_reservations',
			'shop_orders',
			'voice_calls',
		])
		const keyed = columns
			.filter(({ column }) => column === 'customer_id')
			.map(({ table }) => table)
			.filter((table) => !handled.has(table))
		expect(
			keyed,
			'A table keyed by customer_id needs a delete or unlink in person-erasure-service.ts, then an entry here',
		).toEqual([])
	})

	it('keeps COVERED and ALLOWED_COLUMNS free of stale entries', () => {
		const stale = [
			...Object.keys(COVERED),
			...Object.keys(ALLOWED_COLUMNS),
		].filter((key) => !names.has(key))
		expect(stale).toEqual([])
	})
})
