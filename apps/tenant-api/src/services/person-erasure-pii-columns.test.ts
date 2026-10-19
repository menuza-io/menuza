import * as schema from '@repo/tenant-db'
import { getTableConfig } from 'drizzle-orm/sqlite-core'
import { describe, expect, it } from 'vitest'

/**
 * Schema-driven guard for the one erasure flow (`person-erasure-service.ts`).
 *
 * Every column of every table in the regional tenant schema whose name looks
 * like personal data must be either COVERED by the erasure (with a note on how)
 * or explicitly ALLOWED (with the reason it is not a customer's data). Adding a
 * table or a column that looks like PII fails this test until someone decides
 * which one it is. The behavioral twin is `person-erasure.test.ts`, which seeds
 * a person across the tables and scans a dump of the whole database.
 */

const PII_COLUMN =
	/((^|_)phone|(^|_)email|first_name|last_name|full_name|display_name|caller_name|contact_name|address|postal|_lat$|_lng$|^lat$|^lng$|ip_hash|stripe_|last4|payment_method_ref|customer_ref|card_|allerg|dietary|guest_requests|staff_notes|^transcript$|^summary$|^values$|^details$|^body$|^notes?$|token_hash|date_of_birth|^name$)/

/** Columns the erasure removes or scrubs, and how. */
const COVERED: Record<string, string> = {
	'customers.name': 'row deleted',
	'customers.email': 'row deleted',
	'customers.phone': 'row deleted',
	'customers.phone_verified': 'row deleted',
	'customers.phone_verification_code': 'row deleted',
	'customers.phone_verification_expires_at': 'row deleted',
	'customers.refresh_token_hash': 'row deleted',
	'customers.refresh_token_expires_at': 'row deleted',
	'customers.stripe_customer_id': 'row deleted',
	'customer_refresh_tokens.token_hash': 'deleted by customer id',
	'customer_payment_methods.stripe_payment_method_id': 'deleted by customer id',
	'customer_payment_methods.last4': 'deleted by customer id',
	'restaurant_orders.contact_name': 'scrubbed to "Erased customer"',
	'restaurant_orders.contact_phone': 'scrubbed to empty',
	'restaurant_orders.contact_email': 'nulled',
	'restaurant_orders.delivery_address': 'nulled',
	'restaurant_orders.delivery_notes': 'nulled',
	'restaurant_orders.delivery_postal_code': 'nulled',
	'restaurant_orders.delivery_lat': 'nulled',
	'restaurant_orders.delivery_lng': 'nulled',
	'restaurant_orders.receipt_token_hash': 'replaced with a random value',
	'restaurant_orders.payment_token_hash': 'nulled',
	'shop_orders.stripe_checkout_session_id':
		'provider reference, no person data; order totals are kept, customer link nulled',
	'shop_orders.stripe_payment_intent_id':
		'provider reference, no person data; order totals are kept, customer link nulled',
	'website_form_submissions.values':
		'redacted when it contains the erased phone or email (best effort, free text)',
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
	'voice_calls.caller_phone': 'call deleted by phone or customer id',
	'voice_calls.summary': 'call deleted',
	'voice_calls.transcript': 'call deleted',
	'voice_call_requests.caller_name': 'deleted by phone',
	'voice_call_requests.caller_phone': 'deleted by phone',
	'voice_call_requests.details': 'deleted by phone',
	'voice_sms_sends.to_phone': 'deleted by phone',
	'voice_link_handoffs.sent_to_phone': 'nulled by phone',
	'voice_link_handoffs.token_hash': 'handoff deleted with its call',
}

/** Whole domains that are not a customer's data, with the reason. */
const ALLOWED_TABLES: Array<[RegExp, string]> = [
	[
		/^(staff_|hiring_|kiosk_|schedule_|shift|time_|sales_|tip_|onboarding_|labor_|staffing_)/,
		'staff module: people who work here, own lifecycle (docs/staffing.md, ADR 047), not customers',
	],
]

/** Single columns that look like PII but are not a customer's data. */
const ALLOWED_COLUMNS: Record<string, string> = {
	'marketing_campaigns.name': 'campaign title written by the operator',
	'marketing_journeys.name': 'journey title written by the operator',
	'website_forms.name': 'form title written by the operator',
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
	'voice_line_verifications.to_phone':
		"the organization's own phone line being verified, not a customer",
	'voice_calls.transfer_contact_id': 'opaque id of an organization contact',
	'shop_orders.stripe_checkout_session_id':
		'provider reference (see COVERED note)',
	'shop_orders.stripe_payment_intent_id':
		'provider reference (see COVERED note)',
	'restaurant_orders.payment_method': 'enum: handoff or online',
	'customer_subscriptions.source': 'enum of consent sources',
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

	it('keeps COVERED and ALLOWED_COLUMNS free of stale entries', () => {
		const stale = [
			...Object.keys(COVERED),
			...Object.keys(ALLOWED_COLUMNS),
		].filter((key) => !names.has(key))
		expect(stale).toEqual([])
	})
})
