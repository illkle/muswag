import { clonePlaybackItem, type PlaybackItem } from "#core";

import type { ApplyMpvQueueInput } from "#shared/player";
import type { MpvClient } from "./mpv-client";

export type MirroredEntry = PlaybackItem & { playlistEntryId: number };

export class MpvQueueMirror {
  private entries: MirroredEntry[] = [];
  private byId = new Map<number, MirroredEntry>();
  private currentEntryId: number | null = null;
  private desired: readonly PlaybackItem[] = [];

  constructor(private readonly options: { client: MpvClient; resolveUrl: (trackId: string) => string }) {}

  async apply(input: ApplyMpvQueueInput): Promise<void> {
    validateInput(input);
    const desired = input.snapshot.items.map(clonePlaybackItem);
    const selected = input.select;
    const selectedExisting = selected ? this.entries.find(({ key }) => key === selected.key) : null;
    const current = this.currentEntry;

    if (selected && (!selectedExisting || !current || !desired.some(({ key }) => key === current.key))) {
      await this.replaceAroundSelection(desired, selected.key);
    } else {
      await this.reconcile(desired);
      if (selected) {
        const index = this.entries.findIndex(({ key }) => key === selected.key);
        if (index < 0) throw new Error(`Selected occurrence ${selected.key} is not mirrored.`);
        await this.options.client.playPlaylistIndex(index);
      }
    }
    this.desired = desired;
  }

  entryForId(playlistEntryId: number): MirroredEntry | null {
    const entry = this.byId.get(playlistEntryId);
    return entry ? toMirroredEntry(entry, entry.playlistEntryId) : null;
  }

  setCurrentEntryId(playlistEntryId: number): boolean {
    if (!this.byId.has(playlistEntryId)) return false;
    this.currentEntryId = playlistEntryId;
    return true;
  }

  get currentEntry(): MirroredEntry | null {
    return this.currentEntryId === null ? null : this.entryForId(this.currentEntryId);
  }

  get snapshot(): readonly PlaybackItem[] {
    return this.desired.map(clonePlaybackItem);
  }

  hasSuccessor(playlistEntryId: number): boolean {
    const index = this.entries.findIndex((entry) => entry.playlistEntryId === playlistEntryId);
    return index >= 0 && index < this.entries.length - 1;
  }

  async restartCurrent(): Promise<void> {
    const index = this.entries.findIndex(({ playlistEntryId }) => playlistEntryId === this.currentEntryId);
    if (index >= 0) await this.options.client.playPlaylistIndex(index);
  }

  async rebuildUrls(): Promise<void> {
    if (this.desired.length === 0) return;
    await this.fullRebuild(this.desired);
  }

  async reloadCurrent(): Promise<void> {
    const current = this.currentEntry;
    if (!current) return;
    await this.replaceAroundSelection(this.desired, current.key);
  }

  async clear(): Promise<void> {
    try {
      await this.options.client.clearPlaylistExceptCurrent();
    } finally {
      this.reset();
    }
  }

  private reset(): void {
    this.entries = [];
    this.byId.clear();
    this.currentEntryId = null;
    this.desired = [];
  }

  private async reconcile(desired: readonly PlaybackItem[]): Promise<void> {
    const current = this.currentEntry;
    if (current && !desired.some(({ key }) => key === current.key)) {
      throw new Error(`Desired mpv queue removed the current occurrence ${current.key}.`);
    }
    if (sameKeys(this.entries, desired)) {
      this.commitMap(rebind(desired, this.entries));
      return;
    }
    if (await this.trySingleReplacement(desired)) return;
    await this.fullRebuild(desired);
  }

  private async trySingleReplacement(desired: readonly PlaybackItem[]): Promise<boolean> {
    if (this.entries.length !== desired.length || this.currentEntryId === null) return false;
    const oldKeys = this.entries.map(({ key }) => key);
    const desiredKeys = desired.map(({ key }) => key);
    const removed = oldKeys.filter((key) => !desiredKeys.includes(key));
    const added = desiredKeys.filter((key) => !oldKeys.includes(key));
    if (removed.length !== 1 || added.length !== 1) return false;
    const removeIndex = oldKeys.indexOf(removed[0]!);
    if (this.entries[removeIndex]?.playlistEntryId === this.currentEntryId) return false;
    const insertIndex = desiredKeys.indexOf(added[0]!);
    const simulated = [...oldKeys];
    simulated.splice(removeIndex, 1);
    simulated.splice(insertIndex, 0, added[0]!);
    if (!simulated.every((key, index) => key === desiredKeys[index])) return false;

    try {
      await this.options.client.removePlaylistEntry(removeIndex);
      const item = desired[insertIndex]!;
      const playlistEntryId = await this.options.client.insertFile(this.options.resolveUrl(item.track.id), insertIndex);
      const retained = this.entries.filter((_, index) => index !== removeIndex);
      retained.splice(insertIndex, 0, toMirroredEntry(item, playlistEntryId));
      this.commitMap(rebind(desired, retained));
      return true;
    } catch {
      // An incremental map is never committed. Rebuild once around the verified current id.
      await this.fullRebuild(desired);
      return true;
    }
  }

