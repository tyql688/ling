import * as DialogPrimitive from "@radix-ui/react-dialog";
import { cn } from "@renderer/lib/utils";
import { X } from "lucide-react";
import {
	type ComponentProps,
	createContext,
	forwardRef,
	type RefObject,
	useCallback,
	useContext,
	useInsertionEffect,
	useRef,
} from "react";

interface DialogFocusContextValue {
	returnFocusRef: RefObject<HTMLElement | null>;
}

const DialogFocusContext = createContext<DialogFocusContextValue | null>(null);

function focusedElement(): HTMLElement | null {
	if (typeof document === "undefined" || typeof HTMLElement === "undefined") return null;
	const activeElement = document.activeElement;
	if (!(activeElement instanceof HTMLElement)) return null;
	if (activeElement === document.body || activeElement === document.documentElement) return null;
	return activeElement;
}

function canRestoreFocus(element: HTMLElement | null): element is HTMLElement {
	if (!element?.isConnected || element.hidden) return false;
	if (element.matches(":disabled,[aria-disabled='true']")) return false;
	if (element.closest("[inert],[aria-hidden='true']")) return false;
	return true;
}

function fallbackFocusTarget(): HTMLElement | null {
	for (const selector of ["[data-shell-sidebar-trigger]", "[data-dialog-focus-fallback]"]) {
		const candidate = document.querySelector<HTMLElement>(selector);
		if (canRestoreFocus(candidate)) return candidate;
	}
	return null;
}

/**
 * Radix restores focus to DialogTrigger, but Ling also opens controlled dialogs from global
 * shortcuts and controller callbacks. Remember the real opener so those surfaces get the same
 * focus restoration without introducing invisible trigger elements.
 */
function Dialog(props: DialogPrimitive.DialogProps) {
	const initiallyOpen = props.open === true || (props.open === undefined && props.defaultOpen === true);
	// Most Ling dialogs are mounted only after their opener is activated. Capture that opener
	// during the initial render, before Radix moves focus into newly mounted content; watching a
	// later `open` transition alone cannot restore focus for this conditional-mount pattern.
	const returnFocusRef = useRef<HTMLElement | null>(initiallyOpen ? focusedElement() : null);
	const openRef = useRef(initiallyOpen);

	useInsertionEffect(() => {
		if (props.open === undefined) return;
		if (props.open && !openRef.current) returnFocusRef.current = focusedElement();
		openRef.current = props.open;
	}, [props.open]);

	const { onOpenChange } = props;
	const handleOpenChange = useCallback(
		(nextOpen: boolean) => {
			if (nextOpen && !openRef.current) returnFocusRef.current = focusedElement();
			openRef.current = nextOpen;
			onOpenChange?.(nextOpen);
		},
		[onOpenChange],
	);

	return (
		<DialogFocusContext.Provider value={{ returnFocusRef }}>
			<DialogPrimitive.Root {...props} onOpenChange={handleOpenChange} />
		</DialogFocusContext.Provider>
	);
}

const dialogContentBase = // will-change promotes zoom/fade to a compositor layer up front: large dialogs (session analysis, workbench)
	// do not relayout on the main thread during the first frame. Listing only transform/opacity lets the GPU composite.
	"glass-surface floating-surface z-50 min-w-0 border-border-subtle bg-dialog p-5 text-text-primary shadow-(--shadow-floating) outline-none duration-150 will-change-[transform,opacity]";

const dialogContentVariants = {
	center:
		"fixed data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 top-1/2 left-1/2 max-h-[calc(100dvh/var(--app-css-zoom,1)-2rem)] w-[calc(100vw/var(--app-css-zoom,1)-2rem)] -translate-x-1/2 -translate-y-1/2 rounded-dialog border",
	"left-sheet":
		"fixed data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left inset-y-0 left-0 h-dvh w-[min(24rem,calc(100vw-3rem))] max-w-none border-r",
	"right-sheet":
		"fixed data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right inset-y-0 right-0 h-dvh w-[min(32rem,calc(100vw-3rem))] max-w-none border-l",
	// Large panels don't zoom (zooming re-rasterizes the whole layer texture every frame); fade + small rise stay on the compositor.
	workspace:
		"absolute data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:slide-out-to-bottom-1 data-[state=open]:slide-in-from-bottom-2 top-1/2 left-1/2 h-[min(44rem,calc(100%-1.5rem))] w-[min(64rem,calc(100%-1.5rem))] max-w-none -translate-x-1/2 -translate-y-1/2 rounded-dialog border duration-200 ease-out",
	"workspace-right-sheet":
		"absolute data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right inset-y-0 right-0 h-auto w-full max-w-none border-l duration-200 ease-out sm:w-[min(22rem,100%)]",
};

