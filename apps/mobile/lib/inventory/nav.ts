import { router } from 'expo-router'

/** Typed routes are generated at build time; the inventory screens navigate by path. */
export function go(path: string): void {
	router.push(path as never)
}
