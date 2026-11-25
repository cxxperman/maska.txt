/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ChatBarButton } from "@api/ChatButtons";
import { definePluginSettings, Settings } from "@api/Settings";
import { disableStyle, enableStyle, managedStyleRootNode } from "@api/Styles";
import { getUserSettingLazy } from "@api/UserSettings";
import ErrorBoundary from "@components/ErrorBoundary";
import SettingsPlugin from "@plugins/_core/settings";
import { IS_WINDOWS } from "@utils/constants";
import { createAndAppendStyle } from "@utils/css";
import { removeFromArray } from "@utils/misc";
import { relaunch } from "@utils/native";
import definePlugin, { IconProps, OptionType, PluginNative } from "@utils/types";
import { findByPropsLazy, findStoreLazy } from "@webpack";
import { Alerts, ApplicationStreamingStore, CallStore, ChannelStore, createRoot, FluxDispatcher, GuildMemberStore, GuildStore, MediaEngineStore, NavigationRouter, RelationshipStore, RestAPI, SelectedChannelStore, useEffect, UserStore, useState, VoiceStateStore } from "@webpack/common";

import accentStyle from "./accent.css?managed";
import { AURA_TOPICS, mountAuraCall, resetAura, setAuraState, unmountAuraCall } from "./aura";
import auraStyle from "./aura.css?managed";
import brandStyle from "./brand.css?managed";
import dockStyle from "./dock.css?managed";
import { Brand, FamilyButton, FamilyList, getApps, setApps } from "./family";
import glassStyle from "./glass.css?managed";
import islandsStyle from "./islands.css?managed";
import kitStyle from "./kit.css?managed";
import { getMedia, mediaText, mountLinks, pasteTrack, resetLinks, setLinkState, unmountLinks, useLinks } from "./links";
import linksStyle from "./links.css?managed";
import marksStyle from "./marks.css?managed";
import themeStyle from "./maska.css?managed";
import { Peek } from "./peek";
import peekStyle from "./peek.css?managed";
import { clearPresence, updatePresence } from "./presence";
import { getSnapshot, installPreset, PRESET_VERSION, restoreSnapshot, Snapshot } from "./preset";
import promosStyle from "./promos.css?managed";
import roundedStyle from "./rounded.css?managed";
import serversStyle from "./servers.css?managed";
import solidStyle from "./solid.css?managed";
import { PixelIcon } from "./sprites";

// Sent to the hub in hello; the launcher shows it in hub.apps
const VERSION = "0.7.0";

const Native = VencordNative.pluginHelpers.Maska as PluginNative<typeof import("./native")>;
// The same Discord internals as the Kapsula plugin next door (kapsula.desktop), nothing new
const SpeakingStore = findStoreLazy("SpeakingStore");
const AudioActions = findByPropsLazy("toggleSelfMute", "toggleSelfDeaf");
const ChannelActions = findByPropsLazy("selectVoiceChannel", "selectChannel");
// Discord's own status setting, as AutoDNDWhilePlaying changes it
const StatusSetting = getUserSettingLazy<string>("status", "status")!;

// The switches core.txt may change with settings.set
const SWITCHES = ["theme", "glass", "rounded", "hidePromos", "slimServers", "familyMarks", "brandAccents", "auraPanel", "islandNotify", "familyFocus", "familyMedia", "familyPresence", "familySteam", "shareCalls"] as const;
type SettingKey = typeof SWITCHES[number];
// The themes; Classic is the dev.txt look as it was, Islands lays floating panels and motion on top of it
const LOOKS = [{ value: "classic", label: "Классическая" }, { value: "islands", label: "Острова" }] as const;
type Look = typeof LOOKS[number]["value"];

