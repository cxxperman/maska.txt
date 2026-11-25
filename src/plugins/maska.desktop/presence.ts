/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { PluginNative } from "@utils/types";
import { Activity } from "@vencord/discord-types";
import { ActivityFlags, ActivityStatusDisplayType, ActivityType } from "@vencord/discord-types/enums";
import { ApplicationAssetUtils, FluxDispatcher, PresenceStore, UserStore } from "@webpack/common";

import { Media, playerName } from "./links";

const Native = VencordNative.pluginHelpers.Maska as PluginNative<typeof import("./native")>;

// The application MusicRichPresence uses: a local activity needs one, and its own name is replaced by ours
const APP_ID = "1108588077900898414";
// When Apple Music does not have the track: the maska, from this repository, instead of Discord's "?"
const NO_COVER = "https://raw.githubusercontent.com/cxxperman/maska.txt/main/src/plugins/maska.desktop/presence-cover.png";
const SOCKET = "Maska";

let shown = false;
// a newer track (or a pause) while the cover is still being looked up wins
let turn = 0;

function dispatch(activity: Activity | null) {
    FluxDispatcher.dispatch({ type: "LOCAL_ACTIVITY_UPDATE", activity, socketId: SOCKET });
}

export function clearPresence() {
    turn++;
    if (!shown) return;
    shown = false;
    dispatch(null);
}

// "Listening to Apple Music": the track, the artist, the time (Discord draws the bar from it) and the cover.
// Only on a kapsula.media message, never on a timer; paused or nothing playing, the activity goes
// Spotify connected to Discord shows its own "Listening to Spotify", with the right cover and "listen along":
// ours would only be a second one
function spotifyShown() {
    try {
        const me = UserStore.getCurrentUser()?.id;
        return !!me && (PresenceStore.getActivities(me) ?? []).some((a: Activity) => a?.name === "Spotify" && a.application_id !== APP_ID);
    } catch {
        return false;
    }
}

export async function updatePresence(m: Media | null) {
    if (!m?.playing || !m.title) return clearPresence();
    if (/spotify/i.test(m.app ?? "") && spotifyShown()) return clearPresence();
    // Cider sets its own status, with the exact cover it plays: ours would only be a second one
    if (/cider/i.test(m.app ?? "")) return clearPresence();
    const mine = ++turn;
    const name = m.app ? playerName(m.app) : "Музыка";

    let largeImage: string | undefined;
    try {
        // Discord takes no data: URL, only an address it can fetch itself: the cover is looked up in iTunes
        const url = await Native.artwork(m.artist, m.title, m.album, m.duration ?? 0);
        if (mine !== turn) return;
        largeImage = (await ApplicationAssetUtils.fetchAssetIds(APP_ID, [url ?? NO_COVER]))[0];
    } catch { }
    if (mine !== turn) return;

    const start = m.duration && m.position != null && m.positionAt != null ? m.positionAt - m.position * 1000 : null;
    dispatch({
        application_id: APP_ID,
        name,
        details: m.title,
        state: m.artist || undefined,
        type: ActivityType.LISTENING,
        // the member list and the account panel say the track ("Слушает Burn This Shit Down"), not the player
        status_display_type: ActivityStatusDisplayType.DETAILS,
        flags: ActivityFlags.INSTANCE,
        timestamps: start != null ? { start, end: start + m.duration! * 1000 } : undefined,
        assets: largeImage ? { large_image: largeImage, large_text: name } : undefined
    } as Activity);
    shown = true;
}
