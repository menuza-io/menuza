const path = require('node:path')

/**
 * This workspace pins the React version React Native 0.81 was built with,
 * while the repository root hoists a newer React for the web apps. Tests must
 * load one React for the app, the renderer and the test renderer, or hooks
 * break with "Invalid hook call". (React Native 0.88 / Expo SDK 58.)
 */
function packageDir(name) {
	return path.dirname(
		require.resolve(`${name}/package.json`, { paths: [__dirname] }),
	)
}

/** @type {import('jest').Config} */
module.exports = {
	preset: 'jest-expo',
	setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
	testPathIgnorePatterns: [
		'/node_modules/',
		'<rootDir>/dist/',
		'<rootDir>/.expo/',
	],
	transform: {
		'\\.po$': '<rootDir>/test/po-transformer.js',
	},
	transformIgnorePatterns: [
		'node_modules/(?!((jest-)?react-native|@react-native(-community)?)|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@unimodules/.*|unimodules|uniwind|@formatjs)',
	],
	moduleNameMapper: {
		// The Intl polyfills are for Hermes; Node's ICU already has them, and
		// the packages' ESM needs transforms the app babel config does not ship.
		'^@formatjs/intl-locale/polyfill-force\\.js$': '<rootDir>/test/noop.js',
		'^@formatjs/intl-pluralrules/(polyfill-force\\.js|locale-data/.*)$':
			'<rootDir>/test/noop.js',
		'^@/(.*)$': '<rootDir>/$1',
		// Lucide's `react-native` export is an .mjs file, which the jest-expo
		// transform does not cover; its CommonJS build is the same icons.
		'^lucide-react-native$': require.resolve('lucide-react-native', {
			paths: [__dirname],
		}),
		'^react$': packageDir('react'),
		'^react/(.*)$': `${packageDir('react')}/$1`,
		'^react-test-renderer$': packageDir('react-test-renderer'),
		// Testing Library is hoisted to the root and checks this file's version.
		'^react-test-renderer/(.*)$': `${packageDir('react-test-renderer')}/$1`,
	},
}
