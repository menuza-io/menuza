import { DISCOUNT_CHANNEL_VALUES } from '@repo/discounts'
import { describe, expect, it } from 'vitest'
import {
	isMenuChannel,
	isSoldOn,
	MENU_CHANNELS,
	parseMenuChannels,
	serializeMenuChannels,
	serializeOptionalMenuChannels,
} from './menu-channels.ts'

describe('menu-channels', () => {
	it('reuses the canonical channel list from @repo/discounts without duplicating it', () => {
		expect(MENU_CHANNELS).toBe(DISCOUNT_CHANNEL_VALUES)
		expect(MENU_CHANNELS).toEqual(['web', 'qr', 'pos', 'app'])
	})

	it('recognizes valid channels with isMenuChannel', () => {
		for (const ch of MENU_CHANNELS) {
			expect(isMenuChannel(ch)).toBe(true)
		}
		expect(isMenuChannel('kiosk')).toBe(false)
		expect(isMenuChannel(null)).toBe(false)
		expect(isMenuChannel(123)).toBe(false)
	})

	describe('parseMenuChannels', () => {
		it('returns all channels for null, undefined, empty string, or invalid JSON', () => {
			expect(parseMenuChannels(null)).toEqual(['web', 'qr', 'pos', 'app'])
			expect(parseMenuChannels(undefined)).toEqual(['web', 'qr', 'pos', 'app'])
			expect(parseMenuChannels('')).toEqual(['web', 'qr', 'pos', 'app'])
			expect(parseMenuChannels('{bad json')).toEqual([
				'web',
				'qr',
				'pos',
				'app',
			])
			expect(parseMenuChannels('{"web":true}')).toEqual([
				'web',
				'qr',
				'pos',
				'app',
			])
			expect(parseMenuChannels(42)).toEqual(['web', 'qr', 'pos', 'app'])
		})

		it('parses JSON-text arrays and in-memory arrays in canonical order, dropping unknown values', () => {
			expect(parseMenuChannels('["pos","web","pos","future"]')).toEqual([
				'web',
				'pos',
			])
			expect(parseMenuChannels(['app', 'qr'])).toEqual(['qr', 'app'])
			expect(parseMenuChannels('[]')).toEqual([])
			expect(parseMenuChannels([])).toEqual([])
		})
	})

	describe('serializeMenuChannels & serializeOptionalMenuChannels', () => {
		it('serializes channels in canonical order and defaults null/undefined to all', () => {
			expect(serializeMenuChannels(['pos', 'web', 'pos'])).toBe('["web","pos"]')
			expect(serializeMenuChannels([])).toBe('[]')
			expect(serializeMenuChannels(null)).toBe('["web","qr","pos","app"]')
			expect(serializeMenuChannels(undefined)).toBe('["web","qr","pos","app"]')
		})

		it('preserves null/undefined for optional override channels', () => {
			expect(serializeOptionalMenuChannels(null)).toBeNull()
			expect(serializeOptionalMenuChannels(undefined)).toBeNull()
			expect(serializeOptionalMenuChannels(['qr', 'web'])).toBe('["web","qr"]')
		})
	})

	describe('isSoldOn', () => {
		it('treats missing or null/invalid channels as all channels', () => {
			expect(isSoldOn('web', {})).toBe(true)
			expect(
				isSoldOn('app', {
					menu: null,
					category: { channels: null },
					item: { channels: undefined },
					override: { channels: 'not-json' },
				}),
			).toBe(true)
		})

		it('requires menu, category, item, and override to all allow the channel', () => {
			expect(
				isSoldOn('qr', {
					menu: { channels: ['web', 'qr', 'pos'] },
					category: { channels: '["web","qr"]' },
					item: { channels: ['qr', 'app'] },
					override: null,
				}),
			).toBe(true)

			// Disallowed at menu level
			expect(
				isSoldOn('app', {
					menu: { channels: ['web', 'qr', 'pos'] },
					category: { channels: ['app'] },
					item: { channels: ['app'] },
				}),
			).toBe(false)

			// Disallowed at category level
			expect(
				isSoldOn('pos', {
					menu: { channels: ['web', 'pos'] },
					category: { channels: ['web'] },
					item: { channels: ['web', 'pos'] },
				}),
			).toBe(false)

			// Disallowed at item level
			expect(
				isSoldOn('web', {
					menu: { channels: ['web', 'pos'] },
					category: { channels: ['web', 'pos'] },
					item: { channels: '["pos"]' },
				}),
			).toBe(false)
		})

		it('allows override to narrow only, never widen', () => {
			// Narrowing: item allows web+pos, override allows only pos -> web is false, pos is true
			expect(
				isSoldOn('web', {
					item: { channels: ['web', 'pos'] },
					override: { channels: ['pos'] },
				}),
			).toBe(false)
			expect(
				isSoldOn('pos', {
					item: { channels: ['web', 'pos'] },
					override: { channels: ['pos'] },
				}),
			).toBe(true)

			// Attempting to widen: item allows only web, override includes pos -> pos is still false
			expect(
				isSoldOn('pos', {
					item: { channels: ['web'] },
					override: { channels: ['web', 'pos'] },
				}),
			).toBe(false)
		})
	})
})
