// The browser build has no Node APIs (no PNG encoder). The wallet only needs
// the module matrix, which it draws itself with react-native-svg.
declare module 'qrcode/lib/browser.js' {
	export { create } from 'qrcode'
}
