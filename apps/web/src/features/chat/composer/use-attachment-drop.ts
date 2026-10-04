import { dragPayloadHasFiles, trackDropDepth } from "@renderer/features/chat/composer/attachment-drop";
import { type DragEvent, useRef, useState } from "react";

/** Accepts file drags and passes dropped files to addFiles for type, size and count validation. Spread `dropHandlers` on the zone element and highlight it while `dropActive` is true. Validation failures appear as attachment issues. */
export function useAttachmentDrop(addFiles: (files: Iterable<File>) => Promise<void>) {
	const [dropActive, setDropActive] = useState(false);
	const depthRef = useRef(0);

	const apply = (transition: "enter" | "leave" | "reset") => {
		const next = trackDropDepth(depthRef.current, transition);
		depthRef.current = next.depth;
		setDropActive(next.active);
	};

	const dropHandlers = {
		onDragEnter: (event: DragEvent<HTMLElement>) => {
			if (!dragPayloadHasFiles(event.dataTransfer.types)) return;
			event.preventDefault();
			apply("enter");
		},
		onDragOver: (event: DragEvent<HTMLElement>) => {
			if (!dragPayloadHasFiles(event.dataTransfer.types)) return;
			// preventDefault marks the zone droppable; without it the drop event never fires.
			event.preventDefault();
			event.dataTransfer.dropEffect = "copy";
		},
		onDragLeave: (event: DragEvent<HTMLElement>) => {
			if (!dragPayloadHasFiles(event.dataTransfer.types)) return;
			apply("leave");
		},
		onDrop: (event: DragEvent<HTMLElement>) => {
			if (!dragPayloadHasFiles(event.dataTransfer.types)) return;
			event.preventDefault();
			apply("reset");
			const files = [...event.dataTransfer.files];
			if (files.length > 0) void addFiles(files);
		},
	};

	return { dropActive, dropHandlers };
}
