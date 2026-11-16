import { describe, expect, it } from 'vitest'
import {
	checkBroadcast,
	clampLateAfterMinutes,
	hasBlockingProblems,
	isTooLate,
	type BroadcastCheckInput,
} from './broadcast-checks.ts'
import {
	hasBoilerplatePhrase,
	starterTextBlockIds,
} from './email-boilerplate.ts'
import { getDefaultEmailBlock, type EmailBlock } from './email-blocks.ts'

const base: BroadcastCheckInput = {
	channel: 'email',
	subject: 'Lunch special',
	content: 'Come eat',
	blocks: [],
	hasOffer: false,
	usesCouponTag: false,
	audienceCount: 120,
}

const heading = (text: string, id = 'block-h'): EmailBlock => ({
	id,
	type: 'heading',
	config: { text, level: 'h2', align: 'left' },
})

describe('checkBroadcast', () => {
	it('passes a finished message', () => {
		expect(
			checkBroadcast({ ...base, blocks: [heading('Taco Tuesday')] }),
		).toEqual([])
	})

	it('warns, naming the block, about unedited starter text', () => {
		const starter = getDefaultEmailBlock('body')
		const problems = checkBroadcast({
			...base,
			blocks: [heading('Hi'), starter],
		})
		expect(problems).toEqual([
			{ code: 'starter_text', severity: 'warning', blockId: starter.id },
		])
		expect(hasBlockingProblems(problems)).toBe(false)
	})

	it('treats the starter heading, paragraph and button label as starter text', () => {
		const blocks = [
			getDefaultEmailBlock('heading'),
			getDefaultEmailBlock('paragraph'),
			{
				...getDefaultEmailBlock('button'),
				config: {
					label: 'Learn more',
					url: 'https://acme.test',
					variant: 'primary',
					width: 'auto',
					align: 'left',
				},
			} as EmailBlock,
		]
		expect(starterTextBlockIds(blocks)).toEqual(blocks.map((b) => b.id))
	})

	it('blocks an empty image and a button that goes nowhere', () => {
		const image = getDefaultEmailBlock('image')
		const button = getDefaultEmailBlock('button') // url is the bare scheme
		const problems = checkBroadcast({ ...base, blocks: [image, button] })
		expect(problems.filter((p) => p.severity === 'blocking')).toEqual([
			{ code: 'empty_image', severity: 'blocking', blockId: image.id },
			{ code: 'empty_button_link', severity: 'blocking', blockId: button.id },
		])
		expect(hasBlockingProblems(problems)).toBe(true)
	})

	it('does not check the link of a button that has no label (it is not drawn)', () => {
		const button = {
			...getDefaultEmailBlock('button'),
			config: {
				label: '',
				url: '',
				variant: 'primary',
				width: 'auto',
				align: 'left',
			},
		} as EmailBlock
		expect(checkBroadcast({ ...base, blocks: [button] })).toEqual([])
	})

	it('blocks an empty dish block and a coupon block with no coupon', () => {
		const dish = getDefaultEmailBlock('menu_item')
		const coupon = getDefaultEmailBlock('coupon')
		const problems = checkBroadcast({ ...base, blocks: [dish, coupon] })
		expect(problems.map((p) => [p.code, p.blockId])).toEqual([
			['empty_menu_item', dish.id],
			['empty_coupon', coupon.id],
		])
		// With a coupon attached the coupon block is fine.
		expect(
			checkBroadcast({
				...base,
				hasOffer: true,
				usesCouponTag: true,
				blocks: [coupon],
			}),
		).toEqual([])
	})

	it('blocks a coupon tag with no coupon, and a paused or ended coupon', () => {
		expect(
			checkBroadcast({ ...base, usesCouponTag: true }).map((p) => p.code),
		).toEqual(['coupon_missing'])
		const withOffer = { ...base, hasOffer: true, usesCouponTag: true }
		expect(
			checkBroadcast({ ...withOffer, couponState: 'paused' }).map(
				(p) => p.code,
			),
		).toEqual(['coupon_paused'])
		expect(
			checkBroadcast({ ...withOffer, couponState: 'ended_before_send' }).map(
				(p) => p.code,
			),
		).toEqual(['coupon_ended_before_send'])
		expect(checkBroadcast({ ...withOffer, couponState: 'ok' })).toEqual([])
	})

	it('blocks an audience of zero but not an unknown one', () => {
		expect(
			checkBroadcast({ ...base, audienceCount: 0 }).map((p) => p.code),
		).toEqual(['audience_zero'])
		expect(checkBroadcast({ ...base, audienceCount: null })).toEqual([])
	})

	it('blocks a message with nothing in it', () => {
		expect(
			checkBroadcast({ ...base, content: '  ', blocks: [] }).map((p) => p.code),
		).toEqual(['empty_message'])
		// SMS text is judged as text, whatever blocks it was given.
		expect(
			checkBroadcast({
				...base,
				channel: 'sms',
				content: 'hi',
				blocks: [getDefaultEmailBlock('image')],
			}),
		).toEqual([])
	})

	it('lists blocking problems before warnings', () => {
		const problems = checkBroadcast({
			...base,
			audienceCount: 0,
			blocks: [getDefaultEmailBlock('body')],
		})
		expect(problems.map((p) => p.severity)).toEqual(['blocking', 'warning'])
	})

	it('shares the placeholder-phrase check with automations', () => {
		expect(hasBoilerplatePhrase('Lorem Ipsum dolor')).toBe(true)
		expect(hasBoilerplatePhrase('<p>Insert text here</p>')).toBe(true)
		expect(hasBoilerplatePhrase('Real copy', null, undefined)).toBe(false)
		expect(
			checkBroadcast({ ...base, content: 'lorem ipsum' }).map((p) => p.code),
		).toEqual(['boilerplate_phrase'])
	})
})

describe('late cut-off', () => {
	it('clamps the window to 1 to 72 hours and defaults to 4', () => {
		expect(clampLateAfterMinutes(undefined)).toBe(240)
		expect(clampLateAfterMinutes('abc')).toBe(240)
		expect(clampLateAfterMinutes(5)).toBe(60)
		expect(clampLateAfterMinutes(10_000)).toBe(4320)
		expect(clampLateAfterMinutes(180)).toBe(180)
	})

	it('is too late only after the window has passed', () => {
		const scheduledAtMs = Date.parse('2026-11-15T12:00:00Z')
		const lateAfterMinutes = 240
		expect(
			isTooLate({
				scheduledAtMs,
				lateAfterMinutes,
				nowMs: scheduledAtMs + 240 * 60_000,
			}),
		).toBe(false)
		expect(
			isTooLate({
				scheduledAtMs,
				lateAfterMinutes,
				nowMs: scheduledAtMs + 240 * 60_000 + 1,
			}),
		).toBe(true)
	})
})
