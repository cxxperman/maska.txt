/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import ErrorBoundary from "@components/ErrorBoundary";
import { insertTextIntoChatInputBox } from "@utils/discord";
import { PluginNative } from "@utils/types";
import { ReactDOM, useEffect, useLayoutEffect, useRef, useState } from "@webpack/common";

import { padColor } from "./aura";
import { useApps } from "./family";
import { keepSlot } from "./slot";

const Native = VencordNative.pluginHelpers.Maska as PluginNative<typeof import("./native")>;

// kapsula.media as Maska uses it. Older kapsula.txt sends only playing, title, artist and app; cover, duration,
// position and positionAt are new and may still change their shape
export interface Media {
    playing: boolean;
    title: string;
    artist: string;
    app: string;
    album: string;
    cover: string | null;
    // the track's colour, #rrggbb, if kapsula.txt sends one
    color: string | null;
    duration: number | null;
    position: number | null;
    positionAt: number | null;
    // the player takes a position from Windows (kapsula.txt's media.seek works for it)
    canSeek: boolean;
}

// All the field names of kapsula.media, in this one place
function readMedia(raw: any): Media | null {
    if (!raw || typeof raw !== "object") return null;
    const text = (v: unknown) => typeof v === "string" ? v : "";
    const number = (v: unknown) => typeof v === "number" && isFinite(v) && v >= 0 ? v : null;
    return {
        playing: raw.playing === true,
        title: text(raw.title),
        artist: text(raw.artist),
        app: text(raw.app),
        album: text(raw.album),
        // a picture inline, ~96×96; anything else is not shown
        cover: typeof raw.cover === "string" && raw.cover.startsWith("data:image/") ? raw.cover : null,
        color: typeof raw.color === "string" && /^#[0-9a-f]{6}$/i.test(raw.color) ? raw.color : null,
        duration: number(raw.duration),
        position: number(raw.position),
        positionAt: number(raw.positionAt),
        canSeek: raw.canSeek === true
    };
}

// kapsula.lyrics: the words of the current track. Its shape may still change, so all its field names are here
export interface Lyrics {
    title: string;
    artist: string;
    // false: the lines have no times
    synced: boolean;
    lines: { t: number | null; text: string; }[];
}

function readLyrics(raw: any): Lyrics | null {
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.lines)) return null;
    const lines = raw.lines
        .filter((l: any) => l && typeof l === "object")
        .map((l: any) => ({ t: typeof l.t === "number" && isFinite(l.t) ? l.t : null, text: typeof l.text === "string" ? l.text : "" }));
    if (!lines.length) return null;
    return {
        title: typeof raw.title === "string" ? raw.title : "",
        artist: typeof raw.artist === "string" ? raw.artist : "",
        synced: raw.synced === true && lines.every((l: { t: number | null; }) => l.t != null),
        lines
    };
}

// arkada.downloads (arkada.txt README)
interface Download {
    appId?: number;
    name?: string;
    progress?: number;
    bytesPerSecond?: number;
    paused?: boolean;
}

let media: Media | null = null;
let lyrics: Lyrics | null = null;
let download: Download | null = null;
const listeners = new Set<() => void>();

export function setLinkState(topic: string, data: unknown) {
    if (topic === "kapsula.media") media = readMedia(data);
    else if (topic === "kapsula.lyrics") lyrics = readLyrics(data);
    else if (topic === "arkada.downloads") download = data && typeof data === "object" ? data as Download : null;
    else return;
    listeners.forEach(l => l());
}

// What an app that has gone said no longer holds; the hub gone, none of it does
export function resetLinks(apps: unknown) {
    const has = (name: string) => Array.isArray(apps) && apps.some(a => a?.app === name);
    if (!has("kapsula")) {
        media = null;
        lyrics = null;
    }
    if (!has("arkada")) download = null;
    listeners.forEach(l => l());
}

export function useLinks() {
    const [, update] = useState(0);
    useEffect(() => {
        const listener = () => update(n => n + 1);
        listeners.add(listener);
        // what came between the first render and this subscription would otherwise stay unseen until the next track
        listener();
        return () => void listeners.delete(listener);
    }, []);
    return { media, lyrics, download };
}

