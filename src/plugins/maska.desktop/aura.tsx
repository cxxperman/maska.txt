/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import ErrorBoundary from "@components/ErrorBoundary";
import { copyWithToast, insertTextIntoChatInputBox } from "@utils/discord";
import { PluginNative } from "@utils/types";
import { ReactDOM, useEffect, useLayoutEffect, useRef, useState } from "@webpack/common";

import { Brand, useApps } from "./family";
import { keepSlot } from "./slot";
import { PixelIcon } from "./sprites";

const Native = VencordNative.pluginHelpers.Maska as PluginNative<typeof import("./native")>;

// aura.sounds, aura.effects and aura.party as aura.txt last sent them (kit.txt hub/PROTOCOL.md)
interface Item {
    id: string;
    name: string;
}

interface AuraState {
    sounds: { mic?: boolean; pads?: Item[]; playing?: string[]; } | null;
    effects: { mic?: boolean; active?: string | null; items?: Item[]; } | null;
    party: {
        enabled?: boolean;
        canHost?: boolean;
        role?: "host" | "guest" | null;
        code?: string;
        people?: number;
        asking?: Item[];
        direct?: boolean;
        // the party through Discord: no code, no direct connection (aura.txt 0.30.0 does not send it)
        // where: the site in the party window of aura.txt or in the browser through a virtual cable (not in 0.31.0)
        discord?: { available?: boolean; on?: boolean; site?: boolean; hearing?: boolean; where?: Where; cable?: boolean; };
    } | null;
}

const TOPICS: Record<string, keyof AuraState> = { "aura.sounds": "sounds", "aura.effects": "effects", "aura.party": "party" };
export const AURA_TOPICS = Object.keys(TOPICS);
const EMPTY: AuraState = { sounds: null, effects: null, party: null };

let aura = EMPTY;
const listeners = new Set<() => void>();

function changed() {
    listeners.forEach(l => l());
}

// Stores the topic if it is one of aura.txt's
export function setAuraState(topic: string, data: unknown) {
    const key = TOPICS[topic];
    if (!key) return;
    aura = { ...aura, [key]: data && typeof data === "object" ? data : null };
    changed();
}

export function resetAura() {
    aura = EMPTY;
    changed();
}

function useAura() {
    const [, update] = useState(0);
    useEffect(() => {
        const listener = () => update(n => n + 1);
        listeners.add(listener);
        // what came between the first render and this subscription would otherwise stay unseen
        listener();
        return () => void listeners.delete(listener);
    }, []);
    return aura;
}

// What the running aura.txt can do: an older one has none of these commands, and then there is no button
function useSections() {
    const commands = useApps().find(a => a.app === "aura")?.commands ?? [];
    return {
        sounds: commands.includes("sounds.play"),
        effects: commands.includes("effects.set"),
        party: commands.includes("party.start") || commands.includes("party.discord"),
        partyCode: commands.includes("party.start"),
        partyCall: commands.includes("party.discord")
    };
}

type Tab = "sounds" | "effects" | "party";
type Where = "browser" | "window";
const WHERE: { key: Where; label: string; }[] = [{ key: "browser", label: "В браузере" }, { key: "window", label: "В окне aura.txt" }];
const TABS: { key: Tab; label: string; }[] = [{ key: "sounds", label: "Звуки" }, { key: "effects", label: "Эффекты" }, { key: "party", label: "Пати" }];
// the tab last opened, for the next time the deck opens
let lastTab: Tab = "sounds";

// kit.txt palette: a pad keeps its colour, picked by its id
const PAD_COLORS = ["#F08A4B", "#0A84FF", "#6CCB5F", "#FF9F0A", "#8A5CF6", "#FF375F", "#FCE100"];

export function padColor(id: string) {
    let hash = 0;
    for (const c of String(id)) hash = (hash * 31 + c.charCodeAt(0)) | 0;
    return PAD_COLORS[Math.abs(hash) % PAD_COLORS.length];
}

