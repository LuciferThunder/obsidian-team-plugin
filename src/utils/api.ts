import type { RequestUrlResponse } from 'obsidian';

export interface ApiErrorBody {
    error?: string;
}

export interface CaptchaResponse {
    captchaId: string;
    captchaSvg: string;
}

export interface AuthUser {
    id: string;
    username: string;
}

export interface AuthResponse {
    success: boolean;
    error?: string;
    token?: string;
    user?: AuthUser;
}

export interface ClaudeMessageResponse {
    content?: Array<{ text?: string }>;
}

export interface OpenAIChatResponse {
    choices?: Array<{ message?: { content?: string } }>;
}

export interface TeamDriveChangedMessage {
    type?: string;
    deleted?: string[];
    renamed?: Array<{ from: string; to: string }>;
    users?: Array<{ userId: string; username: string }>;
    id?: string;
    recipientId?: string;
    actorName?: string;
    fileId?: string;
    filePath?: string;
    kind?: string;
    excerpt?: string;
    createdAt?: number;
}

export interface JwtPayload {
    exp?: number;
}

export function getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    return String(error);
}

export function readResponseJson<T>(response: RequestUrlResponse): T {
    return response.json as T;
}

export function extractApiError(body: unknown): string | undefined {
    if (!body || typeof body !== 'object') {
        return undefined;
    }
    const error = (body as ApiErrorBody).error;
    return typeof error === 'string' ? error : undefined;
}
