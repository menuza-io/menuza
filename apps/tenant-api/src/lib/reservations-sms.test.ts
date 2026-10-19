import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	TOGGLEABLE_MESSAGE_KINDS,
	type ToggleableMessageKind,
} from './reservations-messaging-settings.ts'

const sendSmsMock = vi.hoisted(() => vi.fn())

vi.mock('@repo/sms', () => ({ sendSms: sendSmsMock }))

import { renderReservationSms, sendReservationSms } from './reservations-sms.ts'

const WHEN = Date.UTC(2031, 5, 14, 19, 30)
const URL_MANAGE = 'https://acme.menuza.test/reserve/manage#t=tok.123'

function sms(
	kind: ToggleableMessageKind,
	patch: Partial<Parameters<typeof renderReservationSms>[0]> = {},
) {
	return renderReservationSms({
		kind,
		locale: 'en',
		restaurantName: 'Acme Downtown',
		whenMs: WHEN,
		timeZone: 'America/New_York',
		partySize: 4,
		url: URL_MANAGE,
		quotedWaitMin: 25,
		...patch,
	})
}

beforeEach(() => {
	sendSmsMock.mockReset()
	sendSmsMock.mockResolvedValue({ success: true, mock: true })
	vi.stubEnv('DATA_REGION', 'us')
})

afterEach(() => {
	vi.unstubAllEnvs()
})

describe('renderReservationSms', () => {
	it.each(TOGGLEABLE_MESSAGE_KINDS)(
		'%s is short, names the restaurant and has no unfilled placeholder in both languages',
		(kind) => {
			for (const locale of ['en', 'ar']) {
				const text = sms(kind, { locale })
				expect(text, `${kind}/${locale}`).toContain('Acme Downtown')
				expect(text).not.toMatch(/\{[a-z]+\}/)
				expect(text).not.toContain('undefined')
				expect(text.length).toBeLessThan(320)
			}
		},
	)

	it('renders each site language in its own words, English for an unknown one', () => {
		expect(sms('confirmation', { locale: 'ar' })).toMatch(/[\u0600-\u06FF]/)
		expect(sms('confirmation', { locale: 'ar-SA' })).toMatch(/[\u0600-\u06FF]/)
		expect(sms('confirmation', { locale: 'fr' })).toContain(
			'réservation confirmée',
		)
		expect(sms('confirmation', { locale: 'es' })).toContain(
			'reserva confirmada',
		)
		expect(sms('confirmation', { locale: 'de' })).toContain(
			'Reservierung bestätigt',
		)
		expect(sms('confirmation', { locale: 'zh' })).toContain('预订已确认')
		expect(sms('confirmation', { locale: 'xx' })).toBe(sms('confirmation'))
		expect(sms('confirmation', { locale: 'fr' })).not.toMatch(/[\u0600-\u06FF]/)
	})

	it('states the time in the location zone and the party size', () => {
		const text = sms('confirmation')
		expect(text).toContain('Saturday, June 14, 2031')
		expect(text).toMatch(/3:30\s?PM/)
		expect(text).toContain('party of 4')
		const utc = sms('confirmation', { timeZone: null })
		expect(utc).toMatch(/7:30\s?PM/)
	})

	it('appends the manage link, token in the fragment, when one is given', () => {
		const text = sms('reminder')
		expect(text.endsWith(` ${URL_MANAGE}`)).toBe(true)
		expect(new URL(URL_MANAGE).hash).toBe('#t=tok.123')
		expect(sms('reminder', { url: null })).not.toContain('https://')
		expect(sms('reminder', { url: undefined })).not.toContain('https://')
	})

	it('adds the quoted wait to the waitlist join message', () => {
		expect(sms('waitlist_joined')).toContain('Estimated wait 25 min.')
		expect(sms('waitlist_joined', { locale: 'ar' })).toContain('25 دقيقة')
		expect(sms('waitlist_joined', { quotedWaitMin: null })).not.toContain(
			'Estimated wait',
		)
	})

	it('renders a message without a time or party size without dangling text', () => {
		const text = sms('notify_available', {
			whenMs: null,
			partySize: null,
			url: null,
		})
		expect(text).toBe('Acme Downtown: a table opened up. Book now.')
		expect(
			sms('notify_available', { whenMs: null, url: null, locale: 'ar' }),
		).toBe('Acme Downtown: توفرت طاولة. احجز الآن.')
		expect(sms('notify_available')).toContain('opened up for Saturday')
		const confirm = sms('confirmation', { whenMs: null, partySize: null })
		expect(confirm).not.toContain('undefined')
	})

	it('carries sensitive words nowhere: no email, phone or guest name is an input', () => {
		const text = sms('confirmation')
		expect(text).not.toMatch(/@/)
		expect(text).not.toMatch(/\+\d{6,}/)
	})
})

describe('sendReservationSms', () => {
	it('sends through the SMS provider on the US node', async () => {
		await sendReservationSms({ to: '+14155550101', message: 'hello' })
		expect(sendSmsMock).toHaveBeenCalledTimes(1)
		expect(sendSmsMock).toHaveBeenCalledWith({
			to: '+14155550101',
			message: 'hello',
		})
	})

	it('refuses on the KSA node and never reaches the provider', async () => {
		vi.stubEnv('DATA_REGION', 'ksa')
		await expect(
			sendReservationSms({ to: '+966555000111', message: 'hello' }),
		).rejects.toThrow('sms_not_allowed')
		expect(sendSmsMock).not.toHaveBeenCalled()
	})

	it('propagates a provider failure so the message can retry', async () => {
		sendSmsMock.mockRejectedValueOnce(new Error('twilio_down'))
		await expect(
			sendReservationSms({ to: '+14155550101', message: 'hello' }),
		).rejects.toThrow('twilio_down')
	})
})
