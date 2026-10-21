/** DOM events used by the CM6 gutter and Reading-view margin icons. */
export const ANNOTATION_EVENTS = {
	open: "mas-annotation-open",
	hover: "mas-annotation-hover",
	leave: "mas-annotation-leave",
} as const;

export interface AnnotationEventDetail {
	ids: string[];
}

declare global {
	interface DocumentEventMap {
		"mas-annotation-open": CustomEvent<AnnotationEventDetail>;
		"mas-annotation-hover": CustomEvent<AnnotationEventDetail>;
		"mas-annotation-leave": CustomEvent<AnnotationEventDetail>;
	}
}
