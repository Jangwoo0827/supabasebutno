export function parseApiOrigin(text: string): string;
export function contentSecurityPolicy(apiOrigin: string | null): string;
export function buildPages(opts: { srcDir?: string; outDir: string; apiUrl?: string }): { outDir: string; apiOrigin: string | null };
