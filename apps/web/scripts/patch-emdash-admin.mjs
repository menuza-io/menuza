/**
 * Patches @emdash-cms/admin so BlockKitField supports plugin field widgets.
 * Run before dev/build so Vite can pre-bundle the patched admin (stable Lingui deps).
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const BLOCK_KIT_FIELD_START =
	'function BlockKitField({ field, pluginId, value, onChange })'
const BLOCK_KIT_FIELD_END = 'function ensureKeys(items)'

const BLOCK_KIT_FIELD_MEDIA_TAIL =
	/(\s*case "media_picker": return[\s\S]*?BlockKitMediaPickerField, \{[\s\S]*?actionId: field\.action_id,[\s\S]*?onChange\s*\}\);)(\s*default: return)/

const LINK_SETTINGS_CASE = `case "link_settings": {
			const LinkSettingsWidget = usePluginField(pluginId, "link_settings");
			if (typeof LinkSettingsWidget === "function") return /* @__PURE__ */ jsx(LinkSettingsWidget, {
				value,
				onChange: (v) => onChange(field.action_id, v),
				label: field.label,
				pluginId
			});
			return /* @__PURE__ */ jsx("div", {
				className: "text-sm text-kumo-subtle",
				children: "Link settings widget not registered"
			});
		}
		`

const MARKDOWN_INPUT_CASE = `case "markdown_input": {
			const MarkdownWidget = usePluginField(pluginId, "markdown_input");
			if (typeof MarkdownWidget === "function") return /* @__PURE__ */ jsx(MarkdownWidget, {
				value,
				onChange: (v) => onChange(field.action_id, v),
				label: field.label,
				multiline: field.multiline,
				pluginId
			});
			return /* @__PURE__ */ jsx("div", {
				className: "text-sm text-kumo-subtle",
				children: "Markdown widget not registered"
			});
		}
		`

const MENU_DESCRIPTION_MARKER =
	'message: "Short summary shown below the menu label"'

function patchMenuItemDescriptions(code) {
	if (code.includes(MENU_DESCRIPTION_MARKER)) return code

	const replacements = [
		[
			`const targetVal = formData.get("target");
		createMutation.mutate({`,
			`const targetVal = formData.get("target");
		const titleAttrVal = formData.get("titleAttr");
		createMutation.mutate({`,
		],
		[
			`target: (typeof targetVal === "string" ? targetVal : "") || void 0
		});`,
			`target: (typeof targetVal === "string" ? targetVal : "") || void 0,
			titleAttr: (typeof titleAttrVal === "string" ? titleAttrVal.trim() : "") || void 0
		});`,
		],
		[
			`const uTargetVal = formData.get("target");
		const uParentIdVal = formData.get("parentId");`,
			`const uTargetVal = formData.get("target");
		const uTitleAttrVal = formData.get("titleAttr");
		const uParentIdVal = formData.get("parentId");`,
		],
		[
			`target: (typeof uTargetVal === "string" ? uTargetVal : "") || void 0,
				parentId:`,
			`target: (typeof uTargetVal === "string" ? uTargetVal : "") || void 0,
				titleAttr: typeof uTitleAttrVal === "string" ? uTitleAttrVal.trim() : "",
				parentId:`,
		],
		[
			`placeholder: _t({
											id: "Xkfr5x",
											message: "https://example.com or /about"
										})
									}),
									/* @__PURE__ */ jsxs(Select, {`,
			`placeholder: _t({
											id: "Xkfr5x",
											message: "https://example.com or /about"
										})
									}),
									/* @__PURE__ */ jsx(Input, {
										label: _t({ id: "menuItemDescription", message: "Description" }),
										name: "titleAttr",
										maxLength: 160,
										placeholder: _t({
											id: "menuItemDescriptionHint",
											message: "Short summary shown below the menu label"
										})
									}),
									/* @__PURE__ */ jsxs(Select, {`,
		],
		[
			`defaultValue: editingItem.customUrl || ""
							}),
							/* @__PURE__ */ jsxs(Select, {`,
			`defaultValue: editingItem.customUrl || ""
							}),
							/* @__PURE__ */ jsx(Input, {
								label: _t({ id: "menuItemDescription", message: "Description" }),
								name: "titleAttr",
								maxLength: 160,
								placeholder: _t({
									id: "menuItemDescriptionHint",
									message: "Short summary shown below the menu label"
								}),
								defaultValue: editingItem.titleAttr || ""
							}),
							/* @__PURE__ */ jsxs(Select, {`,
		],
	]

	let patched = code
	for (const [search, replacement] of replacements) {
		if (!patched.includes(search)) return null
		patched = patched.replace(search, replacement)
	}

	return patched
}

function patchAdminBundle(code) {
	let patched = code

	if (!patched.includes('case "link_settings"')) {
		const start = patched.indexOf(BLOCK_KIT_FIELD_START)
		if (start === -1) return null

		const end = patched.indexOf(BLOCK_KIT_FIELD_END, start)
		if (end === -1) return null

		const before = patched.slice(0, start)
		const fnBody = patched.slice(start, end)
		const after = patched.slice(end)

		if (!BLOCK_KIT_FIELD_MEDIA_TAIL.test(fnBody)) return null

		const nextFnBody = fnBody.replace(
			BLOCK_KIT_FIELD_MEDIA_TAIL,
			`$1
		${LINK_SETTINGS_CASE}$2`,
		)

		patched = before + nextFnBody + after
	}

	if (!patched.includes('case "markdown_input"')) {
		const markdownAnchor = patched.includes('case "link_settings"')
			? /case "link_settings": \{[\s\S]*?\}\n\t\tdefault: return/
			: BLOCK_KIT_FIELD_MEDIA_TAIL

		if (markdownAnchor === BLOCK_KIT_FIELD_MEDIA_TAIL) {
			return null
		}

		patched = patched.replace(markdownAnchor, (match) =>
			match.replace('default: return', `${MARKDOWN_INPUT_CASE}default: return`),
		)
	}

	return patchMenuItemDescriptions(patched)
}

const require = createRequire(import.meta.url)
const adminPath = require.resolve('@emdash-cms/admin')
const source = readFileSync(adminPath, 'utf8')

if (
	source.includes('case "link_settings"') &&
	source.includes('case "markdown_input"') &&
	source.includes(MENU_DESCRIPTION_MARKER)
) {
	console.log(
		'[patch-emdash-admin] @emdash-cms/admin already supports custom fields and menu descriptions',
	)
	process.exit(0)
}

const patched = patchAdminBundle(source)
if (!patched || patched === source) {
	console.error(
		'[patch-emdash-admin] Could not patch BlockKitField in @emdash-cms/admin',
	)
	process.exit(1)
}

writeFileSync(adminPath, patched)
console.log(
	'[patch-emdash-admin] Patched @emdash-cms/admin for custom fields and menu descriptions',
)
