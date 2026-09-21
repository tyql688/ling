import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
	/** Renders the error state; reset clears the error and re-renders the subtree. */
	fallback: (error: Error, reset: () => void) => ReactNode;
	/** Any element change (per-element Object.is) auto-clears the error state; omit to only allow explicit reset. */
	resetKeys?: readonly unknown[] | undefined;
	children: ReactNode;
}

interface ErrorBoundaryState {
	error: Error | null;
}

function resetKeysChanged(previous: readonly unknown[], next: readonly unknown[]): boolean {
	return previous.length !== next.length || next.some((key, index) => !Object.is(key, previous[index]));
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
	override state: ErrorBoundaryState = { error: null };

	static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
		return { error: error instanceof Error ? error : new Error(String(error)) };
	}

	override componentDidCatch(error: Error, info: ErrorInfo): void {
		// Errors are not silent: the boundary only contains the crash; the original error always goes to the console for debugging.
		console.error("Renderer subtree crashed", error, info.componentStack);
	}

	override componentDidUpdate(previousProps: ErrorBoundaryProps): void {
		if (this.state.error === null || this.props.resetKeys === undefined) return;
		const previousKeys = previousProps.resetKeys === undefined ? [] : previousProps.resetKeys;
		if (resetKeysChanged(previousKeys, this.props.resetKeys)) this.setState({ error: null });
	}

	private readonly reset = (): void => {
		this.setState({ error: null });
	};

	override render(): ReactNode {
		if (this.state.error !== null) return this.props.fallback(this.state.error, this.reset);
		return this.props.children;
	}
}
