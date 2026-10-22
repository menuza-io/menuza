import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadSettings, saveSettings } from './config.ts'

const readAppFile = (path: string) =>
	readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')

afterEach(() => vi.unstubAllGlobals())

describe('Station app identity', () => {
	it('uses the Station workspace and document title', () => {
		expect(JSON.parse(readAppFile('package.json')).name).toBe('station')
		expect(readAppFile('index.html')).toContain('<title>Station</title>')
	})

	it('keeps the installed app location while using Station for its manifest name', () => {
		const config = readAppFile('vite.config.ts')
		expect(config).toContain("name: 'Station'")
		expect(config).toContain("short_name: 'Station'")
		expect(config).toContain("start_url: '/'")
	})

	it('continues reading and writing existing paired-device settings', () => {
		const saved = {
			slug: 'restaurant',
			terminalCode: 'T2',
			locationId: 'main',
			demo: false,
		}
		const setItem = vi.fn()
		vi.stubGlobal('localStorage', {
			getItem: (key: string) =>
				key === 'pos.settings.v1' ? JSON.stringify(saved) : null,
			setItem,
		})
		const settings = loadSettings()
		expect(settings).toMatchObject(saved)
		saveSettings(settings)
		expect(setItem).toHaveBeenCalledWith(
			'pos.settings.v1',
			JSON.stringify(settings),
		)
	})
})
