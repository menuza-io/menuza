import '@testing-library/jest-dom/vitest'

// jsdom does not implement these; components in this package (the email
// preview's container measurement, responsive UI primitives) rely on them.
if (!('ResizeObserver' in globalThis)) {
	class ResizeObserverStub {
		observe() {}
		unobserve() {}
		disconnect() {}
	}
	Object.defineProperty(globalThis, 'ResizeObserver', {
		writable: true,
		value: ResizeObserverStub,
	})
}

if (typeof window !== 'undefined' && !window.matchMedia) {
	Object.defineProperty(window, 'matchMedia', {
		writable: true,
		value: (query: string) => ({
			matches: false,
			media: query,
			onchange: null,
			addEventListener: () => {},
			removeEventListener: () => {},
			addListener: () => {},
			removeListener: () => {},
			dispatchEvent: () => false,
		}),
	})
}

// base-ui's ScrollArea probes running animations; jsdom has no Web Animations.
if (
	typeof Element !== 'undefined' &&
	typeof Element.prototype.getAnimations !== 'function'
) {
	Element.prototype.getAnimations = () => []
}
