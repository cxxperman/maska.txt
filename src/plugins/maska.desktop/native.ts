/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { app, BrowserWindow, IpcMainInvokeEvent, NativeImage, nativeImage } from "electron";
import { writeFileSync } from "fs";
import { join } from "path";

import { connectHub, HubMessage } from "./hub";
import { MASKA_ICO } from "./icon";

// The hub link lives here, in Discord's main process: Discord's pages may not open connections to this computer
// themselves. The plugin (renderer) says things through start/state/result and hears things through wait.

const HOLD_MS = 25000;
const MAX_WAITING = 100;

let hub: ReturnType<typeof connectHub> | undefined;
let inbox: HubMessage[] = [];
let waiter: ((messages: HubMessage[]) => void) | undefined;
let waiterTimer: ReturnType<typeof setTimeout> | undefined;
let commandId = 0;
// commands of ours waiting for their result: id -> resolve
const asked = new Map<string, (result: CommandResult) => void>();
let icon: NativeImage | undefined;
let iconOn = false;

function release(messages: HubMessage[]) {
    const resolve = waiter;
    if (!resolve) return;
    waiter = undefined;
    clearTimeout(waiterTimer);
    resolve(messages);
}

export interface CommandResult {
    ok: boolean;
    data: unknown;
    error?: string;
}

// The result of one of our own commands goes back to its caller, never into the inbox
function deliver(message: HubMessage) {
    const resolve = message.type === "result" ? asked.get(message.id) : undefined;
    if (!resolve) return push(message);
    asked.delete(message.id);
    resolve({ ok: message.ok === true, data: message.data ?? null, error: message.error });
}

function push(message: HubMessage) {
    if (inbox.length >= MAX_WAITING) inbox.shift();
    inbox.push(message);
    if (waiter) release(takeInbox());
}

function takeInbox() {
    const messages = inbox;
    inbox = [];
    return messages;
}

export function start(_: IpcMainInvokeEvent, version: string, commands: string[], topics: string[]) {
    hub?.stop();
    inbox = [];
    // The link replaced here may still report its close afterwards (a reload of the page starts a new link without
    // stopping the old one first): what it says no longer counts, or its "nobody connected" would wipe what the new
    // link has just brought, the track among it
    const link = connectHub({
        app: "maska",
        name: "Maska",
        version: String(version),
        commands: commands.map(String),
        topics: topics.map(String),
        onMessage(message) {
            if (hub === link) deliver(message);
        },
        // without the hub nobody is connected: the plugin hears it as an empty hub.apps
        onStatus(online) {
            if (hub === link && !online) push({ type: "state", topic: "hub.apps", data: null });
        }
    });
    hub = link;
}

export function stop(_: IpcMainInvokeEvent) {
    hub?.stop();
    hub = undefined;
    inbox = [];
    release([]);
}

export function state(_: IpcMainInvokeEvent, topic: string, data: unknown) {
    if (typeof topic === "string" && topic.startsWith("maska.")) hub?.state(topic, data);
}

export function result(_: IpcMainInvokeEvent, id: unknown, to: string, ok: boolean, data: unknown, error?: string) {
    hub?.send({ type: "result", id, to, ok: ok === true, data: data ?? null, error });
}

// A command to another dev.txt app; resolves with its result, or with "timeout" when none comes in time
export function request(_: IpcMainInvokeEvent, to: string, name: string, args: unknown, timeout = 5000): Promise<CommandResult> {
    const link = hub;
    if (!link?.online) return Promise.resolve({ ok: false, data: null, error: "timeout" });
    const id = `maska-${++commandId}`;
    return new Promise(resolve => {
        const timer = setTimeout(() => {
            asked.delete(id);
            resolve({ ok: false, data: null, error: "timeout" });
        }, Math.min(Number(timeout) || 5000, 60000));
        asked.set(id, result => {
            clearTimeout(timer);
            resolve(result);
        });
        link.send({ type: "command", id, to: String(to), name: String(name), args: args ?? {} });
    });
}

// Discord's window forward, out of the taskbar if it was minimised (the show command)
export function focusWindow(e: IpcMainInvokeEvent) {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
}

// The cover for the Discord activity, from the open iTunes search, then Deezer's: artist, title (and album) go
// there, nothing else. The best of 25 results: same title and same artist are a must (no cover rather than someone else's), the
// album when kapsula.txt names it, else the album version over a single, then the nearest length.
// One lookup per track, 5 seconds at most; null when there is none
const covers = new Map<string, Found>();

// lower case, without "(feat. …)", "[2011 Remaster]", " - Live" and the like, without punctuation
function normal(s: string) {
    return s.toLowerCase()
        .replace(/[([][^)\]]*\b(feat|ft|featuring|with|remaster|remastered|remix|live|version|edit|mix|mono|stereo)\b[^)\]]*[)\]]/g, " ")
        .replace(/\s[-–—]\s.*\b(remaster|remastered|remix|live|version|edit|mono|stereo)\b.*$/g, " ")
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim();
}

// the first artist of "A feat. B", "A & B", "A, B", "A x B"
function mainArtist(artist: string) {
    return artist.split(/\s+(?:feat\.?|ft\.?|featuring|with|x)\s+|\s*[,&]\s*/i)[0]?.trim() || artist;
}

interface Song {
    trackName?: string;
    artistName?: string;
    collectionName?: string;
    collectionArtistName?: string;
    trackTimeMillis?: number;
    artworkUrl100?: string;
    trackViewUrl?: string;
}

// What the search found for a track: its cover for the Discord status and its page in Apple Music (or on Deezer)
interface Found {
    art: string | null;
    link: string | null;
}

