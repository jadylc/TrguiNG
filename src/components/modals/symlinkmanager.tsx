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
import { ServerConfigContext } from "config";
import { HkModal } from "./common";
import * as Icon from "react-bootstrap-icons";

interface SymlinkManagerModalProps {
    opened: boolean,
    close: () => void,
}

export function SymlinkManagerModal(props: SymlinkManagerModalProps) {
    const serverConfig = useContext(ServerConfigContext);
    const [loading, setLoading] = useState(false);
    const [deletingPath, setDeletingPath] = useState<string>();
    const [deletingBroken, setDeletingBroken] = useState(false);
    const [error, setError] = useState<string>();
    const [brokenOnly, setBrokenOnly] = useState(false);
    const [symlinks, setSymlinks] = useState<SymlinkEntry[]>([]);

    const loadSymlinks = useCallback(() => {
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
    }, [serverConfig]);

    useEffect(() => {
        if (props.opened) {
            loadSymlinks();
        } else {
            setLoading(false);
            setDeletingPath(undefined);
            setDeletingBroken(false);
            setError(undefined);
        }
    }, [loadSymlinks, props.opened]);

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

    const filteredSymlinks = useMemo(
        () => brokenOnly ? symlinks.filter((item) => item.status === "broken") : symlinks,
        [brokenOnly, symlinks],
    );

    const brokenCount = useMemo(
        () => symlinks.filter((item) => item.status === "broken").length,
        [symlinks],
    );
    const notConfigured = !isLinkHelperConfigured(serverConfig);

    return (
        <HkModal
            opened={props.opened}
            onClose={props.close}
            title="Symlink manager"
            centered
            size="70rem"
        >
            <Box pos="relative" mih="30rem">
                <LoadingOverlay visible={loading} />
                <Stack spacing="md">
                    <Group position="apart" align="flex-end">
                        <Stack spacing={4}>
                            <Text weight={700}>Manage symlinks inside configured helper roots</Text>
                            <Group spacing="xs">
                                <Badge color="gray" variant="light">{`${symlinks.length} total`}</Badge>
                                <Badge color="green" variant="light">{`${symlinks.length - brokenCount} ok`}</Badge>
                                <Badge color="red" variant="light">{`${brokenCount} broken`}</Badge>
                            </Group>
                        </Stack>
                        <Group spacing="sm">
                            <Switch
                                checked={brokenOnly}
                                onChange={(e) => { setBrokenOnly(e.currentTarget.checked); }}
                                label="Broken only"
                            />
                            <Button variant="light" onClick={loadSymlinks} disabled={notConfigured || deletingBroken}>
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

                    <Divider />

                    <ScrollArea.Autosize mah="32rem">
                        <Stack spacing="sm">
                            {!loading && !notConfigured && filteredSymlinks.length === 0 &&
                                <Text color="dimmed">
                                    {brokenOnly ? "No broken symlinks found." : "No symlinks found under configured roots."}
                                </Text>}
                            {filteredSymlinks.map((item) => (
                                <Paper key={item.path} p="sm" withBorder>
                                    <Group position="apart" align="flex-start" noWrap>
                                        <Stack spacing={4} sx={{ flexGrow: 1, minWidth: 0 }}>
                                            <Group spacing="xs">
                                                <Text weight={600}>{item.name}</Text>
                                                <Badge color={item.status === "broken" ? "red" : "green"} variant="light">
                                                    {item.status}
                                                </Badge>
                                                <Badge variant="light">{item.targetKind}</Badge>
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
