import type { AnnotationColor } from "./types";

export const ANNOTATION_COLORS: AnnotationColor[] = [
	"yellow", "orange", "red", "purple", "magenta", "blue", "green", "gray",
];

const HUES: Record<AnnotationColor, number> = {
	yellow: 55,
	orange: 28,
	red: 0,
	purple: 265,
	magenta: 300,
	blue: 205,
	green: 115,
	gray: 100,
};

/** A translucent tint of an annotation colour, for swatches and cards. */
export function annotationTint(color: AnnotationColor, lightness: number, alpha: number): string {
	const saturation = color === "gray" ? "0%" : "75%";
	return `hsla(${HUES[color]}, ${saturation}, ${lightness}%, ${alpha})`;
}
