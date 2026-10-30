// Intl polyfills for Hermes: Lingui needs Intl.Locale and Intl.PluralRules
// with data for every locale the app ships. `polyfill-force` replaces Hermes'
// partial implementation so plural categories behave the same on every phone.
// The packages' exports maps only publish the .js-suffixed subpaths.
import '@formatjs/intl-locale/polyfill-force.js'
import '@formatjs/intl-pluralrules/polyfill-force.js'
import '@formatjs/intl-pluralrules/locale-data/en'
import '@formatjs/intl-pluralrules/locale-data/ar'
import '@formatjs/intl-pluralrules/locale-data/de'
import '@formatjs/intl-pluralrules/locale-data/es'
import '@formatjs/intl-pluralrules/locale-data/fr'
import '@formatjs/intl-pluralrules/locale-data/zh'