  private async fullRebuild(desired: readonly PlaybackItem[]): Promise<void> {
    const current = this.currentEntry;
    if (!current) {
      if (desired.length === 0) {
        await this.options.client.clearPlaylistExceptCurrent();
        this.commitMap([]);
        return;
      }
      throw new Error("Cannot reconcile a non-empty mpv queue without a current entry or explicit selection.");
    }
    await this.options.client.clearPlaylistExceptCurrent();
    try {
      const currentIndex = desired.findIndex(({ key }) => key === current.key);
      this.commitMap(await this.insertAround(desired, currentIndex, current.playlistEntryId));
    } catch (cause) {
      try {
        await this.options.client.clearPlaylistExceptCurrent();
        this.commitMap([toMirroredEntry(current, current.playlistEntryId)]);
      } catch {
        // mpv may still contain partial inserts, so no entry correlation is safe.
        this.reset();
      }
      throw cause;
    }
  }

  private async replaceAroundSelection(desired: readonly PlaybackItem[], selectedKey: string): Promise<void> {
    const selectedIndex = desired.findIndex(({ key }) => key === selectedKey);
    if (selectedIndex < 0) throw new Error(`Selected occurrence ${selectedKey} is not in the desired mpv queue.`);
    const selected = desired[selectedIndex]!;
    const selectedEntryId = await this.options.client.loadFile(this.options.resolveUrl(selected.track.id));
    try {
      this.commitMap(await this.insertAround(desired, selectedIndex, selectedEntryId));
    } catch {
      this.currentEntryId = selectedEntryId;
      this.commitMap([toMirroredEntry(selected, selectedEntryId)]);
      await this.fullRebuild(desired);
      return;
    }
    this.currentEntryId = selectedEntryId;
  }

  private async insertAround(desired: readonly PlaybackItem[], anchorIndex: number, anchorEntryId: number): Promise<MirroredEntry[]> {
    if (anchorIndex < 0) throw new Error("The mirrored anchor is not in the desired mpv queue.");
    const entries: MirroredEntry[] = [];
    for (let index = 0; index < desired.length; index += 1) {
      const item = desired[index]!;
      const entryId = index === anchorIndex ? anchorEntryId : await this.options.client.insertFile(this.options.resolveUrl(item.track.id), index);
      entries.push(toMirroredEntry(item, entryId));
    }
    return entries;
  }

  private commitMap(entries: MirroredEntry[]): void {
    const nextById = new Map(entries.map((entry) => [entry.playlistEntryId, entry]));
    this.entries = entries;
    this.byId = nextById;
    if (this.currentEntryId !== null && !this.byId.has(this.currentEntryId)) this.currentEntryId = null;
  }
}

function validateInput(input: ApplyMpvQueueInput): void {
  const keys = new Set<string>();
  for (const item of input.snapshot.items) {
    if (!item.key || keys.has(item.key)) throw new Error(`Duplicate or empty playback occurrence key: ${item.key}`);
    keys.add(item.key);
  }
  if (input.select && !keys.has(input.select.key)) throw new Error(`Selected occurrence ${input.select.key} is not in the desired mpv queue.`);
}

function sameKeys(entries: readonly PlaybackItem[], desired: readonly PlaybackItem[]): boolean {
  return entries.length === desired.length && entries.every(({ key }, index) => desired[index]?.key === key);
}

function toMirroredEntry(item: PlaybackItem, playlistEntryId: number): MirroredEntry {
  return { ...clonePlaybackItem(item), playlistEntryId };
}

/** Keeps the mpv entry ids already in place while adopting the desired queue's track data. */
function rebind(desired: readonly PlaybackItem[], entries: readonly MirroredEntry[]): MirroredEntry[] {
  return entries.map((entry, index) => toMirroredEntry(desired[index]!, entry.playlistEntryId));
}
