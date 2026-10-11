export function gccImage(distribution: string, version: string): string;
export function ciImageContext(distribution: string, context: string, image: string, architecture?: string): string;
export function verifyCIImage(image: string, architecture?: string): void;
