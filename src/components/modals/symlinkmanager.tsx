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
import { deleteLinkSymlink, isLinkHelperConfigured, listLinkSymlinks } from "linkhelper";
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

interface SymlinkViewEntry extends SymlinkEntry {
    effectiveStatus: EffectiveSymlinkStatus,
    usedByTorrents: string[],
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

function normalizeComparePath(path: string) {
    return path.replace(/\\/g, "/").replace(/\/+$/, "");
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

export function SymlinkManagerModal(props: SymlinkManagerModalProps) {
    const config = useContext(ConfigContext);
    const serverConfig = useContext(ServerConfigContext);
    const [loading, setLoading] = useState(false);
    const [deletingPath, setDeletingPath] = useState<string>();
    const [deletingBroken, setDeletingBroken] = useState(false);
    const [error, setError] = useState<string>();
    const [invalidOnly, setInvalidOnly] = useState(false);
    const [symlinks, setSymlinks] = useState<SymlinkEntry[]>([]);
    const [serverUsageStates, setServerUsageStates] = useState<Map<string, ServerUsageState>>(new Map());

    const usageServers = config.getServers().length > 0 ? config.getServers() : [serverConfig];

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

    const loadAll = useCallback(() => {
        if (!isLinkHelperConfigured(serverConfig)) return;
        setLoading(true);
        setError(undefined);
        void listLinkSymlinks(serverConfig).then((response) => {
            setSymlinks(response.symlinks);
        }).catch((e: Error) => {
            setSymlinks([]);
            setError(e.message);
        }).finally(() => {
            setLoading(false);
        });
        reloadDownloaderUsage();
    }, [reloadDownloaderUsage, serverConfig]);

    useEffect(() => {
        if (props.opened) {
            loadAll();
        } else {
            setLoading(false);
            setDeletingPath(undefined);
            setDeletingBroken(false);
            setError(undefined);
            setServerUsageStates(new Map());
        }
    }, [loadAll, props.opened]);

    const onDelete = useCallback((path: string) => {
        setDeletingPath(path);
        setError(undefined);
        void deleteLinkSymlink(serverConfig, { path }).then(() => {
            setSymlinks((current) => current.filter((item) => item.path !== path));
            notifications.show({
                message: "Symlink deleted",
                color: "green",
            });
        }).catch((e: Error) => {
            setError(e.message);
        }).finally(() => {
            setDeletingPath(undefined);
        });
    }, [serverConfig]);

    const onDeleteBroken = useCallback(() => {
        const brokenPaths = symlinks.filter((item) => item.status === "broken").map((item) => item.path);
        if (brokenPaths.length === 0) return;

        setDeletingBroken(true);
        setError(undefined);
        void (async () => {
            const deletedPaths: string[] = [];
            try {
                for (const path of brokenPaths) {
                    await deleteLinkSymlink(serverConfig, { path });
                    deletedPaths.push(path);
                }

                setSymlinks((current) => current.filter((item) => !deletedPaths.includes(item.path)));
                notifications.show({
                    message: `Deleted ${deletedPaths.length} broken symlink${deletedPaths.length === 1 ? "" : "s"}`,
                    color: "green",
                });
            } catch (e) {
                setError((e as Error).message);
                if (deletedPaths.length > 0) {
                    setSymlinks((current) => current.filter((item) => !deletedPaths.includes(item.path)));
                }
            } finally {
                setDeletingBroken(false);
            }
        })();
    }, [serverConfig, symlinks]);

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

    const loadingServerCount = useMemo(
        () => serverStatuses.filter((state) => state.status === "loading").length,
        [serverStatuses],
    );
    const failedServerCount = useMemo(
        () => serverStatuses.filter((state) => state.status === "error").length,
        [serverStatuses],
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

    const filteredSymlinks = useMemo(
        () => invalidOnly
            ? enrichedSymlinks.filter((item) =>
                item.effectiveStatus === "broken" ||
                item.effectiveStatus === "unused" ||
                item.effectiveStatus === "degraded")
            : enrichedSymlinks,
        [enrichedSymlinks, invalidOnly],
    );

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
    const showServerStatusPanel = usageServers.length > 1 || loadingServerCount > 0 || failedServerCount > 0;
    const notConfigured = !isLinkHelperConfigured(serverConfig);

    const retryServerUsage = useCallback((serverName: string) => {
        const target = usageServers.find((server) => server.name === serverName);
        if (target === undefined) return;
        void loadUsageForServer(target);
    }, [loadUsageForServer, usageServers]);

    return (
        <HkModal
            opened={props.opened}
            onClose={props.close}
            title="Symlink manager"
            centered
            size="92rem"
        >
            <Box pos="relative" mih="30rem">
                <LoadingOverlay visible={loading} />
                <Stack spacing="md">
                    <Group position="apart" align="flex-end">
                        <Stack spacing={4}>
                            <Text weight={700}>Manage symlinks inside configured helper roots</Text>
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
                                disabled={notConfigured || deletingBroken}
                            >
                                Reload downloaders
                            </Button>
                            <Button variant="light" onClick={loadAll} disabled={notConfigured || deletingBroken}>
                                Rescan
                            </Button>
                            <Button
                                color="red"
                                variant="light"
                                onClick={onDeleteBroken}
                                loading={deletingBroken}
                                disabled={notConfigured || brokenCount === 0 || deletingPath !== undefined}
                            >
                                Delete broken
                            </Button>
                        </Group>
                    </Group>

                    {notConfigured &&
                        <Alert color="yellow" icon={<Icon.ExclamationTriangleFill size="1rem" />}>
                            Link helper URL is not configured for this server.
                        </Alert>}

                    {error !== undefined &&
                        <Alert color="red" icon={<Icon.XCircleFill size="1rem" />}>
                            {error}
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
                            {!loading && !notConfigured && filteredSymlinks.length === 0 &&
                                <Text color="dimmed">
                                    {invalidOnly ? "No invalid symlinks found." : "No symlinks found under configured roots."}
                                </Text>}
                            {filteredSymlinks.map((item) => (
                                <Paper key={item.path} p="sm" withBorder>
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
                                            onClick={() => { onDelete(item.path); }}
                                            loading={deletingPath === item.path}
                                            disabled={deletingBroken}
                                        >
                                            Delete
                                        </Button>
                                    </Group>
                                </Paper>
                            ))}
                        </Stack>
                    </ScrollArea.Autosize>
                </Stack>
            </Box>
        </HkModal>
    );
}
