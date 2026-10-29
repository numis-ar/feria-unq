import type * as http from 'http';

export function initBackendUxMetrics(): void;
export function getSessionId(req: http.IncomingMessage): string;
export function trackEvent(sessionId: string, data: Record<string, unknown>): void;
export function trackRequest(sessionId: string, data: Record<string, unknown>): void;
export function trackLoad(sessionId: string, data: Record<string, unknown>): void;
export function handleUxMetricsPost(req: http.IncomingMessage, res: http.ServerResponse): Promise<void>;
export function handleUxMetricsGet(req: http.IncomingMessage, res: http.ServerResponse): void;
