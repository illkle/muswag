import type { PlaylistEntry, PlaylistRecord, PlaylistState, RemotePlaylist, RemotePlaylistMutation } from "./types.js";

export interface MergePlaylistsResult {
  local: PlaylistRecord[];
  remote: RemotePlaylistMutation[];
}

function sameArray<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function entryIds(entries: readonly PlaylistEntry[]): string[] {
  return entries.map(({ id }) => id);
}

function sameEntries(left: readonly PlaylistEntry[], right: readonly PlaylistEntry[]): boolean {
  return (
    left.length === right.length && left.every((entry, index) => entry.id === right[index]?.id && entry.songId === right[index]?.songId)
  );
}

function sameRemoteEntries(left: readonly PlaylistEntry[], right: readonly PlaylistEntry[]): boolean {
  return sameArray(
    left.map(({ songId }) => songId),
    right.map(({ songId }) => songId),
  );
}

function sameEditableState(left: PlaylistState, right: PlaylistState): boolean {
  return (
    left.name === right.name &&
    left.comment === right.comment &&
    left.public === right.public &&
    sameRemoteEntries(left.entries, right.entries)
  );
}

function reconcileRemoteEntries(remote: RemotePlaylist, base: readonly PlaylistEntry[]): PlaylistEntry[] {
  const available = new Map<string, PlaylistEntry[]>();
  for (const entry of base) {
    const entries = available.get(entry.songId) ?? [];
    entries.push(entry);
    available.set(entry.songId, entries);
  }

  const usedIds = new Set(base.map(({ id }) => id));
  let generatedId = 0;

  return remote.songIds.map((songId) => {
    const existing = available.get(songId)?.shift();
    if (existing) return existing;

    let id: string;
    do {
      id = `remote:${remote.id}:${generatedId}`;
      generatedId += 1;
    } while (usedIds.has(id));
    usedIds.add(id);
    return { id, songId };
  });
}

function remoteState(remote: RemotePlaylist, base: readonly PlaylistEntry[]): PlaylistState {
  return {
    name: remote.name,
    comment: remote.comment,
    public: remote.public,
    readonly: remote.readonly,
    entries: reconcileRemoteEntries(remote, base),
    ...(remote.owner !== undefined && { owner: remote.owner }),
    ...(remote.created !== undefined && { created: remote.created }),
    ...(remote.changed !== undefined && { changed: remote.changed }),
    ...(remote.duration !== undefined && { duration: remote.duration }),
    ...(remote.coverArt !== undefined && { coverArt: remote.coverArt }),
    ...(remote.allowedUser !== undefined && { allowedUser: remote.allowedUser }),
    ...(remote.validUntil !== undefined && { validUntil: remote.validUntil }),
  };
}

function additionsByAnchor(
  entries: readonly PlaylistEntry[],
  baseIds: ReadonlySet<string>,
  survivingIds: ReadonlySet<string>,
): Map<string | null, PlaylistEntry[]> {
  const additions = new Map<string | null, PlaylistEntry[]>();
  let anchor: string | null = null;

  for (const entry of entries) {
    if (survivingIds.has(entry.id)) {
      anchor = entry.id;
      continue;
    }
    if (baseIds.has(entry.id)) continue;

    const anchored = additions.get(anchor) ?? [];
    anchored.push(entry);
    additions.set(anchor, anchored);
  }

  return additions;
}

function mergeEntries(base: readonly PlaylistEntry[], local: readonly PlaylistEntry[], remote: readonly PlaylistEntry[]): PlaylistEntry[] {
  if (sameEntries(local, base)) return [...remote];
  if (sameEntries(remote, base)) return [...local];

  const baseIds = new Set(entryIds(base));
  const localIds = new Set(entryIds(local));
  const remoteIds = new Set(entryIds(remote));
  const survivingIds = new Set([...baseIds].filter((id) => localIds.has(id) && remoteIds.has(id)));

  const baseOrder = entryIds(base).filter((id) => survivingIds.has(id));
  const localOrder = entryIds(local).filter((id) => survivingIds.has(id));
  const remoteOrder = entryIds(remote).filter((id) => survivingIds.has(id));
  const coreOrder = sameArray(localOrder, baseOrder) ? remoteOrder : localOrder;

  const localById = new Map(local.map((entry) => [entry.id, entry]));
  const remoteById = new Map(remote.map((entry) => [entry.id, entry]));
  const remoteAdditions = additionsByAnchor(remote, baseIds, survivingIds);
  const localAdditions = additionsByAnchor(local, baseIds, survivingIds);
  const result: PlaylistEntry[] = [];

  const appendAdditions = (anchor: string | null) => {
    result.push(...(remoteAdditions.get(anchor) ?? []));
    result.push(...(localAdditions.get(anchor) ?? []));
  };

  appendAdditions(null);
  for (const id of coreOrder) {
    const entry = localById.get(id) ?? remoteById.get(id);
    if (entry) result.push(entry);
    appendAdditions(id);
  }

  return result;
}

function mergeState(base: PlaylistState, local: PlaylistState, remote: PlaylistState): PlaylistState {
  if (remote.readonly) return remote;

  return {
    ...remote,
    name: local.name === base.name ? remote.name : local.name,
    comment: local.comment === base.comment ? remote.comment : local.comment,
    public: local.public === base.public ? remote.public : local.public,
    entries: mergeEntries(base.entries, local.entries, remote.entries),
  };
}

function remoteLocalId(remoteId: string, usedIds: ReadonlySet<string>): string {
  if (!usedIds.has(remoteId)) return remoteId;

  let id = `remote:${remoteId}`;
  while (usedIds.has(id)) {
    id = `remote:${id}`;
  }
  return id;
}

export function mergePlaylists(local: readonly PlaylistRecord[], remote: readonly RemotePlaylist[]): MergePlaylistsResult {
  const remoteById = new Map(remote.map((playlist) => [playlist.id, playlist]));
  const usedRemoteIds = new Set<string>();
  const usedLocalIds = new Set(local.map(({ id }) => id));
  const nextLocal: PlaylistRecord[] = [];
  const remoteMutations: RemotePlaylistMutation[] = [];

  for (const playlist of [...local].sort((left, right) => left.id.localeCompare(right.id))) {
    if (playlist.serverId === null) {
      if (playlist.local) {
        nextLocal.push(playlist);
        remoteMutations.push({ type: "create", localId: playlist.id, state: playlist.local });
      }
      continue;
    }

    const currentRemote = remoteById.get(playlist.serverId);
    if (!currentRemote) {
      if (playlist.local && playlist.base && !sameEditableState(playlist.local, playlist.base)) {
        const recreated = { ...playlist, serverId: null, base: null };
        nextLocal.push(recreated);
        remoteMutations.push({ type: "create", localId: playlist.id, state: playlist.local });
      }
      continue;
    }

    usedRemoteIds.add(currentRemote.id);
    const remoteSnapshot = remoteState(currentRemote, playlist.base?.entries ?? []);

    if (playlist.local === null) {
      nextLocal.push(playlist);
      remoteMutations.push({ type: "delete", localId: playlist.id, serverId: currentRemote.id });
      continue;
    }

    const merged = mergeState(playlist.base ?? remoteSnapshot, playlist.local, remoteSnapshot);
    if (sameEditableState(merged, remoteSnapshot)) {
      nextLocal.push({ ...playlist, serverId: currentRemote.id, base: remoteSnapshot, local: remoteSnapshot });
      continue;
    }

    nextLocal.push({ ...playlist, serverId: currentRemote.id, base: remoteSnapshot, local: merged });
    remoteMutations.push({
      type: "replace",
      localId: playlist.id,
      serverId: currentRemote.id,
      previousSongCount: currentRemote.songIds.length,
      state: merged,
    });
  }

  for (const playlist of [...remote].sort((left, right) => left.id.localeCompare(right.id))) {
    if (usedRemoteIds.has(playlist.id)) continue;

    const id = remoteLocalId(playlist.id, usedLocalIds);
    usedLocalIds.add(id);
    const state = remoteState(playlist, []);
    nextLocal.push({ id, serverId: playlist.id, base: state, local: state, revision: 0 });
  }

  nextLocal.sort((left, right) => left.id.localeCompare(right.id));
  return { local: nextLocal, remote: remoteMutations };
}
