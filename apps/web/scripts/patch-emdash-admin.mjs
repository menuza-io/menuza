/**
 * Patches @emdash-cms/admin so BlockKitField supports plugin field widgets.
 * Run before dev/build so Vite can pre-bundle the patched admin (stable Lingui deps).
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

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

export const MENU_DESCRIPTION_MARKER =
	'message: "Short summary shown below the menu label"'

const createDescriptionInput = (
	indent,
) => `${indent}/* @__PURE__ */ jsx(Input, {
${indent}	label: _t({ id: "menuItemDescription", message: "Description" }),
${indent}	name: "titleAttr",
${indent}	maxLength: 160,
${indent}	placeholder: _t({
${indent}		id: "menuItemDescriptionHint",
${indent}		message: "Short summary shown below the menu label"
${indent}	})
${indent}}),
`

const editDescriptionInput = (indent) => `${indent}/* @__PURE__ */ jsx(Input, {
${indent}	label: _t({ id: "menuItemDescription", message: "Description" }),
${indent}	name: "titleAttr",
${indent}	maxLength: 160,
${indent}	placeholder: _t({
${indent}		id: "menuItemDescriptionHint",
${indent}		message: "Short summary shown below the menu label"
${indent}	}),
${indent}	defaultValue: editingItem.titleAttr || ""
${indent}}),
`

/**
 * Menu item layouts. Each step is [search, replacement]; a function
 * replacement receives the regex match. EmDash admin 1.3.x has `cssClasses`
 * fields on the menu item forms; 1.0.x does not.
 */
const MENU_LAYOUTS = [
	{
		name: '1.3.x (cssClasses forms)',
		steps: [
			[
				`const classesVal = formData.get("cssClasses");`,
				`const classesVal = formData.get("cssClasses");
		const titleAttrVal = formData.get("titleAttr");`,
			],
			[
				`target: (typeof targetVal === "string" ? targetVal : "") || void 0,
			cssClasses:`,
				`target: (typeof targetVal === "string" ? targetVal : "") || void 0,
			titleAttr: (typeof titleAttrVal === "string" ? titleAttrVal.trim() : "") || void 0,
			cssClasses:`,
			],
			[
				`const uClassesVal = formData.get("cssClasses");`,
				`const uClassesVal = formData.get("cssClasses");
		const uTitleAttrVal = formData.get("titleAttr");`,
			],
			[
				`target: (typeof uTargetVal === "string" ? uTargetVal : "") || void 0,
				cssClasses:`,
				`target: (typeof uTargetVal === "string" ? uTargetVal : "") || void 0,
				titleAttr: typeof uTitleAttrVal === "string" ? uTitleAttrVal.trim() : "",
				cssClasses:`,
			],
			[
				/([ \t]*)\/\* @__PURE__ \*\/ jsx\(Input, \{\s*label: _t\(\{\s*id: "MdsNde",\s*message: "CSS classes"\s*\}\),\s*name: "cssClasses",\s*dir: "ltr",\s*description:/,
				(match, indent) => createDescriptionInput(indent) + match,
			],
			[
				/([ \t]*)\/\* @__PURE__ \*\/ jsx\(Input, \{\s*label: _t\(\{\s*id: "MdsNde",\s*message: "CSS classes"\s*\}\),\s*name: "cssClasses",\s*dir: "ltr",\s*defaultValue: editingItem\.cssClasses/,
				(match, indent) => editDescriptionInput(indent) + match,
			],
		],
	},
	{
		name: '1.0.x (label, URL, target forms)',
		steps: [
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
				/([ \t]*)\/\* @__PURE__ \*\/ jsxs\(Select, \{\s*label: _t\(\{\s*id: "Yrrg\+y",\s*message: "Target"\s*\}\),\s*name: "target",\s*defaultValue: ""/,
				(match, indent) => createDescriptionInput(indent) + match,
			],
			[
				/([ \t]*)\/\* @__PURE__ \*\/ jsxs\(Select, \{\s*label: _t\(\{\s*id: "Yrrg\+y",\s*message: "Target"\s*\}\),\s*name: "target",\s*defaultValue: editingItem\.target/,
				(match, indent) => editDescriptionInput(indent) + match,
			],
		],
	},
]

function applyMenuLayout(code, steps) {
	let patched = code
	for (const [search, replacement] of steps) {
		if (typeof search === 'string') {
			if (!patched.includes(search)) return null
			patched = patched.replace(search, () => replacement)
		} else {
			if (!search.test(patched)) return null
			patched = patched.replace(search, replacement)
		}
	}
	return patched
}

/** Returns the patched code, or null when no known menu item layout matches. */
export function patchMenuItemDescriptions(code) {
	if (code.includes(MENU_DESCRIPTION_MARKER)) return code
	for (const layout of MENU_LAYOUTS) {
		const patched = applyMenuLayout(code, layout.steps)
		if (patched) return patched
	}
	return null
}

/**
 * Returns the patched bundle. Throws an Error naming the part that could not
 * be patched, so a changed EmDash admin bundle never fails silently.
 */
export function patchAdminBundle(code) {
	let patched = code

	if (!patched.includes('case "link_settings"')) {
		const start = patched.indexOf(BLOCK_KIT_FIELD_START)
		if (start === -1)
			throw new Error('Could not patch BlockKitField: function not found')

		const end = patched.indexOf(BLOCK_KIT_FIELD_END, start)
		if (end === -1)
			throw new Error('Could not patch BlockKitField: end anchor not found')

		const before = patched.slice(0, start)
		const fnBody = patched.slice(start, end)
		const after = patched.slice(end)

		if (!BLOCK_KIT_FIELD_MEDIA_TAIL.test(fnBody)) {
			throw new Error(
				'Could not patch BlockKitField: media_picker anchor not found',
			)
		}

		const nextFnBody = fnBody.replace(
			BLOCK_KIT_FIELD_MEDIA_TAIL,
			`$1
		${LINK_SETTINGS_CASE}$2`,
		)

		patched = before + nextFnBody + after
	}

	if (!patched.includes('case "markdown_input"')) {
		const markdownAnchor =
			/case "link_settings": \{[\s\S]*?\}\s*default: return/
		if (!markdownAnchor.test(patched)) {
			throw new Error(
				'Could not patch BlockKitField: link_settings anchor not found',
			)
		}

		patched = patched.replace(markdownAnchor, (match) =>
			match.replace('default: return', `${MARKDOWN_INPUT_CASE}default: return`),
		)
	}

	const withMenu = patchMenuItemDescriptions(patched)
	if (!withMenu) {
		throw new Error(
			'Could not patch menu item Description (titleAttr) fields: no known @emdash-cms/admin menu item layout matched. Update MENU_LAYOUTS in apps/web/scripts/patch-emdash-admin.mjs for this admin version.',
		)
	}
	return withMenu
}

export function isPatched(code) {
	return (
		code.includes('case "link_settings"') &&
		code.includes('case "markdown_input"') &&
		code.includes(MENU_DESCRIPTION_MARKER)
	)
}

function main() {
	const require = createRequire(import.meta.url)
	const adminPath = require.resolve('@emdash-cms/admin')
	const source = readFileSync(adminPath, 'utf8')

	if (isPatched(source)) {
		console.log(
			'[patch-emdash-admin] @emdash-cms/admin already supports custom fields and menu descriptions',
		)
		return
	}

	let patched
	try {
		patched = patchAdminBundle(source)
	} catch (error) {
		console.error(`[patch-emdash-admin] ${error.message}`)
		process.exit(1)
	}
	if (patched === source) {
		console.error(
			'[patch-emdash-admin] Patch made no changes to @emdash-cms/admin',
		)
		process.exit(1)
	}

	writeFileSync(adminPath, patched)
	console.log(
		'[patch-emdash-admin] Patched @emdash-cms/admin for custom fields and menu descriptions',
	)
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	main()
}