const settings = definePluginSettings({
    look: {
        type: OptionType.SELECT,
        description: "Theme: Classic (the dev.txt look) or Islands (floating glass panels, motion)",
        options: [
            { label: "Classic", value: "classic" },
            { label: "Islands", value: "islands", default: true }
        ],
        onChange: settingsChanged
    },
    theme: {
        type: OptionType.BOOLEAN,
        description: "dev.txt look: a dark transparent window, Segoe UI Variable, the accent chosen in core.txt",
        default: true,
        onChange: settingsChanged
    },
    glass: {
        type: OptionType.BOOLEAN,
        description: "Transparent window (Acrylic): what is behind Discord shows through, blurred. Needs a restart after turning on",
        default: true,
        onChange: glassChanged
    },
    rounded: {
        type: OptionType.BOOLEAN,
        description: "Rounded corners (part of the dev.txt look)",
        default: true,
        onChange: settingsChanged
    },
    hidePromos: {
        type: OptionType.BOOLEAN,
        description: "Hide Nitro, shop and quest promos",
        default: true,
        onChange: settingsChanged
    },
    slimServers: {
        type: OptionType.BOOLEAN,
        description: "Server list slides out on hover",
        default: true,
        onChange: settingsChanged
    },
    familyMarks: {
        type: OptionType.BOOLEAN,
        description: "dev.txt marks: the maska window icon, the family button in the title bar, the home button and the loading screen. The window icon goes back only after a restart",
        default: true,
        onChange: settingsChanged
    },
    brandAccents: {
        type: OptionType.BOOLEAN,
        description: "The dev.txt orange on the unread marks of channels and servers and on the selected server",
        default: true,
        onChange: settingsChanged
    },
    auraPanel: {
        type: OptionType.BOOLEAN,
        description: "aura.txt in the voice panel: sounds, voice effects and party",
        default: true,
        onChange: settingsChanged
    },
    shareCalls: {
        type: OptionType.BOOLEAN,
        description: "Show your calls to other dev.txt apps on this computer and let them mute, deafen, answer or hang up",
        default: true,
        onChange: settingsChanged
    },
    islandNotify: {
        type: OptionType.BOOLEAN,
        description: "Discord notifications on the kapsula.txt island: direct messages and mentions as a card instead of a Windows notification",
        default: true,
        onChange: settingsChanged
    },
    familyFocus: {
        type: OptionType.BOOLEAN,
        description: "Do Not Disturb from core.txt: Discord's status goes to Do Not Disturb with the family and back after",
        default: true,
        onChange: settingsChanged
    },
    familyMedia: {
        type: OptionType.BOOLEAN,
        description: "Music from kapsula.txt over the profile panel, with its buttons, and a chat button to paste it",
        default: true,
        onChange: settingsChanged
    },
    familyPresence: {
        type: OptionType.BOOLEAN,
        description: "Show what plays in kapsula.txt as your Discord activity",
        default: true,
        onChange: presenceChanged
    },
    familySteam: {
        type: OptionType.BOOLEAN,
        description: "Steam downloads from arkada.txt over the profile panel",
        default: true,
        onChange: settingsChanged
    },
    presetApplied: {
        type: OptionType.NUMBER,
        description: "The plugin set version Maska has already turned on",
        default: 0,
        hidden: true
    },
    focusSaved: {
        type: OptionType.STRING,
        description: "The status Discord had before Do Not Disturb from core.txt, to bring back after",
        default: "",
        hidden: true
    }
});

let running = false;
let session = 0;
let pending: ReturnType<typeof setTimeout> | undefined;
let channel: string | null = null;
let since = 0;
let lastVoice = "";
// hub.theme as the hub last sent it; kept while the hub is away
let hubTheme: { accent?: string | null; reducedMotion?: boolean; } = {};
let runtimeStyle: HTMLStyleElement | null = null;
// The material the window was created with: changing the setting takes effect only after a restart
let windowMaterial: typeof Settings.windowsMaterial | undefined;
let peekRoot: ReturnType<typeof createRoot> | null = null;
let peekNode: HTMLElement | null = null;
// The last message sent to the island: a click on its card brings Discord forward on it
let lastNotified: { at: number; path: string; } | null = null;
// core.family.focus as last heard; null until the first one after the start
let lastFocus: boolean | null = null;

function isSpeaking(userId: string) {
    try {
        return !!SpeakingStore.isSpeaking(userId);
    } catch {
        return false;
    }
}

function nameOf(userId: string) {
    const u = UserStore.getUser(userId);
    return RelationshipStore.getNickname(userId) ?? u?.globalName ?? u?.username ?? "";
}

// Calls that are ringing for you right now, other than the one you are in
function ringingCalls() {
    const me = UserStore.getCurrentUser()?.id;
    if (!me) return [];
    const current = SelectedChannelStore.getVoiceChannelId();
    return (CallStore.getCalls() ?? []).filter(c => c?.ringing?.includes(me) && c.channelId !== current);
}

