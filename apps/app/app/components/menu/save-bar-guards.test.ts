import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Editor forms must warn before unsaved edits are lost (issue #253). Each file
 * listed here has to call one of the save-bar hooks, and every `*-form.tsx`
 * under `components/menu` has to be listed (or listed as exempt with a
 * reason), so a new menu editor cannot be added without the bar and the leave
 * prompt.
 */

const APP_DIR = path.resolve(import.meta.dirname, '../..')
const MENU_DIR = path.join(APP_DIR, 'components/menu')

const SAVE_BAR_HOOKS = [
	'useFormSnapshotSaveBar',
	'useNativeFormSaveBar',
	'useConformSaveBar',
	'useSaveBar',
]

/** Editor files that must call a save-bar hook, relative to `app/`. */
const GUARDED_EDITORS = [
	'components/menu/item-form.tsx',
	'components/menu/option-form.tsx',
	'components/menu/modifier-form.tsx',
	'components/menu/category-form.tsx',
	'components/menu/menu-form.tsx',
	'components/menu/drop-wizard/drop-form.tsx',
	'components/locations/location-form.tsx',
	'routes/_app+/$orgSlug_+/website+/pages.$pageId.tsx',
]

/**
 * `*-form.tsx` files under `components/menu` that are not editors with
 * unsaved state of their own. Give the reason.
 */
const EXEMPT_MENU_FORMS: Record<string, string> = {}

function callsSaveBarHook(source: string) {
	// A call, not an import or a mention in a comment.
	const code = source
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/^\s*\/\/.*$/gm, '')
	return SAVE_BAR_HOOKS.some((hook) =>
		new RegExp(`\\b${hook}\\s*\\(`).test(code),
	)
}

function menuFormFiles(dir: string): string[] {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = path.join(dir, entry.name)
		if (entry.isDirectory()) return menuFormFiles(full)
		if (!entry.name.endsWith('-form.tsx')) return []
		return [path.relative(APP_DIR, full).split(path.sep).join('/')]
	})
}

describe('editor forms warn about unsaved changes', () => {
	it.each(GUARDED_EDITORS)('%s calls a save-bar hook', (file) => {
		const full = path.join(APP_DIR, file)
		expect(fs.existsSync(full), `${file} is listed but missing`).toBe(true)
		expect(
			callsSaveBarHook(fs.readFileSync(full, 'utf8')),
			`${file} must call one of ${SAVE_BAR_HOOKS.join(', ')}`,
		).toBe(true)
	})

	it('lists every form under components/menu', () => {
		const unlisted = menuFormFiles(MENU_DIR).filter(
			(file) => !GUARDED_EDITORS.includes(file) && !(file in EXEMPT_MENU_FORMS),
		)
		expect(
			unlisted,
			'add new menu forms to GUARDED_EDITORS (and call a save-bar hook), or to EXEMPT_MENU_FORMS with a reason',
		).toEqual([])
	})

	it('keeps the exemptions honest', () => {
		for (const file of Object.keys(EXEMPT_MENU_FORMS)) {
			const full = path.join(APP_DIR, file)
			expect(fs.existsSync(full), `${file} is exempt but missing`).toBe(true)
			expect(
				callsSaveBarHook(fs.readFileSync(full, 'utf8')),
				`${file} calls a save-bar hook: move it to GUARDED_EDITORS`,
			).toBe(false)
		}
	})
})
