/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { createRoot } from "@webpack/common";
import type { ReactNode } from "react";

interface SlotOptions {
    tag: string;
    className: string;
    // where in the panel at the bottom left the slot goes; null while that place is not there
    find(panels: Element): Element | null;
    first?: boolean;
    render(parent: Element): ReactNode;
}

// Keeps an element of ours inside the panel at the bottom left (voice, profile), which Discord builds anew now
// and then: one slot and one React root, moved into its place whenever the place is there and taken out when it
// is gone. One MutationObserver, on the sidebar that holds the panel or on body until the panel shows up; a slow
// check notices a sidebar replaced as a whole. Returns the function that takes it all down again
export function keepSlot(o: SlotOptions) {
    const slot = document.createElement(o.tag);
    slot.className = o.className;
    const root = createRoot(slot);
    let watched: Element | null = null;
    let scheduled = false;
    let stopped = false;

    const observer = new MutationObserver(schedule);

    function place() {
        scheduled = false;
        if (stopped) return;

        const panels = document.querySelector('section[class*="panels_"]');
        const target = panels?.parentElement ?? document.body;
        if (target !== watched) {
            observer.disconnect();
            observer.observe(target, { childList: true, subtree: true });
            watched = target;
        }

        const parent = panels ? o.find(panels) : null;
        if (parent) {
            if ((o.first ? parent.firstElementChild : parent.lastElementChild) === slot) return;
            if (o.first) parent.prepend(slot);
            else parent.append(slot);
            root.render(o.render(parent));
        } else if (slot.isConnected) {
            slot.remove();
            root.render(null);
        }
    }

    function schedule() {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(place);
    }

    const safety = setInterval(() => watched?.isConnected || schedule(), 3000);
    place();

    return () => {
        stopped = true;
        observer.disconnect();
        clearInterval(safety);
        root.unmount();
        slot.remove();
    };
}