type DialogContentVariant = keyof typeof dialogContentVariants;
type DialogContentSize = "small" | "compact" | "default" | "medium" | "large" | "viewport";
type DialogCloseAutoFocusEvent = Parameters<NonNullable<DialogPrimitive.DialogContentProps["onCloseAutoFocus"]>>[0];

const dialogContentSizeClass: Record<DialogContentSize, string> = {
	small: "max-w-sm",
	compact: "max-w-md",
	default: "max-w-xl",
	medium: "max-w-2xl",
	large: "max-w-4xl",
	viewport: "max-w-[92vw]",
};

interface DialogContentProps extends DialogPrimitive.DialogContentProps {
	variant?: DialogContentVariant;
	/** Centered dialogs scale by task: compact prompts, normal forms, or content browsing. */
	size?: DialogContentSize;
	overlayClassName?: string;
	portalled?: boolean;
	portalContainer?: HTMLElement | null;
}

function DialogOverlay({ className, ...props }: DialogPrimitive.DialogOverlayProps) {
	return (
		<DialogPrimitive.Overlay
			data-slot="dialog-overlay"
			className={cn(
				"data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-overlay backdrop-blur-[1px] duration-150",
				className,
			)}
			{...props}
		/>
	);
}

const DialogContent = forwardRef<HTMLDivElement, DialogContentProps>(function DialogContent(
	{
		className,
		children,
		variant,
		size = "default",
		overlayClassName,
		portalled = true,
		portalContainer,
		onCloseAutoFocus,
		...props
	},
	forwardedRef,
) {
	const focusContext = useContext(DialogFocusContext);
	const handleCloseAutoFocus = (event: DialogCloseAutoFocusEvent) => {
		onCloseAutoFocus?.(event);
		if (event.defaultPrevented) return;

		const returnFocusRef = focusContext?.returnFocusRef;
		if (!returnFocusRef) return;
		const returnFocus = returnFocusRef.current;
		const destination = canRestoreFocus(returnFocus) ? returnFocus : fallbackFocusTarget();
		returnFocusRef.current = null;
		if (!destination) return;
		event.preventDefault();
		destination.focus({ preventScroll: true });
	};
	const overlay = <DialogOverlay className={overlayClassName} />;
	const content = (
		<DialogPrimitive.Content
			ref={forwardedRef}
			data-slot="dialog-content"
			className={cn(
				dialogContentBase,
				dialogContentVariants[variant ?? "center"],
				(variant === undefined || variant === "center") && dialogContentSizeClass[size],
				className,
			)}
			onCloseAutoFocus={handleCloseAutoFocus}
			{...props}
		>
			{children}
		</DialogPrimitive.Content>
	);

	if (!portalled)
		return (
			<>
				{overlay}
				{content}
			</>
		);
	return (
		<DialogPrimitive.Portal {...(portalContainer === undefined ? {} : { container: portalContainer })}>
			{overlay}
			{content}
		</DialogPrimitive.Portal>
	);
});

function DialogHeader({ className, ...props }: ComponentProps<"div">) {
	return <div data-slot="dialog-header" className={cn("flex flex-col gap-1.5", className)} {...props} />;
}

function DialogTitle({ className, ...props }: DialogPrimitive.DialogTitleProps) {
	return (
		<DialogPrimitive.Title
			data-slot="dialog-title"
			className={cn("text-sm font-semibold text-text-primary", className)}
			{...props}
		/>
	);
}

function DialogDescription({ className, ...props }: DialogPrimitive.DialogDescriptionProps) {
	return (
		<DialogPrimitive.Description
			data-slot="dialog-description"
			className={cn("text-sm text-text-muted", className)}
			{...props}
		/>
	);
}

function DialogFooter({ className, ...props }: ComponentProps<"div">) {
	return <div data-slot="dialog-footer" className={cn("flex justify-end gap-2 pt-1", className)} {...props} />;
}

function DialogCloseButton({ className, ...props }: DialogPrimitive.DialogCloseProps) {
	return (
		<DialogPrimitive.Close
			data-slot="dialog-close"
			className={cn(
				"absolute top-4 right-4 inline-flex size-7 items-center justify-center rounded-control text-text-muted transition-colors hover:bg-surface-hover hover:text-text-primary focus-visible:bg-surface-hover focus-visible:text-text-primary",
				className,
			)}
			{...props}
		>
			<X className="size-4" aria-hidden="true" />
		</DialogPrimitive.Close>
	);
}

export { Dialog, DialogCloseButton, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle };
