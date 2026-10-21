import { describe, expect, it } from 'vitest'

import {
	isPatched,
	MENU_DESCRIPTION_MARKER,
	patchAdminBundle,
	patchMenuItemDescriptions,
} from '../scripts/patch-emdash-admin.mjs'

const BLOCK_KIT = `function BlockKitField({ field, pluginId, value, onChange }) {
	switch (field.type) {
		case "media_picker": return /* @__PURE__ */ jsx(BlockKitMediaPickerField, {
			actionId: field.action_id,
			onChange
		});
		default: return null;
	}
}
function ensureKeys(items) {}
`

const TARGET_SELECT_OPTIONS = `children: [/* @__PURE__ */ jsx(Select.Option, { value: "" })]`

// Shape of @emdash-cms/admin 1.3.x: label, URL, target and cssClasses fields.
const MENU_13 = `
const handleAddCustomLink = (e) => {
		const formData = new FormData(e.currentTarget);
		const labelVal = formData.get("label");
		const targetVal = formData.get("target");
		const classesVal = formData.get("cssClasses");
		createMutation.mutate({
			type: "custom",
			target: (typeof targetVal === "string" ? targetVal : "") || void 0,
			cssClasses: (typeof classesVal === "string" ? classesVal.trim() : "") || void 0
		});
};
const handleUpdateItem = (e) => {
		const formData = new FormData(e.currentTarget);
		const uTargetVal = formData.get("target");
		const uParentIdVal = formData.get("parentId");
		const uClassesVal = formData.get("cssClasses");
		updateMutation.mutate({
			input: {
				target: (typeof uTargetVal === "string" ? uTargetVal : "") || void 0,
				cssClasses: cssClasses === "" ? void 0 : cssClasses,
				parentId: null
			}
		});
};
function create() { return [
										/* @__PURE__ */ jsx(Input, {
											label: _t({
												id: "MdsNde",
												message: "CSS classes"
											}),
											name: "cssClasses",
											dir: "ltr",
											description: _t({ id: "xAJS75", message: "x" })
										}),
]; }
function edit() { return [
							/* @__PURE__ */ jsx(Input, {
								label: _t({
									id: "MdsNde",
									message: "CSS classes"
								}),
								name: "cssClasses",
								dir: "ltr",
								defaultValue: editingItem.cssClasses ?? "",
								description: _t({ id: "xAJS75", message: "x" })
							}),
]; }
`

// Shape of @emdash-cms/admin 1.0.x: no cssClasses, Select for target last.
const MENU_10 = `
const handleAddCustomLink = (e) => {
		const targetVal = formData.get("target");
		createMutation.mutate({
			target: (typeof targetVal === "string" ? targetVal : "") || void 0
		});
};
const handleUpdateItem = (e) => {
		const uTargetVal = formData.get("target");
		const uParentIdVal = formData.get("parentId");
		updateMutation.mutate({
			input: {
				target: (typeof uTargetVal === "string" ? uTargetVal : "") || void 0,
				parentId: null
			}
		});
};
function create() { return [
										/* @__PURE__ */ jsxs(Select, {
											label: _t({
												id: "Yrrg+y",
												message: "Target"
											}),
											name: "target",
											defaultValue: "",
											${TARGET_SELECT_OPTIONS}
										}),
]; }
function edit() { return [
							/* @__PURE__ */ jsxs(Select, {
								label: _t({
									id: "Yrrg+y",
									message: "Target"
								}),
								name: "target",
								defaultValue: editingItem.target || "",
								${TARGET_SELECT_OPTIONS}
							}),
]; }
`

const bundle13 = BLOCK_KIT + MENU_13
const bundle10 = BLOCK_KIT + MENU_10

describe.each([
	['1.3.x', bundle13],
	['1.0.x', bundle10],
])('patchAdminBundle on a %s layout', (_name, bundle) => {
	it('adds the block kit cases and the menu Description field', () => {
		const patched = patchAdminBundle(bundle)
		expect(patched).toContain('case "link_settings"')
		expect(patched).toContain('case "markdown_input"')
		expect(patched).toContain(MENU_DESCRIPTION_MARKER)
		expect(isPatched(patched)).toBe(true)
		// create form, edit form
		expect(patched.match(/name: "titleAttr"/g)).toHaveLength(2)
		expect(patched).toContain('defaultValue: editingItem.titleAttr || ""')
		// create and update mutations send it
		expect(patched).toContain('const titleAttrVal = formData.get("titleAttr")')
		expect(patched).toContain('const uTitleAttrVal = formData.get("titleAttr")')
		expect(patched).toMatch(/titleAttr: \(typeof titleAttrVal/)
		expect(patched).toMatch(/titleAttr: typeof uTitleAttrVal/)
	})

	it('is idempotent', () => {
		const once = patchAdminBundle(bundle)
		expect(patchAdminBundle(once)).toBe(once)
		expect(patchMenuItemDescriptions(once)).toBe(once)
	})

	it('fails loudly when the menu item layout is unknown', () => {
		const unknownMenu = BLOCK_KIT + 'const somethingElse = 1;'
		expect(patchMenuItemDescriptions(unknownMenu)).toBeNull()
		expect(() => patchAdminBundle(unknownMenu)).toThrow(/menu item Description/)
	})
})

describe('patchAdminBundle failures', () => {
	it('throws when BlockKitField is missing', () => {
		expect(() => patchAdminBundle(MENU_13)).toThrow(/BlockKitField/)
	})

	it('throws when the media_picker anchor is missing', () => {
		const broken = bundle13.replace('case "media_picker"', 'case "other"')
		expect(() => patchAdminBundle(broken)).toThrow(/media_picker anchor/)
	})

	it('does not report an unpatched bundle as patched', () => {
		expect(isPatched(bundle13)).toBe(false)
	})
})