export const getMedia = () => media;

// "Title — Artist", or what there is of it
export function mediaText(m: Media | null) {
    return [m?.title, m?.artist].filter(Boolean).join(" — ");
}

// Into the message box, not sent: the track and, when Apple Music has it, a link to it (Discord shows it as a card)
export async function pasteTrack(m: Media | null) {
    const text = `🎵 ${mediaText(m)}`;
    let link: string | null = null;
    try {
        if (m?.artist && m.title) link = await Native.trackLink(m.artist, m.title, m.album ?? undefined, m.duration ?? 0);
    } catch { }
    insertTextIntoChatInputBox(link ? `${text} ${link}` : text);
}

// Process names of players, as a person calls them; a browser is a browser whichever it is
const PLAYERS: Record<string, string> = {
    cider: "Apple Music", spotify: "Spotify", applemusic: "Apple Music", itunes: "iTunes", aimp: "AIMP", foobar2000: "foobar2000",
    vlc: "VLC", yandexmusic: "Яндекс Музыка", chrome: "Браузер", msedge: "Браузер", firefox: "Браузер", zen: "Браузер",
    opera: "Браузер", brave: "Браузер", vivaldi: "Браузер", browser: "Браузер"
};

export function playerName(app: string) {
    return PLAYERS[app.toLowerCase().replace(/\.exe$/, "")] ?? app;
}

