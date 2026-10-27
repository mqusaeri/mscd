// The probe screen calls no route; a real screen lists `[method, path]` constants and their shared route ids here.
import type { RouteRef } from '../api';

export const ROUTES = {} as const satisfies Record<string, RouteRef>;
export const ROUTE_IDS: Record<keyof typeof ROUTES, string> = {};