function incoming() {
    const me = UserStore.getCurrentUser()?.id;
    const call = ringingCalls()[0];
    const ch = call ? ChannelStore.getChannel(call.channelId) : null;
    if (!ch) return null;
    // the caller is already in the call; in a DM it is the other person anyway
    const callerId = Object.values(VoiceStateStore.getVoiceStatesForChannel(ch.id) ?? {}).map(s => s.userId).find(u => u !== me)
        ?? ch.recipients?.find(u => u !== me);
    const group = ch.isGroupDM();
    return {
        channel: ch.id,
        name: group ? ch.name || (ch.recipients ?? []).slice(0, 3).map(nameOf).join(", ") : callerId ? nameOf(callerId) : "",
        caller: callerId ? nameOf(callerId) : "",
        avatar: callerId ? UserStore.getUser(callerId)?.getAvatarURL(null, 128, false) ?? "" : "",
        group
    };
}

// maska.voice: where you are, since when, who is there and who is talking. The same picture the Kapsula plugin gives its island
function snapshot() {
    const id = SelectedChannelStore.getVoiceChannelId() ?? null;
    if (id !== channel) {
        channel = id;
        since = id ? Date.now() : 0;
    }
    const me = UserStore.getCurrentUser()?.id;
    let ring: ReturnType<typeof incoming> = null;
    try {
        ring = incoming();
    } catch { }
    const ch = id ? ChannelStore.getChannel(id) : null;
    const guildId = ch?.guild_id ?? null;
    const states = id ? Object.values(VoiceStateStore.getVoiceStatesForChannel(id) ?? {}) : [];
    const people = states.slice(0, 12).map(s => {
        const u = UserStore.getUser(s.userId);
        return {
            id: s.userId,
            name: (guildId ? GuildMemberStore.getNick(guildId, s.userId) : null) ?? u?.globalName ?? u?.username ?? "",
            avatar: u?.getAvatarURL(guildId, 64, false) ?? "",
            speaking: isSpeaking(s.userId),
            mute: !!(s.selfMute || s.mute),
            deaf: !!(s.selfDeaf || s.deaf),
            video: !!s.selfVideo,
            stream: !!s.selfStream,
            me: s.userId === me
        };
    });
    return {
        inCall: id != null,
        channel: ch?.name ?? "",
        guild: guildId ? GuildStore.getGuild(guildId)?.name ?? "" : "",
        users: states.length,
        mute: MediaEngineStore.isSelfMute(),
        deaf: MediaEngineStore.isSelfDeaf(),
        stream: ApplicationStreamingStore.getCurrentUserActiveStream() != null,
        video: people.some(p => p.me && p.video),
        speaking: people.some(p => p.speaking),
        meSpeaking: !!me && isSpeaking(me),
        since,
        people,
        incoming: ring
    };
}

// The full picture every time, and only when something in it has changed
function publishVoice() {
    if (!running) return;
    let data: ReturnType<typeof snapshot> | null = null;
    if (settings.store.shareCalls) {
        try {
            data = snapshot();
        } catch {
            return;
        }
    }
    const body = JSON.stringify(data);
    if (body === lastVoice) return;
    lastVoice = body;
    Native.state("maska.voice", data);
}

// Discord changed something: changes that come in a burst go out together
function changed() {
    if (pending) return;
    pending = setTimeout(() => {
        pending = undefined;
        publishVoice();
    }, 30);
}