function guests(n: number) {
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return `${n} гость`;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${n} гостя`;
    return `${n} гостей`;
}

function OpenIcon() {
    return (
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <path fill="currentColor" d="M9 2h5v5h-1.5V4.56L7.53 9.53 6.47 8.47l4.97-4.97H9V2ZM3 4h4v1.5H3.5v7h7V9H12v4H2V4h1Z" />
        </svg>
    );
}

// One step of the party through the call: a dot (grey not yet, orange under way, green done) or none at all
function Step({ state, label, note, children }: { state: "idle" | "busy" | "done" | "none"; label: string; note?: string; children?: React.ReactNode; }) {
    return (
        <div className="vc-maska-aura-step">
            <i className="vc-maska-aura-step-dot" data-state={state} aria-hidden="true" />
            <div className="vc-maska-row-text">
                <div>{label}</div>
                {note && <div className="vc-maska-hint">{note}</div>}
            </div>
            {children}
        </div>
    );
}

function AuraDeck({ deckRef, style }: { deckRef: React.RefObject<HTMLDivElement | null>; style: React.CSSProperties; }) {
    const can = useSections();
    const { sounds, effects, party } = useAura();
    const [error, setError] = useState<string | null>(null);
    const [starting, setStarting] = useState(false);
    const [query, setQuery] = useState("");
    const [codeOpen, setCodeOpen] = useState(false);
    const [needUrl, setNeedUrl] = useState(false);
    const [url, setUrl] = useState("");
    const [badUrl, setBadUrl] = useState(false);
    // the variant picked here while the party through the call is off
    const [pick, setPick] = useState<Where | null>(null);
    const tabs = TABS.filter(t => can[t.key]);
    const [tab, setTabState] = useState<Tab>(tabs.some(t => t.key === lastTab) ? lastTab : tabs[0]?.key ?? "sounds");

    function setTab(next: Tab) {
        lastTab = next;
        setTabState(next);
    }

    async function run(name: string, args: object = {}, timeout?: number) {
        setError(null);
        const result = await Native.request("aura", name, args, timeout);
        if (!result.ok) setError(result.error === "timeout" ? "aura.txt не ответила" : String(result.error || "Не получилось"));
        return result;
    }

    // the party window; an address it has not got yet is asked for here
    async function site(open: boolean, address?: string) {
        const result = await run("party.site", address ? { open, url: address } : { open }, 10000);
        if (result.ok) setNeedUrl(false);
        else if (/адрес/i.test(String(result.error))) setNeedUrl(true);
    }

    function openUrl() {
        const address = url.trim();
        setBadUrl(!address.startsWith("https://"));
        if (address.startsWith("https://")) site(true, address);
    }

    async function startParty() {
        setStarting(true);
        // aura.txt waits for the network up to 30 seconds before it answers
        await run("party.start", {}, 35000);
        setStarting(false);
    }

    const playing = sounds?.playing ?? [];
    const pads = sounds?.pads ?? [];
    const activeEffect = effects?.items?.find(e => e.id === effects.active);
    const call = party?.discord;
    // the party through the call comes first; an aura.txt without it shows only the party by code
    const showCall = can.partyCall && call?.available === true;
    const where: Where = call?.on ? call.where ?? "window" : pick ?? call?.where ?? "window";

    // off: only the local choice; on: aura.txt switches over (PROTOCOL.md says nothing of turning it off first)
    function chooseWhere(next: Where) {
        if (!call?.on) setPick(next);
        else if (next !== call.where) run("party.discord", { on: true, where: next }, 10000);
    }
    const busy: Record<Tab, boolean> = { sounds: playing.length > 0, effects: effects?.active != null, party: !!party?.role || !!call?.on };

    const status = [
        activeEffect && `Эффект: ${activeEffect.name}`,
        playing.length > 0 && `Играет: ${pads.filter(p => playing.includes(p.id)).map(p => p.name).join(", ") || playing.length}`,
        party?.role === "host" && `Пати: ${guests(party.people ?? 0)}`,
        party?.role === "guest" && "Пати: вы в гостях",
        call?.on && (call.hearing ? "Пати: сайт слышит звонок" : "Пати: через звонок")
    ].filter(Boolean).join(" · ") || "Готова";

    const noMic = (can.sounds && sounds?.mic === false) || (can.effects && effects?.mic === false);
    const shownPads = pads.length > 8 && query ? pads.filter(p => p.name.toLowerCase().includes(query.toLowerCase())) : pads;
    // from the party tab aura.txt opens on its own party page (versions that do not know the page just open)
    const open = (label = "Открыть aura.txt") => <button className="dt-btn" onClick={() => run("show", { page: "party" })}>{label}</button>;

    return (
        <div ref={deckRef} style={style} className="vc-maska-aura vc-maska-aura-deck" role="dialog" aria-label="aura.txt">
            <div className="vc-maska-aura-head">
                <span className="dt-tile"><PixelIcon app="aura" size={24} /></span>
                <div className="vc-maska-aura-name">
                    <Brand app="aura" />
                    <div className="vc-maska-aura-status">{status}</div>
                </div>
                <button className="dt-btn vc-maska-aura-icon-btn" aria-label="Открыть aura.txt" title="Открыть aura.txt" onClick={() => run("show")}><OpenIcon /></button>
            </div>

            {noMic && <div className="vc-maska-aura-warn">aura.txt не встроена в микрофон — звук слышите только вы</div>}

            {tabs.length > 1 && (
                <div className="dt-seg vc-maska-aura-tabs" role="tablist">
                    {tabs.map(t => (
                        <button key={t.key} role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)}>
                            {t.label}
                            {busy[t.key] && <i className="vc-maska-aura-tab-dot" />}
                        </button>
                    ))}
                </div>
            )}

            <div className="vc-maska-aura-body" key={tab} role="tabpanel">
                {tab === "sounds" && (
                    <>
                        {pads.length > 8 && (
                            <input className="vc-maska-aura-search" type="search" placeholder="Найти звук" value={query} onChange={e => setQuery(e.currentTarget.value)} />
                        )}
                        {!pads.length ? <div className="vc-maska-hint">Пэдов пока нет. Добавьте их в aura.txt</div>
                            : !shownPads.length ? <div className="vc-maska-hint">Ничего не найдено</div>
                                : (
                                    <div className="vc-maska-aura-pads">
                                        {shownPads.map(p => (
                                            <button key={p.id} className="vc-maska-aura-pad" aria-pressed={playing.includes(p.id)} title={p.name} onClick={() => run("sounds.play", { id: p.id })}>
                                                {playing.includes(p.id)
                                                    ? <span className="vc-maska-aura-eq" aria-hidden="true"><i /><i /><i /></span>
                                                    : <span className="vc-maska-aura-swatch" style={{ background: padColor(p.id) }} aria-hidden="true" />}
                                                <span className="vc-maska-aura-pad-name">{p.name}</span>
                                            </button>
                                        ))}
                                    </div>
                                )}
                        {playing.length > 0 && <button className="dt-btn vc-maska-aura-wide" onClick={() => run("sounds.stop")}>Остановить всё</button>}
                    </>
                )}

                {tab === "effects" && (
                    <div className="vc-maska-aura-chips">
                        <button className="vc-maska-aura-chip" aria-pressed={effects?.active == null} onClick={() => run("effects.off")}>Без эффекта</button>
                        {effects?.items?.map(e => (
                            <button
                                key={e.id}
                                className="vc-maska-aura-chip"
                                aria-pressed={effects.active === e.id}
                                title={e.name}
                                onClick={() => effects.active === e.id ? run("effects.off") : run("effects.set", { id: e.id })}
                            >
                                {e.name}
                            </button>
                        ))}
                    </div>
                )}

                {tab === "party" && (
                    <>
                        {showCall && call && (
                            <div className="vc-maska-aura-card vc-maska-aura-card--main vc-maska-aura-call-card">
                                <h4>Через звонок</h4>
                                <div className="vc-maska-hint">Друзья в звонке слышат сайт через демонстрацию, сайт слышит звонок. IP никому не видны</div>
                                {/* aura.txt 0.31.0 has no where: then there is only the party window, without a choice */}
                                {call.where && (
                                    <div className="dt-seg vc-maska-aura-tabs" role="radiogroup" aria-label="Где открыт сайт">
                                        {WHERE.map(w => (
                                            <button key={w.key} role="radio" aria-checked={where === w.key} onClick={() => chooseWhere(w.key)}>{w.label}</button>
                                        ))}
                                    </div>
                                )}
                                {!call.on ? (
                                    where === "browser" && call.cable === false ? (
                                        <div className="vc-maska-aura-step">
                                            <div className="vc-maska-row-text vc-maska-hint">Нужен виртуальный звуковой кабель (VB-Cable) — как поставить, показано в aura.txt</div>
                                            <button className="dt-btn" onClick={() => run("show", { page: "party" })}>Открыть aura.txt</button>
                                        </div>
                                    ) : (
                                        <>
                                            <button className="dt-btn dt-btn--primary vc-maska-aura-wide" disabled={!!party?.role} onClick={() => run("party.discord", call.where ? { on: true, where } : { on: true }, 10000)}>Включить</button>
                                            {party?.role && <div className="vc-maska-hint">Сначала выйдите из пати по коду</div>}
                                        </>
                                    )
                                ) : where === "browser" ? (
                                    <>
                                        <Step state={call.hearing ? "done" : "busy"} label="Звук звонка идёт в кабель" note={call.hearing ? undefined : "Ищу звук Discord…"} />
                                        <Step state="none" label="В браузере выберите микрофоном CABLE Output" note="В настройках сайта или браузера, только для этого сайта" />
                                        <Step state="none" label="Демонстрация браузера со звуком" note="Включите её в Discord сами — так друзья услышат сайт" />
                                        <button className="dt-btn vc-maska-aura-wide" onClick={() => run("party.discord", { on: false }, 10000)}>Выключить</button>
                                    </>
                                ) : (
                                    <>
                                        <Step state={call.site ? "done" : "idle"} label="Окно пати">
                                            {call.site
                                                ? <button className="dt-btn" onClick={() => site(false)}>Закрыть</button>
                                                : <button className="dt-btn" onClick={() => site(true)}>Открыть</button>}
                                        </Step>
                                        {needUrl && !call.site && (
                                            <div className="vc-maska-aura-url">
                                                <div className="vc-maska-aura-row">
                                                    <input className="vc-maska-aura-search" type="url" placeholder="https://…" value={url} onChange={e => { setUrl(e.currentTarget.value); setBadUrl(false); }} onKeyDown={e => e.key === "Enter" && openUrl()} />
                                                    <button className="dt-btn" onClick={openUrl}>Открыть</button>
                                                </div>
                                                {badUrl && <div className="vc-maska-hint">Нужен адрес, начинающийся с https://</div>}
                                            </div>
                                        )}
                                        <Step state={call.hearing ? "done" : call.site ? "busy" : "idle"} label="Сайт слышит звонок" note={call.site && !call.hearing ? "Ищу звук Discord…" : undefined} />
                                        <Step state="none" label="Демонстрация окна пати со звуком" note="Включите её в Discord сами — так друзья услышат сайт" />
                                        <button className="dt-btn vc-maska-aura-wide" onClick={() => run("party.discord", { on: false }, 10000)}>Выключить</button>
                                    </>
                                )}
                            </div>
                        )}

                        {can.partyCode && (
                            <div className="vc-maska-aura-card">
                                {showCall && !party?.role ? (
                                    <button className="vc-maska-aura-fold" aria-expanded={codeOpen} onClick={() => setCodeOpen(v => !v)}>
                                        <h4>По коду</h4>
                                        <span className="vc-maska-aura-unsafe">небезопасно</span>
                                        <span className="vc-maska-aura-chevron" aria-hidden="true" />
                                    </button>
                                ) : <h4>По коду</h4>}
                                {(!showCall || !!party?.role || codeOpen) && (
                                    <>
                                        {/* a party by code connects the computers directly, whatever the aura.txt version says about it */}
                                        <div className="vc-maska-aura-warn">Небезопасно: участники видят IP-адреса друг друга</div>
                                        {party?.role === "host" ? (
                                            <div className="vc-maska-aura-party">
                                                <div className="vc-maska-aura-code" aria-label={`Код: ${party.code ?? ""}`}>
                                                    {[...(party.code ?? "")].map((c, i) => <span key={i}>{c}</span>)}
                                                </div>
                                                <div className="vc-maska-aura-pair">
                                                    <button className="dt-btn" onClick={() => { setError(null); copyWithToast(party.code ?? "", "Код скопирован"); }}>Скопировать</button>
                                                    <button className="dt-btn" onClick={() => { setError(null); insertTextIntoChatInputBox(party.code ?? ""); }}>В чат</button>
                                                </div>
                                                <div className="vc-maska-aura-status">Гостей: {party.people ?? 0}</div>
                                                {party.asking?.map(p => (
                                                    <div className="vc-maska-aura-asking" key={p.id}>
                                                        <span className="vc-maska-aura-avatar" aria-hidden="true">{p.name.trim().charAt(0).toUpperCase() || "?"}</span>
                                                        <span className="vc-maska-row-text">{p.name}</span>
                                                        <button className="dt-btn dt-btn--primary" onClick={() => run("party.answer", { id: p.id, ok: true })}>Впустить</button>
                                                        <button className="dt-btn" onClick={() => run("party.answer", { id: p.id, ok: false })}>Отклонить</button>
                                                    </div>
                                                ))}
                                                <div className="vc-maska-aura-note">
                                                    <span>Что слышат гости, выбирается в aura.txt</span>
                                                    <button className="vc-maska-aura-link" onClick={() => run("show", { page: "party" })}>Открыть</button>
                                                </div>
                                                <button className="dt-btn vc-maska-aura-wide vc-maska-aura-danger" onClick={() => run("party.stop")}>Остановить</button>
                                            </div>
                                        ) : party?.role === "guest" ? (
                                            <div className="vc-maska-aura-party">
                                                <div>Вы в пати</div>
                                                <div className="vc-maska-aura-pair">
                                                    <button className="dt-btn" onClick={() => run("party.stop")}>Выйти</button>
                                                    {open()}
                                                </div>
                                            </div>
                                        ) : party?.canHost === false ? (
                                            <div className="vc-maska-aura-party">
                                                <div className="vc-maska-hint">Пати не создать: aura.txt не встроена в микрофон</div>
                                                {open()}
                                            </div>
                                        ) : (
                                            <div className="vc-maska-aura-party">
                                                <div className="vc-maska-hint">Слушайте и смотрите вместе с друзьями по коду</div>
                                                <button className="dt-btn dt-btn--primary vc-maska-aura-wide" disabled={starting || !!call?.on} onClick={startParty}>{starting ? "Создаётся…" : "Начать пати"}</button>
                                                {call?.on && <div className="vc-maska-hint">Сначала выключите пати через звонок</div>}
                                                {party?.enabled === false && <div className="vc-maska-hint">Раздел «Пати» в aura.txt включится сам</div>}
                                            </div>
                                        )}
                                    </>
                                )}
                            </div>
                        )}
                    </>
                )}
            </div>

            {error && <div className="vc-maska-aura-error">{error}</div>}
        </div>
    );
}

// The aura.txt button in the voice panel, a fifth one after camera, screen, activities and soundboard.
// It looks like them because it wears the classes of the first of them; a dot while something is on.
// It lives in a React root of its own, outside Discord's tree, so Discord's Popout and Tooltip, which need the
// app's layers and providers, do not work here: the deck is our own layer, a portal into body
function AuraCallButton({ className }: { className: string; }) {
    const can = useSections();
    const { sounds, effects, party } = useAura();
    const button = useRef<HTMLButtonElement>(null);
    const deck = useRef<HTMLDivElement>(null);
    const [shown, setShown] = useState(false);
    const [place, setPlace] = useState<{ left: number; top: number; origin: string; } | null>(null);

    // above the button, its right edge on the right edge of the voice panel, never past the window (8 px off)
    function position() {
        const b = button.current?.getBoundingClientRect();
        const d = deck.current;
        if (!b || !d) return;
        const panel = button.current?.closest('section[class*="panels_"]')?.getBoundingClientRect() ?? b;
        const left = Math.max(8, Math.min(panel.right - d.offsetWidth, innerWidth - 8 - d.offsetWidth));
        const top = Math.max(8, b.top - 8 - d.offsetHeight);
        setPlace({ left, top, origin: `${b.left + b.width / 2 - left}px bottom` });
    }

    useLayoutEffect(() => {
        if (!shown) return;
        position();
        deck.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"], button, input')?.focus();

        const resize = new ResizeObserver(position);
        if (deck.current) resize.observe(deck.current);
        const outside = (e: PointerEvent) => {
            const t = e.target as Node;
            if (!deck.current?.contains(t) && !button.current?.contains(t)) setShown(false);
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
            if (button.current?.isConnected) button.current.focus();
        };
    }, [shown]);

    if (!can.sounds && !can.effects && !can.party) return null;
    const busy = effects?.active != null || !!sounds?.playing?.length || !!party?.role || !!party?.discord?.on;

    return (
        <>
            <button
                ref={button}
                className={`${className} vc-maska-aura-call`}
                aria-label="aura.txt"
                title={shown ? undefined : "aura.txt"}
                aria-expanded={shown}
                onClick={() => setShown(v => !v)}
            >
                <span className="vc-maska-aura-icon">
                    <PixelIcon app="aura" size={20} />
                    {busy && <i className="vc-maska-aura-dot" />}
                </span>
            </button>
            {shown && layer && ReactDOM.createPortal(
                <AuraDeck
                    deckRef={deck}
                    style={place
                        ? { left: place.left, top: place.top, transformOrigin: place.origin }
                        : { left: 0, top: 0, visibility: "hidden" }}
                />,
                layer
            )}
        </>
    );
}

// The button in the row of the voice panel: the slot sits there while the row is (Discord builds it anew on
// joining a call) and is taken out when the row is gone (left the call); keepSlot in slot.ts does the watching
let stopSlot: (() => void) | null = null;
// the layer the deck is drawn in, over Discord's columns and level with its popups
let layer: HTMLElement | null = null;

export function mountAuraCall() {
    if (stopSlot) return;
    try {
        layer = document.body.appendChild(document.createElement("div"));
        layer.className = "vc-maska-aura vc-maska-aura-layer";
        stopSlot = keepSlot({
            tag: "span",
            className: "vc-maska-aura-slot",
            find: panels => panels.querySelector('[class*="actionButtons_"]'),
            render: row => {
                const first = row.querySelector(":scope > button, :scope > div > button");
                return <ErrorBoundary noop><AuraCallButton className={first?.className ?? ""} /></ErrorBoundary>;
            }
        });
    } catch {
        unmountAuraCall();
    }
}

export function unmountAuraCall() {
    stopSlot?.();
    stopSlot = null;
    layer?.remove();
    layer = null;
}
