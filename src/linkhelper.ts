/**
 * TrguiNG - next gen remote GUI for transmission torrent daemon
 * Copyright (C) 2023  qu1ck (mail at qu1ck.org)
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import type { ServerConfig } from "config";
const { TAURI, invoke } = await import(/* webpackChunkName: "taurishim" */"taurishim");

export interface SearchCandidatesRequest {
    torrentName: string,
    downloadDir: string,
    targetPath: string,
    targetKindHint: "auto" | "file" | "dir",
}

export interface SearchCandidate {
    path: string,
    name: string,
    kind: "file" | "dir" | "other",
    score: number,
    reason: string,
    searchRoot: string,
}

export interface SearchCandidatesResponse {
    targetPath: string,
    targetKind: "file" | "dir",
    candidates: SearchCandidate[],
}

export interface CreateSymlinkRequest {
    sourcePath: string,
    targetPath: string,
}

export interface CreateSymlinkResponse {
    status: "created" | "skipped_exists",
    sourcePath: string,
    targetPath: string,
}

interface ErrorResponse {
    error?: string,
}

function helperUrl(serverConfig: ServerConfig, path: string) {
    return `${serverConfig.linkHelper.url.replace(/\/+$/, "")}${path}`;
}

async function helperFetchBrowser<TResponse>(
    serverConfig: ServerConfig,
    path: string,
    payload?: SearchCandidatesRequest | CreateSymlinkRequest,
) {
    const headers: HeadersInit = {
        Accept: "application/json",
    };
    if (serverConfig.linkHelper.token.trim() !== "") {
        headers.Authorization = `Bearer ${serverConfig.linkHelper.token.trim()}`;
    }
    if (payload !== undefined) {
        headers["Content-Type"] = "application/json";
    }

    const response = await fetch(helperUrl(serverConfig, path), {
        method: payload === undefined ? "GET" : "POST",
        headers,
        body: payload === undefined ? undefined : JSON.stringify(payload),
    });

    if (!response.ok) {
        let message = `Link helper request failed: ${response.status}`;
        try {
            const errorBody = await response.json() as ErrorResponse;
            if (typeof errorBody.error === "string" && errorBody.error !== "") {
                message = errorBody.error;
            }
        } catch {
            // ignore invalid json error payloads
        }
        throw new Error(message);
    }

    return await response.json() as TResponse;
}

async function helperFetch<TResponse>(
    serverConfig: ServerConfig,
    path: string,
    payload?: SearchCandidatesRequest | CreateSymlinkRequest,
) {
    if (serverConfig.linkHelper.url.trim() === "") {
        throw new Error("Link helper URL is not configured");
    }

    if (TAURI) {
        return await invoke<TResponse>("link_helper_request", {
            request: {
                url: helperUrl(serverConfig, path),
                token: serverConfig.linkHelper.token,
                method: payload === undefined ? "GET" : "POST",
                payload,
            },
        });
    }

    return await helperFetchBrowser<TResponse>(serverConfig, path, payload);
}

export function isLinkHelperConfigured(serverConfig: ServerConfig) {
    return serverConfig.linkHelper.url.trim() !== "";
}

export async function fetchLinkHelperHealth(serverConfig: ServerConfig) {
    return await helperFetch<{ status: string }>(serverConfig, "/health");
}

export async function searchLinkCandidates(serverConfig: ServerConfig, payload: SearchCandidatesRequest) {
    return await helperFetch<SearchCandidatesResponse>(serverConfig, "/search-candidates", payload);
}

export async function createLinkSymlink(serverConfig: ServerConfig, payload: CreateSymlinkRequest) {
    return await helperFetch<CreateSymlinkResponse>(serverConfig, "/create-symlink", payload);
}
