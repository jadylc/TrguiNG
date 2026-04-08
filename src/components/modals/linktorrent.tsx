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

import { Alert, Badge, Box, Button, Divider, Group, LoadingOverlay, Paper, ScrollArea, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { createLinkSymlink, isLinkHelperConfigured, searchLinkCandidates } from "linkhelper";
import React, { useCallback, useContext, useEffect, useMemo, useState } from "react";
import { ServerConfigContext } from "config";
import { useTorrentDetails } from "queries";
import { HkModal } from "./common";
import * as Icon from "react-bootstrap-icons";

interface LinkTorrentModalProps {
    opened: boolean,
    close: () => void,
    torrentId?: number,
}

function buildTargetPath(downloadDir: string, torrentName: string) {
    return `${downloadDir.replace(/[\\/]+$/, "")}/${torrentName}`;
}

function inferTargetKind(torrentName: string, files?: Array<{ name: string }>) {
    if (Array.isArray(files)) {
        if (files.length > 1) return "dir" as const;
        if (files.length === 1 && files[0].name === torrentName) return "file" as const;
    }
    return /\.[^/.]+$/.test(torrentName) ? "file" as const : "dir" as const;
}

export function LinkTorrentModal(props: LinkTorrentModalProps) {
    const serverConfig = useContext(ServerConfigContext);
    const { data: torrent, isLoading } = useTorrentDetails(
        props.torrentId ?? -1,
        props.opened && props.torrentId !== undefined,
        false,
        true,
    );

    const targetPath = useMemo(() => {
        if (torrent?.downloadDir === undefined || torrent.name === undefined) return "";
        return buildTargetPath(torrent.downloadDir as string, torrent.name as string);
    }, [torrent]);

    const targetKind = useMemo(
        () => inferTargetKind(torrent?.name as string ?? "", torrent?.files as Array<{ name: string }> | undefined),
        [torrent],
    );

    const [loadingCandidates, setLoadingCandidates] = useState(false);
    const [loadingCreatePath, setLoadingCreatePath] = useState<string>();
    const [error, setError] = useState<string>();
    const [candidates, setCandidates] = useState<Array<{
        path: string,
        name: string,
        kind: "file" | "dir" | "other",
        score: number,
        reason: string,
        searchRoot: string,
    }>>([]);

    const loadCandidates = useCallback(() => {
        if (props.torrentId === undefined || torrent?.downloadDir === undefined || torrent?.name === undefined) return;
        setLoadingCandidates(true);
        setError(undefined);
        void searchLinkCandidates(serverConfig, {
            torrentName: torrent.name,
            downloadDir: torrent.downloadDir,
            targetPath,
            targetKindHint: targetKind,
        }).then((response) => {
            setCandidates(response.candidates);
        }).catch((e: Error) => {
            setCandidates([]);
            setError(e.message);
        }).finally(() => {
            setLoadingCandidates(false);
        });
    }, [props.torrentId, serverConfig, targetKind, targetPath, torrent?.downloadDir, torrent?.name]);

    useEffect(() => {
        if (props.opened && torrent !== undefined && isLinkHelperConfigured(serverConfig)) {
            loadCandidates();
        }
        if (!props.opened) {
            setCandidates([]);
            setError(undefined);
            setLoadingCreatePath(undefined);
            setLoadingCandidates(false);
        }
    }, [loadCandidates, props.opened, serverConfig, torrent]);

    const onCreate = useCallback((sourcePath: string) => {
        setLoadingCreatePath(sourcePath);
        setError(undefined);
        void createLinkSymlink(serverConfig, {
            sourcePath,
            targetPath,
        }).then((response) => {
            notifications.show({
                message: response.status === "created" ? "Symlink created" : "Target already exists",
                color: response.status === "created" ? "green" : "yellow",
            });
            if (response.status === "created") {
                props.close();
            } else {
                loadCandidates();
            }
        }).catch((e: Error) => {
            setError(e.message);
        }).finally(() => {
            setLoadingCreatePath(undefined);
        });
    }, [loadCandidates, props, serverConfig, targetPath]);

    const notConfigured = !isLinkHelperConfigured(serverConfig);

    return (
        <HkModal
            opened={props.opened}
            onClose={props.close}
            title="Create symlink"
            centered
            size="xl"
        >
            <Box pos="relative" mih="24rem">
                <LoadingOverlay visible={isLoading || loadingCandidates} />
                <Stack spacing="md">
                    <Text weight={700}>{torrent?.name ?? "No torrent selected"}</Text>
                    <Text size="sm" color="dimmed">Target path</Text>
                    <Text size="sm" sx={{ fontFamily: "monospace" }}>{targetPath === "" ? "-" : targetPath}</Text>
                    <Group spacing="xs">
                        <Badge color="blue" variant="light">{targetKind}</Badge>
                        {torrent?.downloadDir !== undefined && <Badge color="gray" variant="light">{torrent.downloadDir}</Badge>}
                    </Group>

                    {notConfigured &&
                        <Alert color="yellow" icon={<Icon.ExclamationTriangleFill size="1rem" />}>
                            Link helper URL is not configured for this server.
                        </Alert>}

                    {error !== undefined &&
                        <Alert color="red" icon={<Icon.XCircleFill size="1rem" />}>
                            {error}
                        </Alert>}

                    <Group position="right">
                        <Button variant="light" onClick={loadCandidates} disabled={notConfigured || torrent === undefined}>
                            Rescan
                        </Button>
                    </Group>

                    <Divider />

                    <ScrollArea.Autosize mah="18rem">
                        <Stack spacing="sm">
                            {!loadingCandidates && !notConfigured && candidates.length === 0 &&
                                <Text color="dimmed">No similar directories or files found.</Text>}
                            {candidates.map((candidate) => (
                                <Paper key={candidate.path} p="sm" withBorder>
                                    <Group position="apart" align="flex-start" noWrap>
                                        <Stack spacing={4} sx={{ flexGrow: 1 }}>
                                            <Group spacing="xs">
                                                <Text weight={600}>{candidate.name}</Text>
                                                <Badge variant="light">{candidate.kind}</Badge>
                                                <Badge color={candidate.score >= 0.9 ? "green" : "blue"} variant="light">
                                                    {candidate.score.toFixed(2)}
                                                </Badge>
                                            </Group>
                                            <Text size="sm" sx={{ fontFamily: "monospace" }}>{candidate.path}</Text>
                                            <Text size="xs" color="dimmed">{candidate.reason}</Text>
                                        </Stack>
                                        <Button
                                            onClick={() => { onCreate(candidate.path); }}
                                            loading={loadingCreatePath === candidate.path}
                                        >
                                            Create symlink
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
