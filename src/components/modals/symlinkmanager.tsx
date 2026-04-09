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

import { Alert, Badge, Box, Button, Divider, Group, LoadingOverlay, Paper, ScrollArea, Stack, Switch, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { deleteLinkSymlink, listLinkSymlinks } from "linkhelper";
import type { SymlinkEntry } from "linkhelper";
import React, { useCallback, useContext, useEffect, useMemo, useState } from "react";
import { ConfigContext, ServerConfigContext } from "config";
import type { ServerConfig } from "config";
import { TransmissionClient } from "rpc/client";
import { HkModal } from "./common";
import * as Icon from "react-bootstrap-icons";

interface SymlinkManagerModalProps {
    opened: boolean,
    close: () => void,
}

type EffectiveSymlinkStatus = "ok" | "broken" | "unused" | "checking" | "degraded";
type ServerUsageLoadStatus = "loading" | "loaded" | "error";
type HelperScanLoadStatus = "loading" | "loaded" | "error";

interface HelperSource {
    key: string,
    label: string,
    url: string,
    token: string,
    serverNames: string[],
    requestServerConfig: ServerConfig,
}

interface OwnedSymlinkEntry extends SymlinkEntry {
    helperKey: string,
    helperLabel: string,
    helperUrl: string,
    helperServerNames: string[],
}

interface SymlinkViewEntry extends OwnedSymlinkEntry {
    effectiveStatus: EffectiveSymlinkStatus,
    usedByTorrents: string[],
}

interface HelperSymlinkState {
    helper: HelperSource,
    status: HelperScanLoadStatus,
    symlinks: OwnedSymlinkEntry[],
    error?: string,
}

interface ServerUsageState {
    serverName: string,
    status: ServerUsageLoadStatus,
    usage: Map<string, string[]>,
    torrentCount?: number,
    error?: string,
}

interface ServerUsageResult {
    serverName: string,
    usage: Map<string, string[]>,
    torrentCount: number,
}

interface SymlinkGroup {
    helper: HelperSource,
    helperState: HelperSymlinkState,
    entries: SymlinkViewEntry[],
}

function normalizeComparePath(path: string) {
    return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

function normalizeHelperUrl(url: string) {
    return url.trim().replace(/\/+$/, "");
}

function helperIdentityKey(url: string, token: string) {
    return `${normalizeHelperUrl(url)}\n${token.trim()}`;
}

function helperDisplayLabel(url: string) {
    try {
        const parsed = new URL(url);
        const trimmedPath = parsed.pathname.replace(/\/+$/, "");
        return `${parsed.host}${trimmedPath === "" ? "" : trimmedPath}`;
    } catch {
        return url;
    }
}

function buildHelperSources(servers: ServerConfig[]) {
    const helpers = new Map<string, HelperSource>();

    servers.forEach((server) => {
        const url = normalizeHelperUrl(server.linkHelper.url);
        if (url === "") return;

        const token = server.linkHelper.token.trim();
        const key = helperIdentityKey(url, token);
        const existing = helpers.get(key);
        if (existing !== undefined) {
            if (!existing.serverNames.includes(server.name)) {
                existing.serverNames.push(server.name);
                existing.serverNames.sort((left, right) => left.localeCompare(right));
            }
            return;
        }

        helpers.set(key, {
            key,
            label: helperDisplayLabel(url),
            url,
            token,
            serverNames: [server.name],
            requestServerConfig: {
                ...server,
                linkHelper: {
                    url,
                    token,
                },
            },
        });
    });

    return Array.from(helpers.values()).sort((left, right) =>
        left.label.localeCompare(right.label) ||
        left.url.localeCompare(right.url),
    );
}

function buildTorrentTargetPath(downloadDir: string, torrentName: string) {
    return normalizeComparePath(`${downloadDir.replace(/[\\/]+$/, "")}/${torrentName}`);
}

const CrossServerUsageTimeoutMs = 5000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string) {
    return new Promise<T>((resolve, reject) => {
        const timer = window.setTimeout(() => {
            reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`));
        }, timeoutMs);

        promise.then((value) => {
            window.clearTimeout(timer);
            resolve(value);
        }).catch((error: Error) => {
            window.clearTimeout(timer);
            reject(error);
        });
    });
}

async function collectTorrentUsage(server: ServerConfig): Promise<ServerUsageResult> {
    const client = new TransmissionClient(server.connection, false, false);
    const torrents = await withTimeout(
        client.getTorrents(["downloadDir", "name"]),
        CrossServerUsageTimeoutMs,
        `Server ${server.name}`,
    );
    const usage = new Map<string, string[]>();

    torrents.forEach((torrent) => {
        if (typeof torrent.downloadDir !== "string" || typeof torrent.name !== "string") return;

        const path = buildTorrentTargetPath(torrent.downloadDir, torrent.name);
        const label = `${server.name}: ${torrent.name}`;
        const currentUsers = usage.get(path) ?? [];
        if (!currentUsers.includes(label)) {
            currentUsers.push(label);
            usage.set(path, currentUsers);
        }
    });

    return {
        serverName: server.name,
        usage,
        torrentCount: torrents.length,
    };
}

function serverStatusColor(status: ServerUsageLoadStatus) {
    if (status === "loaded") return "green";
    if (status === "error") return "red";
    return "blue";
}

function helperStatusColor(status: HelperScanLoadStatus) {
    if (status === "loaded") return "green";
    if (status === "error") return "red";
    return "blue";
}

function symlinkIdentity(item: Pick<OwnedSymlinkEntry, "helperKey" | "path">) {
    return `${item.helperKey}::${item.path}`;
}

function decorateHelperSymlinks(helper: HelperSource, symlinks: SymlinkEntry[]): OwnedSymlinkEntry[] {
    return symlinks.map((item) => ({
        ...item,
        helperKey: helper.key,
        helperLabel: helper.label,
        helperUrl: helper.url,
        helperServerNames: [...helper.serverNames],
    }));
}

export function SymlinkManagerModal(props: SymlinkManagerModalProps) {
    const config = useContext(ConfigContext);
    const serverConfig = useContext(ServerConfigContext);
    const [deletingPath, setDeletingPath] = useState<string>();
    const [deletingBroken, setDeletingBroken] = useState(false);
    const [actionError, setActionError] = useState<string>();
    const [invalidOnly, setInvalidOnly] = useState(false);
    const [helperSymlinkStates, setHelperSymlinkStates] = useState<Map<string, HelperSymlinkState>>(new Map());
    const [serverUsageStates, setServerUsageStates] = useState<Map<string, ServerUsageState>>(new Map());

    const allServers = useMemo(() => {
        const configuredServers = config.getServers();
        if (configuredServers.length > 0) return configuredServers;
        return serverConfig.name === "" ? [] : [serverConfig];
    }, [config, serverConfig]);

    const usageServers = allServers;
    const helperSources = useMemo(() => buildHelperSources(allServers), [allServers]);
    const helperSourceMap = useMemo(
        () => new Map(helperSources.map((helper) => [helper.key, helper])),
        [helperSources],
    );

    const loadUsageForServer = useCallback(async (server: ServerConfig) => {
        setServerUsageStates((current) => {
            const next = new Map(current);
            next.set(server.name, {
                serverName: server.name,
                status: "loading",
                usage: new Map(),
            });
            return next;
        });

        try {
            const result = await collectTorrentUsage(server);
            setServerUsageStates((current) => {
                const next = new Map(current);
                next.set(server.name, {
                    serverName: result.serverName,
                    status: "loaded",
                    usage: result.usage,
                    torrentCount: result.torrentCount,
                });
                return next;
            });
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            setServerUsageStates((current) => {
                const next = new Map(current);
                next.set(server.name, {
                    serverName: server.name,
                    status: "error",
                    usage: new Map(),
                    error: message,
                });
                return next;
            });
        }
    }, []);

    const reloadDownloaderUsage = useCallback((servers?: ServerConfig[]) => {
        const targets = servers !== undefined && servers.length > 0 ? servers : usageServers;
        setServerUsageStates(new Map(targets.map((server) => [server.name, {
            serverName: server.name,
            status: "loading" as const,
            usage: new Map<string, string[]>(),
        }])));
        targets.forEach((server) => { void loadUsageForServer(server); });
    }, [loadUsageForServer, usageServers]);

    const loadSymlinksForHelper = useCallback(async (helper: HelperSource) => {
        setHelperSymlinkStates((current) => {
            const next = new Map(current);
            const previous = next.get(helper.key);
            next.set(helper.key, {
                helper,
                status: "loading",
                symlinks: previous?.symlinks ?? [],
            });
            return next;
        });

        try {
            const response = await listLinkSymlinks(helper.requestServerConfig);
            setHelperSymlinkStates((current) => {
                const next = new Map(current);
                next.set(helper.key, {
                    helper,
                    status: "loaded",
                    symlinks: decorateHelperSymlinks(helper, response.symlinks),
                });
                return next;
            });
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            setHelperSymlinkStates((current) => {
                const next = new Map(current);
                const previous = next.get(helper.key);
                next.set(helper.key, {
                    helper,
                    status: "error",
                    symlinks: previous?.symlinks ?? [],
                    error: message,
                });
                return next;
            });
        }
    }, []);

    const reloadHelperSymlinks = useCallback((helpers?: HelperSource[]) => {
        const targets = helpers !== undefined && helpers.length > 0 ? helpers : helperSources;
        targets.forEach((helper) => { void loadSymlinksForHelper(helper); });
    }, [helperSources, loadSymlinksForHelper]);

    const loadAll = useCallback(() => {
        setActionError(undefined);
        reloadHelperSymlinks();
        reloadDownloaderUsage();
    }, [reloadDownloaderUsage, reloadHelperSymlinks]);

    useEffect(() => {
        if (!props.opened) {
            setDeletingPath(undefined);
            setDeletingBroken(false);
            setActionError(undefined);
            return;
        }

        const missingHelpers = helperSources.filter((helper) => !helperSymlinkStates.has(helper.key));
        if (missingHelpers.length > 0) {
            reloadHelperSymlinks(missingHelpers);
        }
        if (usageServers.length > 0 && serverUsageStates.size === 0) {
            reloadDownloaderUsage();
        }
    }, [
        helperSources,
        helperSymlinkStates,
        props.opened,
        reloadDownloaderUsage,
        reloadHelperSymlinks,
        serverUsageStates.size,
        usageServers.length,
    ]);

    const onDelete = useCallback((item: OwnedSymlinkEntry) => {
        const helper = helperSourceMap.get(item.helperKey);
        if (helper === undefined) return;

        setDeletingPath(symlinkIdentity(item));
        setActionError(undefined);
        void deleteLinkSymlink(helper.requestServerConfig, { path: item.path }).then(() => {
            setHelperSymlinkStates((current) => {
                const next = new Map(current);
                const helperState = next.get(item.helperKey);
                if (helperState !== undefined) {
                    next.set(item.helperKey, {
                        ...helperState,
                        symlinks: helperState.symlinks.filter((entry) => entry.path !== item.path),
                    });
                }
                return next;
            });
            notifications.show({
                message: `Symlink deleted from ${item.helperLabel}`,
                color: "green",
            });
        }).catch((e: Error) => {
            setActionError(e.message);
        }).finally(() => {
            setDeletingPath(undefined);
        });
    }, [helperSourceMap]);

    const onDeleteBroken = useCallback(() => {
        const helperBatches = new Map<string, OwnedSymlinkEntry[]>();
        helperSymlinkStates.forEach((state) => {
            state.symlinks
                .filter((item) => item.status === "broken")
                .forEach((item) => {
                    const current = helperBatches.get(item.helperKey) ?? [];
                    current.push(item);
                    helperBatches.set(item.helperKey, current);
                });
        });

        if (helperBatches.size === 0) return;

        setDeletingBroken(true);
        setActionError(undefined);
        void (async () => {
            const deletedPathsByHelper = new Map<string, Set<string>>();
            try {
                for (const [helperKey, entries] of helperBatches.entries()) {
                    const helper = helperSourceMap.get(helperKey);
                    if (helper === undefined) continue;

                    for (const entry of entries) {
                        await deleteLinkSymlink(helper.requestServerConfig, { path: entry.path });
                        const deletedPaths = deletedPathsByHelper.get(helperKey) ?? new Set<string>();
                        deletedPaths.add(entry.path);
                        deletedPathsByHelper.set(helperKey, deletedPaths);
                    }
                }

                setHelperSymlinkStates((current) => {
                    const next = new Map(current);
                    deletedPathsByHelper.forEach((deletedPaths, helperKey) => {
                        const helperState = next.get(helperKey);
                        if (helperState === undefined) return;
                        next.set(helperKey, {
                            ...helperState,
                            symlinks: helperState.symlinks.filter((item) => !deletedPaths.has(item.path)),
                        });
                    });
                    return next;
                });

                const deletedCount = Array.from(deletedPathsByHelper.values())
                    .reduce((sum, deletedPaths) => sum + deletedPaths.size, 0);
                notifications.show({
                    message: `Deleted ${deletedCount} broken symlink${deletedCount === 1 ? "" : "s"}`,
                    color: "green",
                });
            } catch (e) {
                setActionError((e as Error).message);
                if (deletedPathsByHelper.size > 0) {
                    setHelperSymlinkStates((current) => {
                        const next = new Map(current);
                        deletedPathsByHelper.forEach((deletedPaths, helperKey) => {
                            const helperState = next.get(helperKey);
                            if (helperState === undefined) return;
                            next.set(helperKey, {
                                ...helperState,
                                symlinks: helperState.symlinks.filter((item) => !deletedPaths.has(item.path)),
                            });
                        });
                        return next;
                    });
                }
            } finally {
                setDeletingBroken(false);
            }
        })();
    }, [helperSourceMap, helperSymlinkStates]);

    const helperStatuses = useMemo(() => {
        return helperSources.map((helper) =>
            helperSymlinkStates.get(helper.key) ?? {
                helper,
                status: "loading" as const,
                symlinks: [],
            });
    }, [helperSources, helperSymlinkStates]);

    const serverStatuses = useMemo(() => {
        return usageServers.map((server) => {
            return serverUsageStates.get(server.name) ?? {
                serverName: server.name,
                status: "loading" as const,
                usage: new Map<string, string[]>(),
            };
        });
    }, [serverUsageStates, usageServers]);

    const torrentUsageMap = useMemo(() => {
        const usage = new Map<string, string[]>();

        serverStatuses.forEach((state) => {
            if (state.status !== "loaded") return;
            state.usage.forEach((labels, path) => {
                const currentUsers = usage.get(path) ?? [];
                labels.forEach((label) => {
                    if (!currentUsers.includes(label)) {
                        currentUsers.push(label);
                    }
                });
                usage.set(path, currentUsers);
            });
        });

        return usage;
    }, [serverStatuses]);

    const symlinks = useMemo(
        () => helperStatuses.flatMap((state) => state.symlinks),
        [helperStatuses],
    );

    const loadingServerCount = useMemo(
        () => serverStatuses.filter((state) => state.status === "loading").length,
        [serverStatuses],
    );
    const failedServerCount = useMemo(
        () => serverStatuses.filter((state) => state.status === "error").length,
        [serverStatuses],
    );
    const loadingHelperCount = useMemo(
        () => helperStatuses.filter((state) => state.status === "loading").length,
        [helperStatuses],
    );
    const failedHelperCount = useMemo(
        () => helperStatuses.filter((state) => state.status === "error").length,
        [helperStatuses],
    );

    const enrichedSymlinks = useMemo<SymlinkViewEntry[]>(() => {
        return symlinks.map((item) => {
            const usedByTorrents = torrentUsageMap.get(normalizeComparePath(item.path)) ?? [];
            const effectiveStatus: EffectiveSymlinkStatus = item.status === "broken"
                ? "broken"
                : usedByTorrents.length > 0
                    ? "ok"
                    : loadingServerCount > 0
                        ? "checking"
                        : failedServerCount > 0 ? "degraded" : "unused";

            return {
                ...item,
                effectiveStatus,
                usedByTorrents,
            };
        });
    }, [failedServerCount, loadingServerCount, symlinks, torrentUsageMap]);

    const filteredSymlinks = useMemo(() => {
        return invalidOnly
            ? enrichedSymlinks.filter((item) =>
                item.effectiveStatus === "broken" ||
                item.effectiveStatus === "unused" ||
                item.effectiveStatus === "degraded")
            : enrichedSymlinks;
    }, [enrichedSymlinks, invalidOnly]);

    const brokenCount = useMemo(
        () => enrichedSymlinks.filter((item) => item.effectiveStatus === "broken").length,
        [enrichedSymlinks],
    );
    const unusedCount = useMemo(
        () => enrichedSymlinks.filter((item) => item.effectiveStatus === "unused").length,
        [enrichedSymlinks],
    );
    const checkingCount = useMemo(
        () => enrichedSymlinks.filter((item) => item.effectiveStatus === "checking").length,
        [enrichedSymlinks],
    );
    const degradedCount = useMemo(
        () => enrichedSymlinks.filter((item) => item.effectiveStatus === "degraded").length,
        [enrichedSymlinks],
    );
    const okCount = enrichedSymlinks.length - brokenCount - unusedCount - checkingCount - degradedCount;

    const groupedSymlinks = useMemo<SymlinkGroup[]>(() => {
        const visibleEntriesByHelper = new Map<string, SymlinkViewEntry[]>();

        filteredSymlinks.forEach((item) => {
            const current = visibleEntriesByHelper.get(item.helperKey) ?? [];
            current.push(item);
            visibleEntriesByHelper.set(item.helperKey, current);
        });

        return helperStatuses
            .map((helperState) => ({
                helper: helperState.helper,
                helperState,
                entries: visibleEntriesByHelper.get(helperState.helper.key) ?? [],
            }))
            .filter((group) => group.entries.length > 0);
    }, [filteredSymlinks, helperStatuses]);

    const initialLoading = props.opened && helperSources.length > 0 && loadingHelperCount > 0 && symlinks.length === 0;
    const showServerStatusPanel = usageServers.length > 1 || loadingServerCount > 0 || failedServerCount > 0;
    const showHelperStatusPanel = helperSources.length > 1 || loadingHelperCount > 0 || failedHelperCount > 0;
    const notConfigured = helperSources.length === 0;

    const retryServerUsage = useCallback((serverName: string) => {
        const target = usageServers.find((server) => server.name === serverName);
        if (target === undefined) return;
        void loadUsageForServer(target);
    }, [loadUsageForServer, usageServers]);

    const retryHelperScan = useCallback((helperKey: string) => {
        const helper = helperSourceMap.get(helperKey);
        if (helper === undefined) return;
        setActionError(undefined);
        void loadSymlinksForHelper(helper);
    }, [helperSourceMap, loadSymlinksForHelper]);

    return (
        <HkModal
            opened={props.opened}
            onClose={props.close}
            title="Symlink manager"
            centered
            size="92rem"
        >
            <Box pos="relative" mih="30rem">
                <LoadingOverlay visible={initialLoading} />
                <Stack spacing="md">
                    <Group position="apart" align="flex-end">
                        <Stack spacing={4}>
                            <Text weight={700}>Manage symlinks across all configured helper roots</Text>
                            <Group spacing="xs">
                                <Badge color="gray" variant="light">{`${enrichedSymlinks.length} total`}</Badge>
                                <Badge color="green" variant="light">{`${okCount} ok`}</Badge>
                                <Badge color="blue" variant="light">{`${checkingCount} checking`}</Badge>
                                <Badge color="yellow" variant="light">{`${unusedCount} unused`}</Badge>
                                <Badge color="orange" variant="light">{`${degradedCount} degraded`}</Badge>
                                <Badge color="red" variant="light">{`${brokenCount} broken`}</Badge>
                            </Group>
                        </Stack>
                        <Group spacing="sm">
                            <Switch
                                checked={invalidOnly}
                                onChange={(e) => { setInvalidOnly(e.currentTarget.checked); }}
                                label="Invalid only"
                            />
                            <Button
                                variant="light"
                                onClick={() => { reloadDownloaderUsage(); }}
                                loading={loadingServerCount > 0}
                                disabled={deletingBroken || deletingPath !== undefined}
                            >
                                Reload downloaders
                            </Button>
                            <Button
                                variant="light"
                                onClick={loadAll}
                                loading={loadingHelperCount > 0}
                                disabled={notConfigured || deletingBroken || deletingPath !== undefined}
                            >
                                Rescan all helpers
                            </Button>
                            <Button
                                color="red"
                                variant="light"
                                onClick={onDeleteBroken}
                                loading={deletingBroken}
                                disabled={notConfigured || brokenCount === 0 || deletingPath !== undefined || loadingHelperCount > 0}
                            >
                                Delete broken
                            </Button>
                        </Group>
                    </Group>

                    {notConfigured &&
                        <Alert color="yellow" icon={<Icon.ExclamationTriangleFill size="1rem" />}>
                            No link helper is configured on any downloader.
                        </Alert>}

                    {actionError !== undefined &&
                        <Alert color="red" icon={<Icon.XCircleFill size="1rem" />}>
                            {actionError}
                        </Alert>}

                    {showHelperStatusPanel &&
                        <Paper p="sm" withBorder>
                            <Stack spacing="xs">
                                <Text weight={600}>Helper scan status</Text>
                                {helperStatuses.map((state) => (
                                    <Paper key={state.helper.key} p="xs" withBorder>
                                        <Group position="apart" align="flex-start" noWrap>
                                            <Stack spacing={2} sx={{ flexGrow: 1, minWidth: 0 }}>
                                                <Group spacing="xs">
                                                    <Text weight={600}>{state.helper.label}</Text>
                                                    <Badge color={helperStatusColor(state.status)} variant="light">
                                                        {state.status}
                                                    </Badge>
                                                    <Badge color="gray" variant="light">
                                                        {`${state.helper.serverNames.length} downloader${state.helper.serverNames.length === 1 ? "" : "s"}`}
                                                    </Badge>
                                                </Group>
                                                <Text size="xs" color="dimmed" sx={{ wordBreak: "break-all" }}>
                                                    {state.helper.url}
                                                </Text>
                                                <Text size="xs" color="dimmed">
                                                    {`Configured on: ${state.helper.serverNames.join(", ")}`}
                                                </Text>
                                                {state.status === "error" &&
                                                    <Text size="xs" color="dimmed">
                                                        {state.error}
                                                    </Text>}
                                            </Stack>
                                            <Button
                                                compact
                                                variant="light"
                                                onClick={() => { retryHelperScan(state.helper.key); }}
                                                loading={state.status === "loading"}
                                                disabled={deletingBroken || deletingPath !== undefined}
                                            >
                                                {state.status === "error" ? "Retry" : "Rescan"}
                                            </Button>
                                        </Group>
                                    </Paper>
                                ))}
                            </Stack>
                        </Paper>}

                    {failedHelperCount > 0 &&
                        <Alert color="yellow" icon={<Icon.ExclamationTriangleFill size="1rem" />}>
                            Some helpers failed to load. Loaded helpers remain available below.
                        </Alert>}

                    {showServerStatusPanel &&
                        <Paper p="sm" withBorder>
                            <Stack spacing="xs">
                                <Text weight={600}>Downloader usage status</Text>
                                {serverStatuses.map((state) => (
                                    <Paper key={state.serverName} p="xs" withBorder>
                                        <Group position="apart" align="flex-start" noWrap>
                                            <Stack spacing={2} sx={{ flexGrow: 1, minWidth: 0 }}>
                                                <Group spacing="xs">
                                                    <Text weight={600}>{state.serverName}</Text>
                                                    <Badge color={serverStatusColor(state.status)} variant="light">
                                                        {state.status}
                                                    </Badge>
                                                    {state.status === "loaded" &&
                                                        <Badge color="gray" variant="light">
                                                            {`${state.torrentCount ?? 0} torrents`}
                                                        </Badge>}
                                                </Group>
                                                {state.status === "error" &&
                                                    <Text size="xs" color="dimmed">
                                                        {state.error}
                                                    </Text>}
                                            </Stack>
                                            {state.status === "error" &&
                                                <Button compact variant="light" onClick={() => { retryServerUsage(state.serverName); }}>
                                                    Retry
                                                </Button>}
                                        </Group>
                                    </Paper>
                                ))}
                            </Stack>
                        </Paper>}

                    <Divider />

                    <ScrollArea.Autosize mah="32rem">
                        <Stack spacing="sm">
                            {!initialLoading && !notConfigured && groupedSymlinks.length === 0 &&
                                <Text color="dimmed">
                                    {invalidOnly
                                        ? "No invalid symlinks found across configured helpers."
                                        : failedHelperCount === helperSources.length
                                            ? "No symlink results available because every helper scan failed."
                                            : "No symlinks found under configured helper roots."}
                                </Text>}
                            {groupedSymlinks.map((group) => (
                                <Paper key={group.helper.key} p="sm" withBorder>
                                    <Stack spacing="sm">
                                        <Group position="apart" align="flex-start" noWrap>
                                            <Stack spacing={4} sx={{ flexGrow: 1, minWidth: 0 }}>
                                                <Group spacing="xs">
                                                    <Text weight={700}>{group.helper.label}</Text>
                                                    <Badge color={helperStatusColor(group.helperState.status)} variant="light">
                                                        {group.helperState.status}
                                                    </Badge>
                                                    <Badge color="gray" variant="light">
                                                        {`${group.entries.length} shown`}
                                                    </Badge>
                                                    <Badge color="gray" variant="light">
                                                        {`${group.helper.serverNames.length} downloader${group.helper.serverNames.length === 1 ? "" : "s"}`}
                                                    </Badge>
                                                </Group>
                                                <Text size="xs" color="dimmed" sx={{ wordBreak: "break-all" }}>
                                                    {group.helper.url}
                                                </Text>
                                                <Text size="xs" color="dimmed">
                                                    {`Configured on: ${group.helper.serverNames.join(", ")}`}
                                                </Text>
                                            </Stack>
                                            <Button
                                                compact
                                                variant="light"
                                                onClick={() => { retryHelperScan(group.helper.key); }}
                                                loading={group.helperState.status === "loading"}
                                                disabled={deletingBroken || deletingPath !== undefined}
                                            >
                                                Rescan helper
                                            </Button>
                                        </Group>

                                        {group.entries.map((item) => (
                                            <Paper key={symlinkIdentity(item)} p="sm" withBorder>
                                                <Group position="apart" align="flex-start" noWrap>
                                                    <Stack spacing={4} sx={{ flexGrow: 1, minWidth: 0 }}>
                                                        <Group spacing="xs">
                                                            <Text weight={600}>{item.name}</Text>
                                                            <Badge
                                                                color={
                                                                    item.effectiveStatus === "broken"
                                                                        ? "red"
                                                                        : item.effectiveStatus === "unused"
                                                                            ? "yellow"
                                                                            : item.effectiveStatus === "checking"
                                                                                ? "blue"
                                                                                : item.effectiveStatus === "degraded"
                                                                                    ? "orange"
                                                                                    : "green"
                                                                }
                                                                variant="light">
                                                                {item.effectiveStatus}
                                                            </Badge>
                                                            <Badge variant="light">{item.targetKind}</Badge>
                                                            <Badge color={item.status === "broken" ? "red" : "teal"} variant="light">
                                                                {item.status === "broken" ? "source missing" : "source ok"}
                                                            </Badge>
                                                            <Badge
                                                                color={
                                                                    item.effectiveStatus === "checking"
                                                                        ? "blue"
                                                                        : item.effectiveStatus === "degraded"
                                                                            ? "orange"
                                                                            : item.usedByTorrents.length > 0 ? "blue" : "yellow"
                                                                }
                                                                variant="light">
                                                                {item.effectiveStatus === "checking"
                                                                    ? "checking downloaders"
                                                                    : item.effectiveStatus === "degraded"
                                                                        ? "server data incomplete"
                                                                        : item.usedByTorrents.length > 0 ? "used by Transmission" : "not in Transmission"}
                                                            </Badge>
                                                        </Group>
                                                        <Text size="sm" color="dimmed">Symlink path</Text>
                                                        <Text size="sm" sx={{ fontFamily: "monospace", wordBreak: "break-all" }}>
                                                            {item.path}
                                                        </Text>
                                                        <Text size="sm" color="dimmed">Target path</Text>
                                                        <Text size="sm" sx={{ fontFamily: "monospace", wordBreak: "break-all" }}>
                                                            {item.targetPath}
                                                        </Text>
                                                        <Text size="xs" color="dimmed">
                                                            {`Raw target: ${item.rawTarget}`}
                                                        </Text>
                                                        <Text size="xs" color="dimmed">
                                                            {`Root: ${item.root}`}
                                                        </Text>
                                                        <Text size="xs" color="dimmed">
                                                            {`Helper: ${item.helperLabel} (${item.helperServerNames.join(", ")})`}
                                                        </Text>
                                                        <Text size="xs" color="dimmed">
                                                            {item.effectiveStatus === "checking"
                                                                ? "Transmission torrents: checking configured servers..."
                                                                : item.effectiveStatus === "degraded"
                                                                    ? "Transmission torrents: some servers failed to load, retry the failed servers above"
                                                                    : item.usedByTorrents.length > 0
                                                                        ? `Transmission torrents: ${item.usedByTorrents.join(", ")}`
                                                                        : "Transmission torrents: none"}
                                                        </Text>
                                                    </Stack>
                                                    <Button
                                                        color="red"
                                                        variant="light"
                                                        onClick={() => { onDelete(item); }}
                                                        loading={deletingPath === symlinkIdentity(item)}
                                                        disabled={deletingBroken || loadingHelperCount > 0}
                                                    >
                                                        Delete
                                                    </Button>
                                                </Group>
                                            </Paper>
                                        ))}
                                    </Stack>
                                </Paper>
                            ))}
                        </Stack>
                    </ScrollArea.Autosize>
                </Stack>
            </Box>
        </HkModal>
    );
}