// The switches with their Russian labels: the same for core.txt and for the dev.txt page in Discord's settings
function settingGroups() {
    const item = (key: SettingKey, label: string, hint: string) => ({ key, label, hint, type: "switch" as const });
    const look = { key: "look" as const, label: "Тема", hint: "Классическая — вид dev.txt; Острова — парящие стеклянные панели и движение", type: "choice" as const, options: LOOKS };
    return [
        {
            title: "Вид Discord",
            items: [
                look,
                item("theme", "Оформление dev.txt", "Тёмное прозрачное окно, шрифт Segoe UI Variable и общий цвет, если он выбран в core.txt"),
                item("glass", "Прозрачное окно", "Материал Windows 11 под окном Discord; после включения нужен перезапуск"),
                item("rounded", "Скруглённые углы", "Работает вместе с оформлением dev.txt"),
                item("hidePromos", "Скрыть рекламу Nitro и заданий", "Магазин, подарки, задания и предложения Nitro"),
                item("slimServers", "Список серверов выезжает при наведении", "Пока мышь не у левого края, список свёрнут в узкую полоску"),
                item("familyMarks", "Знаки dev.txt", "Значок окна, кнопка семейства, кнопка „Домой“ и экран загрузки"),
                item("brandAccents", "Фирменный цвет в метках", "Оранжевые метки непрочитанного и выбранного сервера"),
                item("auraPanel", "aura.txt в панели звонка", "Звуки, эффекты и пати в панели голосовой связи")
            ]
        },
        {
            title: "Семейство",
            items: [
                item("islandNotify", "Уведомления Discord на острове", "Личные сообщения и упоминания — карточкой на острове kapsula.txt вместо уведомлений Windows"),
                item("familyFocus", "„Не беспокоить“ из core.txt", "Discord ставит статус „Не беспокоить“ вместе с семейством и возвращает прежний"),
                item("familyMedia", "Музыка из kapsula.txt", "Что играет — над панелью профиля, с кнопками"),
                item("familyPresence", "Музыка в статусе Discord", "„Слушает“ с треком, обложкой и полосой хода — видно друзьям. Для Spotify и Cider статус ставят они сами"),
                item("familySteam", "Steam из arkada.txt", "Загрузка игры из Steam — над панелью профиля")
            ]
        },
        {
            title: "Звонки",
            items: [
                item("shareCalls", "Показывать звонки другим приложениям dev.txt", "Кто в звонке и кто говорит; кнопки микрофона, звука и ответа на звонок")
            ]
        }
    ];
}

// maska.settings: core.txt draws these on its settings page and sends changes back with settings.set
function publishSettings() {
    Native.state("maska.settings", {
        groups: settingGroups().map(g => ({
            title: g.title,
            items: g.items.map(i => ({ ...i, value: settings.store[i.key] }))
        }))
    });
}

// The dev.txt page in Discord's settings: the same switches, drawn with the kit.txt elements, and the family
function SettingsPage() {
    const values = settings.use([...SWITCHES, "look"]);
    return (
        <div className="vc-maska-page">
            <div className="vc-maska-head">
                <span className="dt-tile"><PixelIcon size={36} /></span>
                <Brand app="maska" />
            </div>
            {settingGroups().map(g => (
                <div className="dt-block" key={g.title}>
                    <h3>{g.title}</h3>
                    <div className="vc-maska-list">
                        {g.items.map(i => (
                            <div className="dt-row" key={i.key}>
                                <div className="vc-maska-row-text">
                                    <div>{i.label}</div>
                                    <div className="vc-maska-hint">{i.hint}</div>
                                </div>
                                {i.type === "choice" ? (
                                    <div className="dt-seg" role="radiogroup">
                                        {i.options.map(o => (
                                            <button key={o.value} role="radio" aria-checked={values.look === o.value} onClick={() => settings.store.look = o.value}>{o.label}</button>
                                        ))}
                                    </div>
                                ) : (
                                    <label className="dt-switch">
                                        <input type="checkbox" checked={values[i.key]} onChange={e => settings.store[i.key] = e.currentTarget.checked} />
                                        <i />
                                    </label>
                                )}
                            </div>
                        ))}
                    </div>
                </div>
            ))}
            <div className="dt-block">
                <h3>Запущено сейчас</h3>
                <FamilyList />
            </div>
            <SetupBlock />
        </div>
    );
}

const SETTINGS_ENTRY = "maska_devtxt";

// The island has notify: the message goes there, as a card, instead of Discord's Windows notification.
// Called from Discord's message notification, after its own rules (muted servers and channels, its Do Not
// Disturb, the notification settings) have let it through; true makes Discord go on as if desktop
// notifications were off for it, so its sound still plays and no Windows notification shows
function toIsland(arg: any, store: any, never: unknown) {
    try {
        if (!running || !settings.store.islandNotify) return false;
        if (store?.getDesktopType?.() === never) return false;
        if (!getApps().find(a => a.app === "kapsula")?.commands?.includes("notify")) return false;
        const message = arg?.message;
        const ch = message?.channel_id ? ChannelStore.getChannel(message.channel_id) : null;
        if (!message || !ch) return false;

        const author = message.author ?? {};
        const name = (ch.guild_id ? GuildMemberStore.getNick(ch.guild_id, author.id) : RelationshipStore.getNickname(author.id))
            ?? author.global_name ?? author.username ?? "";
        const where = ch.guild_id ? `#${ch.name}` : ch.isGroupDM() ? ch.name || "" : "";
        const title = (where ? `${name} · ${where}` : name).slice(0, 60);
        const text = (message.content?.trim()
            || (message.sticker_items?.length || message.stickers?.length ? "Стикер" : "")
            || (message.attachments?.length ? "Вложение" : "")).slice(0, 200);

        Native.request("kapsula", "notify", { title: title || "Discord", text, open: true });
        lastNotified = { at: Date.now(), path: `/channels/${ch.guild_id ?? "@me"}/${ch.id}/${message.id}` };
        return true;
    } catch {
        return false;
    }
}

