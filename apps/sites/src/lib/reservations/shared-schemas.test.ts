import {
	publicJoinWaitlistResponseSchema,
	publicJoinWaitlistSchema,
	publicNotifyMeRequestSchema,
	publicWaitlistStatusResponseSchema,
} from '@repo/reservations'
import { describe, expect, it } from 'vitest'
import { buildNotifyMeBody } from './notify-me-form.ts'
import { buildJoinBody, joinResponseToStatus } from './waitlist-box.ts'

describe('waitlist and notify-me requests match the shared schemas', () => {
	it('a join body parses with the tenant-api join schema', () => {
		const body = buildJoinBody({
			name: 'Sam Guest',
			phone: '+1 415 555 0123',
			email: 'sam@example.com',
			partySize: 3,
			areaId: 'area_1',
			smsOptIn: true,
			locationId: 'loc_1',
			locale: 'ar',
			honeypot: '',
			turnstileToken: 'tok',
		})
		expect(publicJoinWaitlistSchema.safeParse(body).success).toBe(true)
	})

	it('a notify-me body parses with the tenant-api notify-me schema', () => {
		const body = buildNotifyMeBody({
			partySize: 2,
			date: '2030-05-01',
			from: '19:00',
			to: '21:00',
			phone: '',
			email: 'sam@example.com',
			locationId: 'loc_1',
			locale: 'en',
			honeypot: '',
			turnstileToken: null,
		})
		expect(publicNotifyMeRequestSchema.safeParse(body).success).toBe(true)
	})

	it('a join answer maps onto the status view the status route also returns', () => {
		const join = {
			entry: {
				id: 'wle_1',
				locationId: 'loc_1',
				locationName: 'Acme',
				status: 'waiting' as const,
				position: 2,
				partySize: 4,
				quotedMin: 20,
				quotedReadyAt: '2030-05-01T19:20:00.000Z',
			},
			statusToken: 'rsv_w_token',
			now: '2030-05-01T19:00:00.000Z',
		}
		expect(publicJoinWaitlistResponseSchema.safeParse(join).success).toBe(true)
		const status = joinResponseToStatus(join)
		expect(publicWaitlistStatusResponseSchema.safeParse(status).success).toBe(
			true,
		)
	})
})
