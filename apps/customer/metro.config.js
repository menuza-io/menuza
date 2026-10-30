const { getDefaultConfig } = require('expo/metro-config')
const { withUniwindConfig } = require('uniwind/metro')

const config = getDefaultConfig(__dirname)

// Lingui catalogs are imported as `.po` files and compiled by the transformer.
config.resolver.sourceExts.push('po')
config.transformer = {
	...config.transformer,
	babelTransformerPath: require.resolve('@lingui/metro-transformer/expo'),
}

module.exports = withUniwindConfig(config, {
	cssEntryFile: './app/global.css',
	dtsFile: './uniwind-env.d.ts',
})
