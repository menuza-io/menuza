import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer'

/**
 * Render one element with react-test-renderer.
 *
 * Uniwind's babel pipeline gives component files and test files different
 * references for some React Native host wrappers (Pressable is an object on
 * one side and a function on the other), so identity lookups by component
 * type are unreliable for those. Query interactive elements by their
 * accessibility props instead of by type.
 */
export function render(
	element: React.ReactElement,
): TestRenderer.ReactTestRenderer {
	let renderer: TestRenderer.ReactTestRenderer | undefined
	act(() => {
		renderer = TestRenderer.create(element)
	})
	if (!renderer) throw new Error('render failed')
	return renderer
}

/** Every node that behaves like a pressable (outermost first). */
export function findPressables(
	root: ReactTestInstance,
): Array<ReactTestInstance> {
	return root.findAll(
		(node) =>
			typeof node.props?.onPress === 'function' &&
			['button', 'link', 'checkbox', 'radio'].includes(
				node.props.accessibilityRole,
			),
	)
}

export function findPressable(root: ReactTestInstance): ReactTestInstance {
	const matches = findPressables(root)
	if (matches.length === 0) throw new Error('no pressable found')
	return matches[0]!
}

export function press(instance: ReactTestInstance): void {
	act(() => {
		instance.props.onPress({})
	})
}
