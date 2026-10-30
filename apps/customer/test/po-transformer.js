// Compiles Lingui `.po` catalogs for Jest, the way @lingui/metro-transformer
// does for the app bundle, so tests render real translations.
const { formatter } = require('@lingui/format-po')
const { compileMessage } = require('@lingui/message-utils/compileMessage')

const po = formatter()

module.exports = {
	process(source) {
		const catalog = po.parse(source)
		const messages = {}
		for (const [id, entry] of Object.entries(catalog)) {
			if (entry.obsolete) continue
			// An empty translation falls back to the source message, as the
			// Lingui catalog loader does for the fallback locale.
			messages[id] = compileMessage(entry.translation || entry.message || id)
		}
		return {
			code: `module.exports = { messages: ${JSON.stringify(messages)} }`,
		}
	},
}