function clock(seconds: number) {
    const s = Math.floor(seconds);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// Where the track is now: counted on from positionAt while it plays, standing while paused; null without the fields
function useProgress(m: Media | null, every = 500) {
    const known = !!m?.duration && m.position != null && m.positionAt != null;
    const [now, setNow] = useState(Date.now());
    useEffect(() => {
        if (!known || !m?.playing) return;
        const timer = setInterval(() => setNow(Date.now()), every);
        return () => clearInterval(timer);
    }, [known, m?.playing, every]);
    if (!known || !m) return null;
    const moved = m.playing ? Math.max(0, now - (m.positionAt ?? now)) / 1000 : 0;
    const at = Math.min(m.duration!, (m.position ?? 0) + moved);
    return { at, duration: m.duration!, part: at / m.duration! };
}

// The colour of the track, as kapsula.txt paints its bar: the one it sends, else the cover's dominant colour,
// made readable on dark. Counted once per cover; null (the accent) without either
const trackColors = new Map<string, string>();

function hsl(r: number, g: number, b: number) {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    const d = max - min;
    const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
    let h = 0;
    if (d !== 0) {
        if (max === r) h = ((g - b) / d + 6) % 6;
        else if (max === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
    }
    return { h: h * 60, s, l };
}

// a 24×24 copy of the cover, its pixels by hue in 12 buckets weighted by saturation; greys, near black and near
// white do not count. The heaviest bucket's average, lightness at least 55 %, saturation at most 85 %
function dominant(cover: string) {
    return new Promise<string>(resolve => {
        const img = new Image();
        img.onerror = () => resolve("#d0d0d0");
        img.onload = () => {
            try {
                const canvas = document.createElement("canvas");
                canvas.width = canvas.height = 24;
                const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
                ctx.drawImage(img, 0, 0, 24, 24);
                const px = ctx.getImageData(0, 0, 24, 24).data;
                const buckets = Array.from({ length: 12 }, () => ({ w: 0, r: 0, g: 0, b: 0 }));
                for (let i = 0; i < px.length; i += 4) {
                    const [r, g, b] = [px[i] / 255, px[i + 1] / 255, px[i + 2] / 255];
                    const c = hsl(r, g, b);
                    if (c.s < 0.25 || c.l < 0.12 || c.l > 0.92) continue;
                    const bucket = buckets[Math.floor(c.h / 30) % 12];
                    bucket.w += c.s;
                    bucket.r += r * c.s;
                    bucket.g += g * c.s;
                    bucket.b += b * c.s;
                }
                const best = buckets.reduce((a, b) => b.w > a.w ? b : a);
                if (best.w < 1) return resolve("#d0d0d0");
                const c = hsl(best.r / best.w, best.g / best.w, best.b / best.w);
                resolve(`hsl(${c.h.toFixed(0)} ${(Math.min(c.s, 0.85) * 100).toFixed(0)}% ${(Math.max(c.l, 0.55) * 100).toFixed(0)}%)`);
            } catch {
                resolve("#d0d0d0");
            }
        };
        img.src = cover;
    });
}

function useTrackColor(m: Media) {
    const [, update] = useState(0);
    const cover = m.color ? null : m.cover;
    useEffect(() => {
        if (!cover || trackColors.has(cover)) return;
        let alive = true;
        dominant(cover).then(color => {
            if (trackColors.size > 30) trackColors.clear();
            trackColors.set(cover, color);
            if (alive) update(n => n + 1);
        });
        return () => { alive = false; };
    }, [cover]);
    return m.color ?? (cover ? trackColors.get(cover) ?? null : null);
}

function Icon({ d, size = 16 }: { d: string; size?: number; }) {
    return (
        <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
            <path fill="currentColor" d={d} />
        </svg>
    );
}

const ICONS = {
    prev: "M3.5 3h1.6v10H3.5V3Zm9 .4v9.2a.6.6 0 0 1-.92.5L5.6 8.5a.6.6 0 0 1 0-1l5.98-4.6a.6.6 0 0 1 .92.5Z",
    next: "M10.9 3h1.6v10h-1.6V3Zm-7.4.4v9.2a.6.6 0 0 0 .92.5L10.4 8.5a.6.6 0 0 0 0-1L4.42 2.9a.6.6 0 0 0-.92.5Z",
    play: "M5 2.9v10.2a.7.7 0 0 0 1.06.6l8.1-5.1a.7.7 0 0 0 0-1.2l-8.1-5.1A.7.7 0 0 0 5 2.9Z",
    pause: "M4 2.8h2.6v10.4H4V2.8Zm5.4 0H12v10.4H9.4V2.8Z",
    paste: "M6 1.5h4a1 1 0 0 1 1 1V3h1.5A1.5 1.5 0 0 1 14 4.5v9a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 13.5v-9A1.5 1.5 0 0 1 3.5 3H5v-.5a1 1 0 0 1 1-1Zm0 1.5v1h4V3H6ZM3.5 4.5v9h9v-9H11v1H5v-1H3.5Z",
    note: "M13 1.5v8.75a2.25 2.25 0 1 1-1.4-2.08V5.1L6.4 6.2v5.55a2.25 2.25 0 1 1-1.4-2.08V3.6L13 1.5Z",
    download: "M7.25 1.5h1.5v7.19l2.47-2.47 1.06 1.06L8 11.56 3.72 7.28l1.06-1.06 2.47 2.47V1.5ZM2.5 13h11v1.5h-11V13Z"
};

// The cover, or a tile of the title's colour with a note
function Cover({ m, big }: { m: Media; big?: boolean; }) {
    // big is the 48 px cover of the card
    return m.cover
        ? <img className="vc-maska-links-cover" src={m.cover} alt="" draggable={false} />
        : (
            <span className="vc-maska-links-cover vc-maska-links-cover--tile" style={{ background: padColor(m.title || m.artist || "") }}>
                <Icon d={ICONS.note} size={big ? 22 : 16} />
            </span>
        );
}

function Controls({ m, big }: { m: Media; big?: boolean; }) {
    const kapsula = useApps().find(a => a.app === "kapsula")?.commands ?? [];
    const button = (name: string, label: string, d: string, main?: boolean) =>
        kapsula.includes(name) && (
            <button
                className={`vc-maska-links-btn${main ? " vc-maska-links-btn--main" : ""}`}
                aria-label={label}
                title={label}
                onClick={e => {
                    e.stopPropagation();
                    Native.request("kapsula", name, {});
                }}
            >
                <Icon d={d} size={big ? 16 : 14} />
            </button>
        );
    return (
        <div className={`vc-maska-links-controls${big ? " vc-maska-links-controls--big" : ""}`}>
            {button("media.prev", "Назад", ICONS.prev)}
            {button("media.toggle", m.playing ? "Пауза" : "Играть", m.playing ? ICONS.pause : ICONS.play, true)}
            {button("media.next", "Вперёд", ICONS.next)}
        </div>
    );
}

function subtitle(m: Media) {
    return [m.artist, m.app && playerName(m.app)].filter(Boolean).join(" · ");
}

// The words as kapsula.txt shows them (Media.cs, LyricView): one size for all lines, the current one bright and the
// others at 0.3, the strip moving so the current line sits in the middle of the window. Unsynced words just scroll
function LyricsView({ m, l }: { m: Media; l: Lyrics; }) {
    const progress = useProgress(m, 250);
    const box = useRef<HTMLDivElement>(null);
    const list = useRef<HTMLDivElement>(null);
    const [shift, setShift] = useState(0);
    // the first placing (the card opened, new words came) is instant; the moves after it are animated
    const [animate, setAnimate] = useState(false);

    let current = -1;
    // a line comes 0.3 s early, as in kapsula.txt, so it has moved into place when it is sung
    if (l.synced && progress) l.lines.forEach((line, i) => { if ((line.t ?? 0) <= progress.at + 0.3) current = i; });

    // new words: placed at once, the moves animated from the second frame on
    useLayoutEffect(() => {
        setAnimate(false);
        let frame = requestAnimationFrame(() => {
            frame = requestAnimationFrame(() => setAnimate(true));
        });
        return () => cancelAnimationFrame(frame);
    }, [l]);

    useLayoutEffect(() => {
        if (!l.synced || !box.current || !list.current) return;
        const half = box.current.clientHeight / 2;
        const row = current >= 0 ? list.current.children[current] as HTMLElement | undefined : undefined;
        // before the first line the strip waits half a window down
        setShift(row ? half - (row.offsetTop + row.offsetHeight / 2) : half);
    }, [current, l]);

    if (!l.synced) {
        return (
            <div className="vc-maska-links-lyrics vc-maska-links-lyrics--plain">
                {l.lines.map((line, i) => <div key={i} className="vc-maska-links-lyric">{line.text.trim() || "♪"}</div>)}
            </div>
        );
    }

    return (
        <div ref={box} className="vc-maska-links-lyrics" data-animate={animate || undefined} aria-live="off">
            <div ref={list} className="vc-maska-links-lyrics-list" style={{ transform: `translateY(${shift}px)` }}>
                {l.lines.map((line, i) => (
                    <div key={i} className="vc-maska-links-lyric" data-current={i === current || undefined}>
                        {line.text.trim() || "♪"}
                    </div>
                ))}
            </div>
        </div>
    );
}

// The track's time. When the player can be moved (canSeek and kapsula.txt has media.seek) the bar is dragged or
// clicked, and the arrow keys move it by 5 s; the place it was let go is held until the player reports from there
function TimeBar({ m, progress }: { m: Media; progress: { at: number; duration: number; part: number; }; }) {
    const seekable = m.canSeek && !!useApps().find(a => a.app === "kapsula")?.commands?.includes("media.seek");
    const [drag, setDrag] = useState<number | null>(null);
    const [held, setHeld] = useState<{ part: number; from: number | null; } | null>(null);

    // the player's next report (a new positionAt) or 2 s, whichever comes first, ends the hold
    useEffect(() => {
        if (!held) return;
        if (m.positionAt !== held.from) return setHeld(null);
        const timer = setTimeout(() => setHeld(null), 2000);
        return () => clearTimeout(timer);
    }, [held, m.positionAt]);

    const seek = (part: number) => {
        part = Math.min(1, Math.max(0, part));
        setHeld({ part, from: m.positionAt });
        Native.request("kapsula", "media.seek", { position: part * progress.duration });
    };
    const partAt = (e: React.PointerEvent<HTMLDivElement>) => {
        const r = e.currentTarget.getBoundingClientRect();
        return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    };

    const part = drag ?? held?.part ?? progress.part;
    const bar = <div className="dt-progress" style={{ "--value": part } as React.CSSProperties} />;
    return (
        <div className="vc-maska-links-card-time">
            {seekable ? (
                <div
                    className="vc-maska-links-seek"
                    data-dragging={drag != null || undefined}
                    role="slider"
                    tabIndex={0}
                    aria-label="Позиция в треке"
                    aria-valuemin={0}
                    aria-valuemax={Math.round(progress.duration)}
                    aria-valuenow={Math.round(part * progress.duration)}
                    aria-valuetext={clock(part * progress.duration)}
                    onPointerDown={e => {
                        if (e.button !== 0) return;
                        e.currentTarget.setPointerCapture(e.pointerId);
                        setDrag(partAt(e));
                    }}
                    onPointerMove={e => { if (drag != null) setDrag(partAt(e)); }}
                    onPointerUp={e => {
                        if (drag == null) return;
                        seek(partAt(e));
                        setDrag(null);
                    }}
                    onPointerCancel={() => setDrag(null)}
                    onKeyDown={e => {
                        const step = e.key === "ArrowRight" ? 5 : e.key === "ArrowLeft" ? -5 : 0;
                        if (!step) return;
                        e.preventDefault();
                        seek(part + step / progress.duration);
                    }}
                >
                    {bar}
                </div>
            ) : bar}
            <span>{clock(part * progress.duration)} / {clock(progress.duration)}</span>
        </div>
    );
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

// The card over the line: the track with its buttons, its time and, when kapsula.txt has them, its words
function MediaCard({ m, l, cardRef, style }: { m: Media; l: Lyrics | null; cardRef: React.RefObject<HTMLDivElement | null>; style: React.CSSProperties; }) {
    const progress = useProgress(m);
    const color = useTrackColor(m);
    // words of another track (the lyrics came before the track changed, or after) are not shown
    const words = l && same(l.title, m.title) && (!l.artist || !m.artist || same(l.artist, m.artist)) ? l : null;
    return (
        <div
            ref={cardRef}
            style={color ? { ...style, "--maska-track": color } as React.CSSProperties : style}
            className="vc-maska-links vc-maska-links-card"
            data-tinted={!!color || undefined}
            role="dialog"
            aria-label="Сейчас играет"
        >
            <div className="vc-maska-links-card-head">
                <span className="vc-maska-links-card-art"><Cover m={m} big /></span>
                <span className="vc-maska-links-text">
                    <span className="vc-maska-links-title" title={m.title}>{m.title || m.artist}</span>
                    {subtitle(m) && <span className="vc-maska-links-sub" title={subtitle(m)}>{subtitle(m)}</span>}
                </span>
                <Controls m={m} big />
            </div>
            {progress && <TimeBar m={m} progress={progress} />}
            {words && <LyricsView m={m} l={words} />}
            <button className="vc-maska-links-paste" onClick={() => pasteTrack(m)}>
                <Icon d={ICONS.paste} size={14} />
                Вставить в чат
            </button>
        </div>
    );
}

// The line over the voice and profile panel; a click on it (not on its buttons) opens the card
function MediaLine({ m, l }: { m: Media; l: Lyrics | null; }) {
    const line = useRef<HTMLDivElement>(null);
    const card = useRef<HTMLDivElement>(null);
    const [shown, setShown] = useState(false);
    const [place, setPlace] = useState<{ left: number; top: number; width: number; } | null>(null);
    const progress = useProgress(m);
    const color = useTrackColor(m);

    // over the line, as wide as the panel (300 px if there is none), never past the window (8 px off)
    function position() {
        const l = line.current?.getBoundingClientRect();
        const c = card.current;
        if (!l || !c) return;
        const panel = line.current?.closest('section[class*="panels_"]')?.getBoundingClientRect();
        const width = Math.min(panel?.width ?? 300, innerWidth - 16);
        const left = Math.max(8, Math.min(panel?.left ?? l.left, innerWidth - 8 - width));
        const top = Math.max(8, l.top - 8 - c.offsetHeight);
        setPlace({ left, top, width });
    }

    useLayoutEffect(() => {
        if (!shown) return;
        position();
        const resize = new ResizeObserver(position);
        if (card.current) resize.observe(card.current);
        const outside = (e: PointerEvent) => {
            const t = e.target as Node;
            if (!card.current?.contains(t) && !line.current?.contains(t)) setShown(false);
        };
        const escape = (e: KeyboardEvent) => {
            if (e.key !== "Escape") return;
            e.preventDefault();
            e.stopPropagation();
            setShown(false);
        };
        addEventListener("resize", position);
        document.addEventListener("pointerdown", outside, true);
        document.addEventListener("keydown", escape, true);
        return () => {
            resize.disconnect();
            removeEventListener("resize", position);
            document.removeEventListener("pointerdown", outside, true);
            document.removeEventListener("keydown", escape, true);
            setPlace(null);
        };
    }, [shown]);

    return (
        <div
            ref={line}
            className="vc-maska-links-row vc-maska-links-row--media"
            style={color ? { "--maska-track": color } as React.CSSProperties : undefined}
            role="button"
            tabIndex={0}
            aria-expanded={shown}
            title={mediaText(m)}
            onClick={() => setShown(v => !v)}
            onKeyDown={e => (e.key === "Enter" || e.key === " ") && e.target === e.currentTarget && setShown(v => !v)}
        >
            <span className="vc-maska-links-art">
                <Cover m={m} />
                {m.playing && <span className="vc-maska-links-eq" aria-hidden="true"><i /><i /><i /><i /></span>}
            </span>
            <span className="vc-maska-links-text">
                <span className="vc-maska-links-title">{m.title || m.artist}</span>
                {subtitle(m) && <span className="vc-maska-links-sub">{subtitle(m)}</span>}
            </span>
            <Controls m={m} />
            {progress && <span className="vc-maska-links-line" style={{ "--value": progress.part } as React.CSSProperties} />}
            {shown && layer && ReactDOM.createPortal(
                <MediaCard
                    m={m}
                    l={l}
                    cardRef={card}
                    style={place ? { left: place.left, top: place.top, width: place.width } : { left: 0, top: 0, visibility: "hidden" }}
                />,
                layer
            )}
        </div>
    );
}

function speed(bytesPerSecond = 0) {
    return `${(bytesPerSecond / 1048576).toFixed(1).replace(".", ",")} МБ/с`;
}

function DownloadLine({ d }: { d: Download; }) {
    const percent = Math.round(Math.min(1, Math.max(0, d.progress ?? 0)) * 100);
    return (
        <div className="vc-maska-links-row" title={d.name}>
            <span className="vc-maska-links-art">
                <span className="vc-maska-links-cover vc-maska-links-cover--steam"><Icon d={ICONS.download} /></span>
            </span>
            <span className="vc-maska-links-text">
                <span className="vc-maska-links-title">{d.name}</span>
                <span className="vc-maska-links-sub">Steam · {percent}% · {d.paused ? "на паузе" : speed(d.bytesPerSecond)}</span>
            </span>
            <span className="vc-maska-links-line" style={{ "--value": percent / 100 } as React.CSSProperties} />
        </div>
    );
}

// The lines over the voice and profile panel: what kapsula.txt plays and what Steam downloads
function LinksBar({ useFlags }: { useFlags(): { familyMedia: boolean; familySteam: boolean; }; }) {
    const { familyMedia, familySteam } = useFlags();
    const { media, lyrics, download } = useLinks();
    const showMedia = familyMedia && !!media && !!(media.title || media.artist);
    const showDownload = familySteam && !!download?.name;
    if (!showMedia && !showDownload) return null;

    return (
        <div className="vc-maska-links vc-maska-links-bar">
            {showMedia && <MediaLine m={media!} l={lyrics} />}
            {showDownload && <DownloadLine d={download!} />}
        </div>
    );
}

let stopSlot: (() => void) | null = null;
// the layer the card is drawn in, over Discord's columns and level with its popups
let layer: HTMLElement | null = null;

// The bar is the first child of the panel at the bottom left, inside it, so the grid of Islands is not touched
export function mountLinks(useFlags: () => { familyMedia: boolean; familySteam: boolean; }) {
    if (stopSlot) return;
    try {
        layer = document.body.appendChild(document.createElement("div"));
        layer.className = "vc-maska-links vc-maska-links-layer";
        stopSlot = keepSlot({
            tag: "div",
            className: "vc-maska-links-slot",
            find: panels => panels,
            first: true,
            render: () => <ErrorBoundary noop><LinksBar useFlags={useFlags} /></ErrorBoundary>
        });
    } catch {
        unmountLinks();
    }
}

export function unmountLinks() {
    stopSlot?.();
    stopSlot = null;
    layer?.remove();
    layer = null;
}