// Discord's status with the family's Do Not Disturb: on, the status goes to dnd and the one before is kept (in a
// hidden setting, so a restart in between does not lose it); off, it comes back unless it was changed meanwhile.
// A dnd that was there already is left alone and not "brought back"
function familyChanged(data: any) {
    if (!data || typeof data.focus !== "boolean") return;
    const { focus } = data;
    const was = lastFocus;
    lastFocus = focus;
    if (!running || !settings.store.familyFocus || focus === was) return;
    try {
        const saved = settings.store.focusSaved;
        if (focus && !saved) {
            const now = StatusSetting.getSetting();
            if (!now || now === "dnd") return;
            settings.store.focusSaved = now;
            StatusSetting.updateSetting("dnd");
        } else if (!focus && saved) {
            if (StatusSetting.getSetting() === "dnd") StatusSetting.updateSetting(saved);
            settings.store.focusSaved = "";
        }
    } catch { }
}

// The Discord activity follows kapsula.media: set on its messages only, taken off when switched off
function syncPresence() {
    if (running && settings.store.familyPresence) updatePresence(getMedia());
    else clearPresence();
}

function presenceChanged() {
    syncPresence();
    settingsChanged();
}

// The chat bar button: pastes what kapsula.txt plays into the message box, without sending it
function MediaChatButton() {
    const { familyMedia } = settings.use(["familyMedia"]);
    const { media } = useLinks();
    const text = mediaText(media);
    if (!familyMedia || !text) return null;
    return (
        <ChatBarButton tooltip="Вставить, что играет" onClick={() => pasteTrack(media)}>
            <NoteIcon />
        </ChatBarButton>
    );
}

function NoteIcon() {
    return (
        <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
            <path fill="currentColor" d="M20 3v12.5a3.5 3.5 0 1 1-2-3.16V7.3l-8 1.6v8.6A3.5 3.5 0 1 1 8 14.34V5.6L20 3Z" />
        </svg>
    );
}

// The maska behind the left edge: Islands only, and only while the server list is folded into its strip
function PeekRoot() {
    const { look, familyMarks, slimServers } = settings.use(["look", "familyMarks", "slimServers"]);
    if (look !== "islands" || !familyMarks || !slimServers) return null;
    return <Peek isRinging={() => ringingCalls().length > 0} />;
}

function mountPeek() {
    if (peekRoot) return;
    try {
        peekNode = document.body.appendChild(document.createElement("div"));
        peekNode.id = "vc-maska-peek-root";
        peekRoot = createRoot(peekNode);
        peekRoot.render(<ErrorBoundary noop><PeekRoot /></ErrorBoundary>);
    } catch { }
}

function unmountPeek() {
    peekRoot?.unmount();
    peekNode?.remove();
    peekRoot = null;
    peekNode = null;
}

function TitleBarButton() {
    const { familyMarks } = settings.use(["familyMarks"]);
    return familyMarks ? <FamilyButton /> : null;
}

