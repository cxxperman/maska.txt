/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { PluginNative } from "@utils/types";
import { Popout, useEffect, useRef, useState } from "@webpack/common";

import { useBlink, useDeaf } from "./peek";
import { PixelIcon } from "./sprites";

const Native = VencordNative.pluginHelpers.Maska as PluginNative<typeof import("./native")>;

// hub.apps: the dev.txt apps connected to the hub right now
interface HubApp {
    app: string;
    name?: string;
    commands?: string[];
}

let apps: HubApp[] = [];
const listeners = new Set<() => void>();

export const getApps = () => apps;

export function setApps(list: unknown) {
    apps = Array.isArray(list) ? list.filter(a => typeof a?.app === "string") : [];
    listeners.forEach(l => l());
}

export function useApps() {
    const [, update] = useState(0);
    useEffect(() => {
        const listener = () => update(n => n + 1);
        listeners.add(listener);
        // what came between the first render and this subscription would otherwise stay unseen
        listener();
        return () => void listeners.delete(listener);
    }, []);
    return apps;
}

function show(app: string, args: object = {}) {
    Native.request(app, "show", args);
}

// The product name as kit.txt writes it: maska.txt™
export function Brand({ app }: { app: string; }) {
    return <span className="dt-brand">{app}<i>.txt</i><sup>™</sup></span>;
}

// The family as the hub sees it, without Maska itself, and core.txt at the bottom
export function FamilyList() {
    const list = useApps();
    if (!list.length) return <div className="dt-row">core.txt не запущен</div>;

    const others = list.filter(a => a.app !== "maska" && a.app !== "core");
    return (
        <div className="vc-maska-list">
            {others.map(a => (
                <div className="dt-row" key={a.app}>
                    <PixelIcon app={a.app} size={20} />
                    <div className="vc-maska-row-text"><Brand app={a.app} /></div>
                    {a.commands?.includes("show") && <button className="dt-btn" onClick={() => show(a.app)}>Открыть</button>}
                </div>
            ))}
            <div className="dt-row">
                <PixelIcon app="core" size={20} />
                <div className="vc-maska-row-text">Открыть core.txt</div>
                <button className="dt-btn" onClick={() => show("core", { page: "app:maska" })}>Открыть</button>
            </div>
        </div>
    );
}

// The family button in Discord's title bar, with the family in a popout under it
export function FamilyButton() {
    const ref = useRef<HTMLButtonElement>(null);
    const [shown, setShown] = useState(false);
    // the same life as the maska behind the edge, simpler: it blinks, and its eyes are shut while deafened
    const blink = useBlink();
    const deaf = useDeaf();

    return (
        <Popout
            position="bottom"
            align="right"
            animation={Popout.Animation.NONE}
            shouldShow={shown}
            onRequestClose={() => setShown(false)}
            targetElementRef={ref}
            renderPopout={() => (
                <div className="vc-maska-page vc-maska-popout">
                    <FamilyList />
                </div>
            )}
        >
            {() => (
                <button ref={ref} className="vc-maska-family" aria-expanded={shown} onClick={() => setShown(v => !v)}>
                    <PixelIcon size={16} eye={blink || deaf ? "closed" : "normal"} />
                    <Brand app="maska" />
                </button>
            )}
        </Popout>
    );
}