function pick(results: Song[], artist: string, title: string, album: string, duration: number) {
    const wantTitle = normal(title);
    const wantArtist = normal(mainArtist(artist));
    const wantAlbum = normal(album);
    let best: { song: Song; score: number; off: number; } | null = null;
    for (const song of results) {
        if (!song?.artworkUrl100 || normal(song.trackName ?? "") !== wantTitle) continue;
        if (!wantArtist || !normal(song.artistName ?? "").includes(wantArtist)) continue;
        const collection = normal(song.collectionName ?? "");
        let score = 0;
        if (wantAlbum) {
            if (collection === wantAlbum) score += 100;
            else if (collection.includes(wantAlbum) || wantAlbum.includes(collection)) score += 50;
        } else {
            if (!/\b(single|ep)\b/.test(collection)) score += 20;
            if (/various artists/i.test(song.collectionArtistName ?? "")) score -= 10;
        }
        const off = duration && song.trackTimeMillis ? Math.abs(song.trackTimeMillis / 1000 - duration) : 0;
        if (!best || score > best.score || (score === best.score && off < best.off)) best = { song, score, off };
    }
    return best?.song ?? null;
}

async function lookUp(artist: string, title: string, album?: string, duration?: number): Promise<Found | null> {
    artist = String(artist ?? "").trim();
    title = String(title ?? "").trim();
    album = String(album ?? "").trim();
    if (!artist || !title) return null;
    const key = `${artist}\n${title}\n${album}`;
    if (covers.has(key)) return covers.get(key)!;
    const found: Found = { art: null, link: null };
    const term = encodeURIComponent(`${mainArtist(artist)} ${title}`);
    const length = Number(duration) || 0;
    let failed = false;
    try {
        const res = await fetch(`https://itunes.apple.com/search?term=${term}&entity=song&limit=25`, { signal: AbortSignal.timeout(5000) });
        const song = pick((await res.json())?.results ?? [], artist, title, album, length);
        if (song?.artworkUrl100?.startsWith("https://")) found.art = song.artworkUrl100.replace("100x100", "512x512");
        // the address without the tracking parameters iTunes adds
        if (song?.trackViewUrl?.startsWith("https://")) found.link = song.trackViewUrl.replace(/[?&]uo=\d+/, "");
    } catch {
        failed = true;
    }
    // iTunes knows only what the store sells: much that streams, and many artists who sing in Russian, are missing.
    // Deezer's open search (no key either) is the second place to look
    if (!found.art) {
        try {
            const res = await fetch(`https://api.deezer.com/search?q=${term}&limit=25`, { signal: AbortSignal.timeout(5000) });
            const songs: Song[] = ((await res.json())?.data ?? []).map((d: any) => ({
                trackName: d?.title,
                artistName: d?.artist?.name,
                collectionName: d?.album?.title,
                trackTimeMillis: typeof d?.duration === "number" ? d.duration * 1000 : undefined,
                artworkUrl100: d?.album?.cover_xl,
                trackViewUrl: d?.link
            }));
            const song = pick(songs, artist, title, album, length);
            if (song?.artworkUrl100?.startsWith("https://")) found.art = song.artworkUrl100;
            if (!found.link && song?.trackViewUrl?.startsWith("https://")) found.link = song.trackViewUrl;
            failed = false;
        } catch { }
    }
    // offline or slow: try again with the next track, not this one
    if (failed && !found.art) return null;
    if (covers.size > 200) covers.clear();
    covers.set(key, found);
    return found;
}

export async function artwork(_: IpcMainInvokeEvent, artist: string, title: string, album?: string, duration?: number): Promise<string | null> {
    return (await lookUp(artist, title, album, duration))?.art ?? null;
}

// The track's page in Apple Music, for "paste into chat"; null when the catalogue does not have it
export async function trackLink(_: IpcMainInvokeEvent, artist: string, title: string, album?: string, duration?: number): Promise<string | null> {
    return (await lookUp(artist, title, album, duration))?.link ?? null;
}

// Windows reads an .ico only from a file; the png inside it is the fallback
function maskaIcon() {
    if (icon) return icon;
    const data = Buffer.from(MASKA_ICO, "base64");
    try {
        const file = join(app.getPath("userData"), "maska.ico");
        writeFileSync(file, data);
        icon = nativeImage.createFromPath(file);
    } catch { }
    if (!icon || icon.isEmpty()) {
        // the last entry of the .ico is the 256 px png
        const entry = 6 + (data.readUInt16LE(4) - 1) * 16;
        const start = data.readUInt32LE(entry + 12);
        icon = nativeImage.createFromBuffer(data.subarray(start, start + data.readUInt32LE(entry + 8)));
    }
    return icon;
}

function applyIcon(win: BrowserWindow) {
    const image = maskaIcon();
    if (!win.isDestroyed() && !image.isEmpty()) win.setIcon(image);
}

// The maska icon on Discord's windows, now and for the ones opened later. Off only takes effect after a restart
export function setIcon(_: IpcMainInvokeEvent, on: boolean) {
    iconOn = on === true;
    if (iconOn) BrowserWindow.getAllWindows().forEach(applyIcon);
}

// Resolves as soon as the hub has passed something on (a command, hub.theme), or empty after 25 seconds
export function wait(_: IpcMainInvokeEvent): Promise<HubMessage[]> {
    // a page that was reloaded never comes back for its answer: only the newest request is served
    release([]);
    if (inbox.length) return Promise.resolve(takeInbox());
    return new Promise(resolve => {
        waiter = resolve;
        waiterTimer = setTimeout(() => release([]), HOLD_MS);
    });
}

app.on("will-quit", () => hub?.stop());
app.on("browser-window-created", (_, win) => {
    if (iconOn) applyIcon(win);
});