function toHsl(hex: string) {
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
    if (!m) return null;
    const [r, g, b] = m.slice(1).map(x => parseInt(x, 16) / 255);
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    const l = (max + min) / 2;
    const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
    let h = 0;
    if (d !== 0) {
        if (max === r) h = ((g - b) / d + 6) % 6;
        else if (max === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
    }
    return `${(h * 60).toFixed(1)} ${(s * 100).toFixed(1)}% ${(l * 100).toFixed(1)}%`;
}

function setStyle(name: string, on: boolean) {
    if (on) enableStyle(name);
    else disableStyle(name);
}

// Puts the Windows 11 material under the window if there is none; true if a restart is needed for it
function ensureAcrylic() {
    if (!IS_WINDOWS || Settings.windowsMaterial !== "none") return false;
    Settings.windowsMaterial = "acrylic";
    return true;
}

function askRestart(body: string) {
    const show = () => {
        try {
            Alerts.show({ title: "Maska", body, confirmText: "Restart now", cancelText: "Later", onConfirm: relaunch });
        } catch { }
    };
    if (UserStore.getCurrentUser()) return show();
    // Discord has not finished loading yet: once it has
    const ready = () => {
        FluxDispatcher.unsubscribe("CONNECTION_OPEN", ready);
        show();
    };
    FluxDispatcher.subscribe("CONNECTION_OPEN", ready);
}

// The dev.txt setup, once per PRESET_VERSION: the snapshot, then Vencord (preset.ts), then Maska's own
// switches at their defaults and Islands. A snapshot that could not be written stops it until the next start
async function installOnce() {
    if (settings.store.presetApplied >= PRESET_VERSION) return;
    let changed: boolean;
    try {
        changed = await installPreset();
    } catch {
        return;
    }
    if (!running) return;
    for (const key of SWITCHES) {
        if (settings.store[key] === true) continue;
        settings.store[key] = true;
        changed = true;
    }
    if (settings.store.look !== "islands") {
        settings.store.look = "islands";
        changed = true;
    }
    settings.store.presetApplied = PRESET_VERSION;
    if (changed) askRestart("Maska set up Discord the dev.txt way: plugin set, theme and window. Restart Discord to finish. Your previous Vencord settings are saved — you can bring them back in Settings → dev.txt.");
}

// Back to the Vencord settings from before the setup; Maska itself stays, only its look and set come off
function askRestore() {
    Alerts.show({
        title: "Maska",
        body: "Вернуть настройки Vencord, которые были до Maska? Набор плагинов, темы и оформление dev.txt будут сняты. Discord перезапустится.",
        confirmText: "Вернуть",
        cancelText: "Отмена",
        async onConfirm() {
            try {
                if (!await restoreSnapshot()) return;
            } catch {
                return;
            }
            settings.store.theme = false;
            settings.store.slimServers = false;
            settings.store.hidePromos = false;
            settings.store.brandAccents = false;
            // the settings reach the disk through IPC: a moment for them before the app goes
            setTimeout(relaunch, 500);
        }
    });
}

function SetupBlock() {
    const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
    useEffect(() => {
        getSnapshot().then(s => setSnapshot(s ?? null), () => { });
    }, []);
    if (!snapshot) return null;
    const date = (ms: number) => new Date(ms).toLocaleDateString("ru-RU");
    return (
        <div className="dt-block">
            <h3>Установка</h3>
            <div className="dt-row">
                <div className="vc-maska-row-text">
                    {snapshot.restoredAt
                        ? `Прежние настройки возвращены ${date(snapshot.restoredAt)}`
                        : `Discord настроен в стиле dev.txt ${date(snapshot.at)}. Прежние настройки Vencord сохранены`}
                </div>
                {!snapshot.restoredAt && <button className="dt-btn" onClick={askRestore}>Вернуть прежние настройки</button>}
            </div>
        </div>
    );
}

function glassChanged(on: boolean) {
    if (running && on && ensureAcrylic()) askRestart("The transparent window needs a Discord restart to turn on.");
    settingsChanged();
}

// The look: the stylesheets by the settings, plus what hub.theme asks for on top
function applyLook() {
    const on = running && settings.store.theme;
    // only over a window that really has a material under it, otherwise transparent layers sit on a flat colour
    const glass = on && settings.store.glass && IS_WINDOWS && windowMaterial != null && windowMaterial !== "none";
    const accent = typeof hubTheme.accent === "string" && toHsl(hubTheme.accent) ? hubTheme.accent : null;
    setStyle(themeStyle, on);
    setStyle(glassStyle, glass);
    setStyle(solidStyle, on && !glass);
    setStyle(islandsStyle, on && settings.store.look === "islands");
    setStyle(accentStyle, on && accent != null);
    setStyle(roundedStyle, on && settings.store.rounded);
    setStyle(promosStyle, running && settings.store.hidePromos);
    setStyle(serversStyle, running && settings.store.slimServers);
    setStyle(dockStyle, on && settings.store.look === "islands" && settings.store.slimServers);
    setStyle(kitStyle, running);
    setStyle(brandStyle, running && settings.store.brandAccents);
    setStyle(marksStyle, running && settings.store.familyMarks);
    setStyle(peekStyle, running);
    setStyle(auraStyle, running && settings.store.auraPanel);
    setStyle(linksStyle, running && (settings.store.familyMedia || settings.store.familySteam));
    if (running && (settings.store.familyMedia || settings.store.familySteam)) mountLinks(() => settings.use(["familyMedia", "familySteam"]));
    else unmountLinks();
    if (running && settings.store.auraPanel) mountAuraCall();
    else unmountAuraCall();
    if (!on) {
        runtimeStyle?.remove();
        runtimeStyle = null;
        return;
    }
    runtimeStyle ??= createAndAppendStyle("vc-maska-runtime", managedStyleRootNode);
    runtimeStyle.textContent = "";
    const vars: string[] = [];
    // Discord keeps the brand colour a second time as "hue saturation lightness"
    if (accent) vars.push(`--maska-accent: ${accent};`, `--brand-500-hsl: ${toHsl(accent)};`);
    if (hubTheme.reducedMotion) vars.push("--maska-dur: 0ms;");
    runtimeStyle.textContent = `:root:root:root { ${vars.join(" ")} }`;
}

function settingsChanged() {
    if (!running) return;
    applyLook();
    Native.setIcon(settings.store.familyMarks);
    publishVoice();
    publishSettings();
}

function needCalls() {
    if (!settings.store.shareCalls) throw new Error("calls-not-shared");
}

// The call a command is about: the one named in args.channel if it is really ringing, otherwise the one that is
function ringing(args: { channel?: unknown; }) {
    const calls = ringingCalls();
    const call = args.channel == null ? calls[0] : calls.find(c => c.channelId === args.channel);
    if (!call) throw new Error("no-call");
    return call.channelId;
}

const commands: Record<string, (args: any) => unknown> = {
    // Discord forward; from a card on the island that was just sent (2 minutes at most), on its message too
    show() {
        Native.focusWindow();
        const last = lastNotified;
        lastNotified = null;
        if (last && Date.now() - last.at <= 120000) NavigationRouter.transitionTo(last.path);
    },
    "voice.mute"({ on }) {
        needCalls();
        const now = MediaEngineStore.isSelfMute();
        const want = typeof on === "boolean" ? on : !now;
        if (want !== now) AudioActions.toggleSelfMute();
        return { muted: want };
    },
    "voice.deafen"({ on }) {
        needCalls();
        const now = MediaEngineStore.isSelfDeaf();
        const want = typeof on === "boolean" ? on : !now;
        if (want !== now) AudioActions.toggleSelfDeaf();
        return { deafened: want };
    },
    "voice.leave"() {
        needCalls();
        ChannelActions.selectVoiceChannel(null);
    },
    "call.accept"(args) {
        needCalls();
        ChannelActions.selectVoiceChannel(ringing(args));
    },
    // Stops the ringing just for you, as declining in Discord does; others in a group call keep ringing
    async "call.decline"(args) {
        needCalls();
        const channelId = ringing(args);
        await RestAPI.post({ url: `/channels/${channelId}/call/stop-ringing`, body: { recipients: [UserStore.getCurrentUser().id] } });
    },
    "settings.set"({ key, value }) {
        if (key === "look") {
            if (!LOOKS.some(l => l.value === value)) throw new Error("bad-value");
            settings.store.look = value as Look;
            settingsChanged();
            return { key, value };
        }
        if (!SWITCHES.includes(key)) throw new Error("unknown-key");
        if (typeof value !== "boolean") throw new Error("bad-value");
        settings.store[key as SettingKey] = value;
        settingsChanged();
        return { key, value };
    }
};

async function handle(m: { type: string; [key: string]: any; }) {
    if (m.type === "state" && m.topic === "hub.theme") {
        hubTheme = m.data ?? {};
        applyLook();
    } else if (m.type === "state" && m.topic === "hub.apps") {
        setApps(m.data);
        // aura.txt has gone, or the hub with it: what it said no longer holds
        if (!Array.isArray(m.data) || !m.data.some(a => a?.app === "aura")) resetAura();
        resetLinks(m.data);
        // kapsula.txt gone: nothing plays any more
        if (!getMedia()) clearPresence();
    } else if (m.type === "state" && m.topic === "core.family") {
        familyChanged(m.data);
    } else if (m.type === "state") {
        setAuraState(m.topic, m.data);
        setLinkState(m.topic, m.data);
        if (m.topic === "kapsula.media") syncPresence();
    } else if (m.type === "command") {
        const run = commands[m.name];
        if (!run) return Native.result(m.id, m.from, false, null, "unknown-command");
        try {
            Native.result(m.id, m.from, true, await run(m.args ?? {}) ?? null);
        } catch (e: any) {
            Native.result(m.id, m.from, false, null, String(e?.message ?? e));
        }
    }
}

// There is always a request waiting in the main process for the next thing the hub passes on
async function listen(mine: number) {
    while (running && mine === session) {
        let messages: Awaited<ReturnType<typeof Native.wait>> = [];
        try {
            messages = await Native.wait();
        } catch {
            await new Promise(r => setTimeout(r, 3000));
        }
        if (!running || mine !== session) break;
        for (const m of messages) {
            try {
                await handle(m);
            } catch { }
        }
    }
}

const stores = () => [SelectedChannelStore, MediaEngineStore, VoiceStateStore, ApplicationStreamingStore, SpeakingStore, CallStore];

export default definePlugin({
    name: "Maska",
    description: "Your look and your calls for Discord: the dev.txt theme (Windows 11 Fluent, transparent Acrylic window, shared accent colour, rounded corners), a ready plugin set, and your call shown to other dev.txt apps on this computer, which can mute, deafen, answer or hang up for you",
    authors: [{ name: "cxxperman", id: 0n }],
    enabledByDefault: true,
    dependencies: ["UserSettingsAPI"],
    settings,

    patches: [
        {
            // Discord's desktop notification for a message, the function OnePingPerDM patches too. Its rules have
            // already run here; where it asks whether desktop notifications are off, toIsland may answer for it.
            // Inserted before that check, so the check itself (and OnePingPerDM's anchor on it) stays as it was
            find: '"NotificationStore"',
            replacement: {
                match: /(\i\.\i)\.getDesktopType\(\)===(\i\.\i\.NEVER)(?=\))/,
                replace: "$self.toIsland(arguments[0],$1,$2)||$&"
            }
        },
        {
            // the place VencordToolbox puts its button too: the trailing buttons of the title bar (Inbox, Help)
            find: '?"BACK_FORWARD_NAVIGATION":',
            replacement: {
                match: /(trailing:.{0,150}?\{children:\[)/,
                replace: "$1$self.renderTitleBarButton(),"
            }
        }
    ],

    toIsland,

    chatBarButton: {
        icon: NoteIcon,
        render: MediaChatButton
    },

    renderTitleBarButton: ErrorBoundary.wrap(() => <TitleBarButton key="vc-maska-family" />, { noop: true }),

    start() {
        running = true;
        windowMaterial ??= Settings.windowsMaterial;
        installOnce();
        applyLook();
        Native.start(VERSION, Object.keys(commands), ["hub.theme", "hub.apps", ...AURA_TOPICS, "core.family", "kapsula.media", "kapsula.lyrics", "arkada.downloads"]);
        Native.setIcon(settings.store.familyMarks);
        SettingsPlugin.customEntries.push({
            key: SETTINGS_ENTRY,
            title: "dev.txt",
            Component: ErrorBoundary.wrap(SettingsPage, { noop: false }),
            Icon: (props: IconProps) => <PixelIcon size={props.width ?? 20} className={props.className} />
        });
        publishSettings();
        publishVoice();
        for (const store of stores()) {
            try {
                store.addChangeListener(changed);
            } catch { }
        }
        listen(++session);
        mountPeek();
    },

    stop() {
        running = false;
        for (const store of stores()) {
            try {
                store.removeChangeListener(changed);
            } catch { }
        }
        clearTimeout(pending);
        pending = undefined;
        channel = null;
        lastVoice = "";
        hubTheme = {};
        setApps([]);
        resetAura();
        resetLinks(null);
        clearPresence();
        lastFocus = null;
        lastNotified = null;
        unmountPeek();
        removeFromArray(SettingsPlugin.customEntries, e => e.key === SETTINGS_ENTRY);
        applyLook();
        Native.stop();
    }
});
