// Types for the plain-JS server modules, so vite.config.ts and tests can import them cleanly.
export interface Feed {
  fetchedAt: string;
  providers: {
    id: string;
    name: string;
    site: string;
    count: number;
    unplaced: number;
    fetchedAt: string | null;
    error: string | null;
    stale: boolean;
    loading: boolean;
  }[];
  stations: Record<string, any>;
  offers: any[];
}

export interface Api {
  (req: any, res: any, next?: () => void): Promise<boolean>;
  /** Trips from every site; `waitMs` waits up to that long for all of them. */
  allTrips(options?: { fresh?: boolean; waitMs?: number }): Promise<Feed>;
  /** Look up missing road shapes for these trips for at most `budgetMs`; returns how many were left. */
  lookUpRoads(data: Feed, budgetMs: number): Promise<number>;
  /** Saved road shapes for these trips. */
  shapesFor(data: Feed): Record<string, { p: string; km?: number; min?: number }>;
}

export function createApi(options?: { cacheDir?: string; log?: { warn?: (...args: unknown[]) => void } }): Api;

export function simplify(points: number[][], tolerance: number): number[][];

export function encodePolyline(points: number[][]): string;
