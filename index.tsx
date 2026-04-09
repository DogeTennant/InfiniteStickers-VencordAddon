/**
 * Vencord Plugin: InfiniteStickers
 *
 * Stickers live in a GitHub repo. When you send one:
 *   1. GIF is fetched from GitHub raw URL
 *   2. Uploaded as a real sticker to your transit server
 *   3. Sent as a real sticker message in the target channel
 *   4. Deleted from the transit server once the rolling slot window fills
 *
 * Place at: src/plugins/infiniteStickers/index.tsx
 * Requires: ChatInputButtonAPI
 */

import { addChatBarButton, removeChatBarButton } from "@api/ChatButtons";
import * as DataStore from "@api/DataStore";
import { definePluginSettings } from "@api/Settings";
import {
    ModalCloseButton,
    ModalContent,
    ModalHeader,
    ModalRoot,
    ModalSize,
    openModal,
} from "@utils/modal";
import definePlugin, { OptionType } from "@utils/types";
import { findByPropsLazy } from "@webpack";
import {
    Button,
    React,
    Text,
    TextInput,
    Tooltip,
    useEffect,
    useMemo,
    useState,
} from "@webpack/common";

//  Discord internals 

const MessageActions    = findByPropsLazy("sendMessage", "sendStickers");
const TokenStore        = findByPropsLazy("getToken");
const PendingReplyStore = findByPropsLazy("getPendingReply");
const Dispatcher        = findByPropsLazy("dispatch", "subscribe");
const DraftStore        = findByPropsLazy("getDraft");

//  Constants & types 

const QUEUE_KEY = "InfiniteStickers_queue_v1";
const CACHE_KEY = "InfiniteStickers_cache_v1";
const FREQ_KEY  = "InfiniteStickers_freq_v1";

let _pendingText    = "";  // text in our compose bar, immune to React closure staleness
let _stagedSticker: ManifestSticker | null = null;  // sticker staged to real chat input
let _stagedChannel  = "";  // channel the staged sticker belongs to

// Simple pub/sub so the chat bar indicator can react to staged sticker changes
const _stagedListeners = new Set<() => void>();
function notifyStaged() { _stagedListeners.forEach(fn => fn()); }

interface ManifestSticker {
    name:     string;
    category: string;
    tags:     string;
    url:      string;
}

//  Plugin settings 

const settings = definePluginSettings({
    manifestUrl: {
        type:        OptionType.STRING,
        description: "Raw GitHub URL to your stickers.json",
        default:     "",
    },
    transitGuildId: {
        type:        OptionType.STRING,
        description: "Guild ID of your transit server",
        default:     "",
    },
    transitSlots: {
        type:        OptionType.NUMBER,
        description: "How many sticker slots your transit server has (5 = no boost, 15 = level 1, etc.)",
        default:     5,
    },
});

//  Discord REST helpers 

function authHeader(): Record<string, string> {
    return { Authorization: TokenStore.getToken() };
}

async function uploadTransitSticker(name: string, blob: Blob): Promise<{ id: string }> {
    const guildId = settings.store.transitGuildId;
    if (!guildId) throw new Error("No transit guild ID set in plugin settings.");

    const form = new FormData();
    form.append("name", name.slice(0, 30).padEnd(2, "_"));
    form.append("tags", "🎭");
    form.append("file", new File([blob], "sticker.gif", { type: blob.type || "image/gif" }));

    const res = await fetch(`https://discord.com/api/v10/guilds/${guildId}/stickers`, {
        method:  "POST",
        headers: authHeader(),
        body:    form,
    });

    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(`Sticker upload failed (${res.status}): ${err.message ?? JSON.stringify(err)}`);
    }

    return res.json();
}

async function deleteTransitSticker(stickerId: string): Promise<void> {
    const guildId = settings.store.transitGuildId;
    if (!guildId) return;
    await fetch(`https://discord.com/api/v10/guilds/${guildId}/stickers/${stickerId}`, {
        method:  "DELETE",
        headers: authHeader(),
    }).catch(console.error);
}

//  Rolling slot queue 

async function getQueue(): Promise<string[]> {
    return (await DataStore.get<string[]>(QUEUE_KEY)) ?? [];
}

//  Frequency tracking 

async function incrementUseCount(url: string): Promise<void> {
    const freq = (await DataStore.get<Record<string, number>>(FREQ_KEY)) ?? {};
    freq[url] = (freq[url] ?? 0) + 1;
    await DataStore.set(FREQ_KEY, freq);
}

async function getFrequentStickers(stickers: ManifestSticker[], limit = 20): Promise<ManifestSticker[]> {
    const freq      = (await DataStore.get<Record<string, number>>(FREQ_KEY)) ?? {};
    const validUrls = new Set(stickers.map(s => s.url));
    return stickers
        .filter(s => freq[s.url] && validUrls.has(s.url))
        .sort((a, b) => (freq[b.url] ?? 0) - (freq[a.url] ?? 0))
        .slice(0, limit);
}

//  Manifest 

async function fetchManifest(bustCache = false): Promise<ManifestSticker[]> {
    const url = settings.store.manifestUrl;
    if (!url) return [];

    if (!bustCache) {
        const cached = await DataStore.get<ManifestSticker[]>(CACHE_KEY);
        if (cached?.length) return cached;
    }

    const res = await fetch(`${url}?t=${Date.now()}`);
    if (!res.ok) throw new Error(`Failed to fetch manifest: ${res.status}`);
    const data: ManifestSticker[] = await res.json();
    await DataStore.set(CACHE_KEY, data);
    return data;
}

//  Core send 

async function doSend(
    channelId: string,
    sticker:   ManifestSticker,
    text:      string,
    onStatus:  (msg: string) => void
): Promise<void> {
    const slots = settings.store.transitSlots || 5;
    const queue = await getQueue();

    if (queue.length >= slots) {
        onStatus("Clearing old slot…");
        const oldest = queue.shift()!;
        await deleteTransitSticker(oldest);
        await DataStore.set(QUEUE_KEY, queue);
    }

    const pendingReply = PendingReplyStore.getPendingReply(channelId);

    onStatus("Fetching sticker…");
    const gifRes = await fetch(sticker.url);
    if (!gifRes.ok) throw new Error(`Could not download sticker GIF (${gifRes.status})`);
    const blob = await gifRes.blob();

    onStatus("Uploading to transit server…");
    const uploaded = await uploadTransitSticker(sticker.name, blob);

    onStatus("Sending…");
    const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
        method:  "POST",
        headers: { ...authHeader(), "Content-Type": "application/json" },
        body: JSON.stringify({
            content:           text.trim() || undefined,
            sticker_ids:       [uploaded.id],
            message_reference: pendingReply ? {
                message_id: pendingReply.message.id,
                channel_id: channelId,
                guild_id:   pendingReply.message.guild_id,
            } : undefined,
            allowed_mentions: {
                parse:        ["users", "roles", "everyone"],
                replied_user: pendingReply ? !pendingReply.shouldMention : undefined,
            },
        }),
    });

    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(`Send failed (${res.status}): ${err.message ?? JSON.stringify(err)}`);
    }

    if (pendingReply) {
        try { Dispatcher.dispatch({ type: "DELETE_PENDING_REPLY", channelId }); } catch {}
    }

    queue.push(uploaded.id);
    await DataStore.set(QUEUE_KEY, queue);
    await incrementUseCount(sticker.url);
    onStatus("");
}

//  Staged sticker keydown handler 
//
// When a sticker is staged to the real chat input, this listener fires before
// Discord handles Enter, reads the draft text, and sends sticker + text together.

async function handleStagedEnter(e: KeyboardEvent) {
    if (e.key !== "Enter" || e.shiftKey || !_stagedSticker) return;

    // Only fire when focus is inside Discord's Slate chat editor
    const active = document.activeElement;
    if (!active) return;
    const isEditor = active.closest("[data-slate-editor]") ||
                     active.getAttribute("role") === "textbox" ||
                     active.closest("[role='textbox']");
    if (!isEditor) return;

    e.preventDefault();
    e.stopImmediatePropagation();

    const sticker   = _stagedSticker;
    const channelId = _stagedChannel;
    _stagedSticker  = null;
    _stagedChannel  = "";
    notifyStaged();

    // Read the current draft text from Discord's store
    let text = "";
    try { text = DraftStore.getDraft(channelId, 0) ?? ""; } catch {}

    // Clear the draft from the input box
    try {
        Dispatcher.dispatch({ type: "DRAFT_SAVE", channelId, draft: "", draftType: 0 });
    } catch {}

    // Upload and send — errors are silent here since we've already closed the modal;
    // a future improvement could show a toast notification on failure
    try {
        await doSend(channelId, sticker, text, () => {});
    } catch (err) {
        console.error("[InfiniteStickers] Staged send failed:", err);
    }
}

//  Staged sticker indicator in chat bar 
//
// Shows a small pill next to the sticker button when a sticker is staged,
// so you know it's waiting. Click × to cancel.

function StagedStickerIndicator({ channel }: { channel: { id: string } }) {
    const [staged, setStaged] = useState<ManifestSticker | null>(_stagedSticker);

    useEffect(() => {
        function update() { setStaged(_stagedSticker); }
        _stagedListeners.add(update);
        return () => { _stagedListeners.delete(update); };
    }, []);

    // Only show for the channel this sticker is staged to
    if (!staged || _stagedChannel !== channel.id) return null;

    return (
        <div style={{
            display:      "flex",
            alignItems:   "center",
            gap:          "4px",
            background:   "var(--brand-experiment)",
            borderRadius: "12px",
            padding:      "2px 8px 2px 4px",
            marginRight:  "4px",
            fontSize:     "12px",
            color:        "#fff",
            cursor:       "default",
            maxWidth:     "160px",
        }}>
            <img
                src={staged.url}
                style={{ width: "20px", height: "20px", objectFit: "contain", borderRadius: "2px", flexShrink: 0 }}
            />
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
                {staged.name}
            </span>
            <span
                style={{ cursor: "pointer", marginLeft: "2px", opacity: 0.8, fontWeight: "bold" }}
                onClick={() => { _stagedSticker = null; _stagedChannel = ""; notifyStaged(); }}
            >
                ×
            </span>
        </div>
    );
}

//  Picker modal 

function StickerPickerModal({
    modalProps,
    channelId,
}: {
    modalProps: any;
    channelId:  string;
}) {
    const [stickers,     setStickers]     = useState<ManifestSticker[]>([]);
    const [freqStickers, setFreqStickers] = useState<ManifestSticker[]>([]);
    const [search,       setSearch]       = useState("");
    const [activeCat,    setActiveCat]    = useState<string | null>("Frequently Used");
    const [status,       setStatus]       = useState("Loading…");
    const [sending,      setSending]      = useState(false);
    const [error,        setError]        = useState("");
    const [pending,      setPending]      = useState<ManifestSticker | null>(null);
    const [pendingText,  setPendingText]  = useState("");
    const pendingTextRef                  = React.useRef("");
    useEffect(() => { pendingTextRef.current = pendingText; }, [pendingText]);
    const [deleteMode,   setDeleteMode]   = useState(false);
    const [deleted,      setDeleted]      = useState<Set<string>>(new Set());

    useEffect(() => {
        fetchManifest()
            .then(async data => {
                setStickers(data);
                const freq = await getFrequentStickers(data);
                setFreqStickers(freq);
                if (freq.length === 0) setActiveCat("All");
                setStatus("");
            })
            .catch(e => { setStatus(""); setError(`Failed to load manifest: ${e.message}`); });
    }, []);

    const categories = useMemo(
        () => [
            "All",
            ...(freqStickers.length ? ["Frequently Used"] : []),
            ...Array.from(new Set(stickers.map(s => s.category))).sort(),
        ],
        [stickers, freqStickers]
    );

    const visible = useMemo(() => {
        const q = search.toLowerCase();
        // If searching, always look through all stickers regardless of active category
        if (q) {
            return stickers.filter(s => {
                if (deleted.has(s.url)) return false;
                return s.name.toLowerCase().includes(q) || s.tags.toLowerCase().includes(q);
            });
        }
        if (activeCat === "Frequently Used") return freqStickers.filter(s => !deleted.has(s.url));
        return stickers.filter(s => {
            if (deleted.has(s.url)) return false;
            const catOk = !activeCat || activeCat === "All" || s.category === activeCat;
            return catOk;
        });
    }, [stickers, freqStickers, search, activeCat, deleted]);

    async function handleRefresh() {
        setStatus("Refreshing…");
        setError("");
        try {
            const data = await fetchManifest(true);
            setStickers(data);
            const freq = await getFrequentStickers(data);
            setFreqStickers(freq);
            setStatus("");
        } catch (e: any) {
            setError(`Refresh failed: ${e.message}`);
            setStatus("");
        }
    }

    function handleDelete(url: string) {
        setDeleted(prev => new Set([...prev, url]));
    }

    //  Normal send (from compose bar) 
    async function handleSendPending() {
        if (!pending || sending) return;
        const text = _pendingText;
        setSending(true);
        setError("");
        try {
            await doSend(channelId, pending, text, msg => setStatus(msg));
            modalProps.onClose();
        } catch (err: any) {
            setError(err.message ?? "Something went wrong.");
            setStatus("");
            setSending(false);
        }
    }

    //  Stage to real chat input (for @mentions) 
    function handleStageToChat() {
        if (!pending) return;
        _stagedSticker = pending;
        _stagedChannel = channelId;
        notifyStaged();
        modalProps.onClose();
        // Focus the Discord chat input so the user can start typing immediately
        try {
            (document.querySelector("[data-slate-editor]") as HTMLElement)?.focus();
        } catch {}
    }

    //  Styles 

    const S = {
        root:    { display: "flex", flexDirection: "column" as const, height: "520px" },
        toolbar: { display: "flex", gap: "8px", alignItems: "center", padding: "12px 16px 8px", flexShrink: 0 },
        body:    { display: "flex", flex: 1, overflow: "hidden" },
        sidebar: {
            width: "150px", flexShrink: 0, overflowY: "auto" as const,
            borderRight: "1px solid var(--background-modifier-accent)",
            padding: "8px 4px", display: "flex", flexDirection: "column" as const, gap: "2px",
        },
        catBtn: (active: boolean) => ({
            background: active ? "var(--brand-experiment)" : "transparent",
            color:      active ? "#fff" : "#b5bac1",
            border: "none", borderRadius: "4px", padding: "6px 10px",
            textAlign: "left" as const, cursor: "pointer", fontSize: "13px",
            width: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const,
        }),
        grid: {
            flex: 1, overflowY: "auto" as const, padding: "8px",
            display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(112px, 1fr))",
            gap: "8px", alignContent: "start",
        },
        card: (dim: boolean, del: boolean) => ({
            display: "flex", flexDirection: "column" as const, alignItems: "center",
            gap: "4px", padding: "8px", borderRadius: "8px", cursor: "pointer",
            opacity: dim ? 0.5 : 1,
            border: del ? "1px solid var(--status-danger)" : "1px solid transparent",
            transition: "background 0.1s", position: "relative" as const,
        }),
        img:      { width: "96px", height: "96px", objectFit: "contain" as const, borderRadius: "4px", pointerEvents: "none" as const },
        label:    { fontSize: "11px", color: "var(--text-muted)", textAlign: "center" as const, width: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const },
        delBadge: { position: "absolute" as const, top: "4px", right: "4px", background: "var(--status-danger)", color: "#fff", borderRadius: "50%", width: "16px", height: "16px", fontSize: "11px", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: "bold" },
        footer:   { padding: "8px 16px", borderTop: "1px solid var(--background-modifier-accent)", display: "flex", flexDirection: "column" as const, gap: "6px", flexShrink: 0 },
    };

    function StickerCard({ s }: { s: ManifestSticker }) {
        const [hovered, setHovered] = useState(false);
        const isSelected = pending?.url === s.url;
        return (
            <Tooltip text={`${s.name}  ·  ${s.category}`}>
                {({ onMouseEnter, onMouseLeave }) => (
                    <div
                        style={{
                            ...S.card(sending && !isSelected, deleteMode),
                            background: isSelected ? "var(--brand-experiment-15a)" : hovered ? "var(--background-modifier-hover)" : "transparent",
                            outline: isSelected ? "2px solid var(--brand-experiment)" : "none",
                        }}
                        onMouseEnter={e => { setHovered(true); onMouseEnter(); }}
                        onMouseLeave={e => { setHovered(false); onMouseLeave(); }}
                        onClick={() => {
                            if (deleteMode) {
                                handleDelete(s.url);
                            } else {
                                setPending(s);
                                setPendingText("");
                                _pendingText = "";
                            }
                        }}
                    >
                        {deleteMode && <div style={S.delBadge}>×</div>}
                        <img src={s.url} alt={s.name} style={S.img} loading="lazy" />
                        <span style={S.label}>{s.name}</span>
                    </div>
                )}
            </Tooltip>
        );
    }

    const missingConfig = !settings.store.manifestUrl || !settings.store.transitGuildId;

    return (
        <ModalRoot {...modalProps} size={ModalSize.LARGE}>
            <ModalHeader separator={false}>
                <Text variant="heading-lg/semibold" style={{ flex: 1 }}>
                    Infinite Stickers {stickers.length > 0 && `(${stickers.length})`}
                </Text>
                <Tooltip text="Re-fetch manifest from GitHub">
                    {({ onMouseEnter, onMouseLeave }) => (
                        <Button size={Button.Sizes.SMALL} look={Button.Looks.LINK} onClick={handleRefresh} onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave} style={{ marginRight: 4 }}>↻</Button>
                    )}
                </Tooltip>
                <Tooltip text={deleteMode ? "Exit delete mode" : "Hide stickers from picker"}>
                    {({ onMouseEnter, onMouseLeave }) => (
                        <Button
                            size={Button.Sizes.SMALL}
                            color={deleteMode ? Button.Colors.RED : Button.Colors.PRIMARY}
                            look={deleteMode ? Button.Looks.FILLED : Button.Looks.LINK}
                            onClick={() => setDeleteMode(d => !d)}
                            onMouseEnter={onMouseEnter}
                            onMouseLeave={onMouseLeave}
                            style={{ marginRight: 8 }}
                        >🗑</Button>
                    )}
                </Tooltip>
                <ModalCloseButton onClick={modalProps.onClose} />
            </ModalHeader>

            <ModalContent style={{ padding: 0 }}>
                {missingConfig ? (
                    <div style={{ padding: "24px", display: "flex", flexDirection: "column", gap: "12px" }}>
                        <Text variant="heading-md/semibold" style={{ color: "var(--status-warning)" }}>⚠ Plugin not configured yet</Text>
                        <Text variant="text-sm/normal">Go to <strong>Settings → Plugins → InfiniteStickers</strong> and fill in:</Text>
                        <Text variant="text-sm/normal" style={{ color: "var(--text-muted)" }}>
                            • <strong>Manifest URL</strong> — the raw GitHub URL to your stickers.json<br />
                            • <strong>Transit Guild ID</strong> — the server ID of your transit server<br />
                            • <strong>Transit Slots</strong> — sticker slots in that server (default 5)
                        </Text>
                    </div>
                ) : (
                    <div style={S.root}>
                        <div style={S.toolbar}>
                            <TextInput value={search} onChange={setSearch} placeholder="Search stickers…" style={{ flex: 1 }} />
                        </div>

                        <div style={S.body}>
                            <div style={S.sidebar}>
                                {categories.map(cat => (
                                    <button key={cat} style={S.catBtn(activeCat === cat || (cat === "All" && !activeCat))} onClick={() => setActiveCat(cat === "All" ? null : cat)} title={cat}>
                                        {cat}
                                    </button>
                                ))}
                            </div>

                            <div style={S.grid}>
                                {visible.length === 0 && !status && (
                                    <Text variant="text-sm/normal" style={{ color: "var(--text-muted)", gridColumn: "1/-1", textAlign: "center", paddingTop: "48px" }}>
                                        {stickers.length === 0 ? "No stickers loaded." : "No matches for your search."}
                                    </Text>
                                )}
                                {status && stickers.length === 0 && (
                                    <Text variant="text-sm/normal" style={{ color: "var(--text-muted)", gridColumn: "1/-1", textAlign: "center", paddingTop: "48px" }}>
                                        ⏳ {status}
                                    </Text>
                                )}
                                {visible.map((s, i) => <StickerCard key={i} s={s} />)}
                            </div>
                        </div>

                        <div style={S.footer}>
                            {pending ? (
                                <div style={{ display: "flex", flexDirection: "column", gap: "8px", width: "100%" }}>
                                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                                        <img src={pending.url} style={{ width: "36px", height: "36px", objectFit: "contain", borderRadius: "4px", flexShrink: 0 }} />
                                        <Text variant="text-sm/normal" style={{ color: "#b5bac1", flex: 1 }}>{pending.name}</Text>
                                        <Button size={Button.Sizes.SMALL} look={Button.Looks.LINK} onClick={() => { setPending(null); setPendingText(""); _pendingText = ""; }} style={{ color: "var(--text-muted)", padding: "0 4px" }}>✕</Button>
                                    </div>
                                    <div style={{ display: "flex", gap: "8px" }}>
                                        <input
                                            id="infinite-stickers-text-input"
                                            value={pendingText}
                                            onChange={e => {
                                                _pendingText = e.currentTarget.value;
                                                setPendingText(e.currentTarget.value);
                                                pendingTextRef.current = e.currentTarget.value;
                                            }}
                                            placeholder="Add a message… (optional)"
                                            style={{
                                                flex: 1, background: "var(--input-background)",
                                                border: "1px solid var(--background-modifier-accent)",
                                                borderRadius: "4px", padding: "6px 10px",
                                                color: "#b5bac1", fontSize: "14px", outline: "none",
                                            }}
                                            autoFocus
                                            onKeyDown={async (e: React.KeyboardEvent) => {
                                                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); await handleSendPending(); }
                                                if (e.key === "Escape") { setPending(null); setPendingText(""); pendingTextRef.current = ""; _pendingText = ""; }
                                            }}
                                        />
                                        <Button size={Button.Sizes.SMALL} color={Button.Colors.BRAND} disabled={sending} onClick={() => handleSendPending()}>
                                            {sending ? "Sending…" : "Send"}
                                        </Button>
                                    </div>
                                    {/* Stage to real chat input for @mention support */}
                                    <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                                        <Text variant="text-xs/normal" style={{ color: "var(--text-muted)", flex: 1 }}>
                                            Need to @mention someone?
                                        </Text>
                                        <Tooltip text="Close this modal and type your message in the real chat input - full @mention autocomplete works there">
                                            {({ onMouseEnter, onMouseLeave }) => (
                                                <Button
                                                    size={Button.Sizes.SMALL}
                                                    look={Button.Looks.LINK}
                                                    onClick={handleStageToChat}
                                                    onMouseEnter={onMouseEnter}
                                                    onMouseLeave={onMouseLeave}
                                                    style={{ color: "#00a8fc", padding: "0" }}
                                                >
                                                    Use chat input instead →
                                                </Button>
                                            )}
                                        </Tooltip>
                                    </div>
                                    {status && <Text variant="text-sm/normal" style={{ color: "var(--text-muted)" }}>⏳ {status}</Text>}
                                    {error  && <Text variant="text-sm/normal" style={{ color: "var(--status-danger)" }}>✗ {error}</Text>}
                                </div>
                            ) : (
                                <Text variant="text-xs/normal" style={{ color: "var(--text-muted)" }}>
                                    {visible.length} sticker{visible.length !== 1 ? "s" : ""} shown
                                    {deleteMode && " · Delete mode ON — click a sticker to hide it"}
                                    {error && ` · ✗ ${error}`}
                                </Text>
                            )}
                        </div>
                    </div>
                )}
            </ModalContent>
        </ModalRoot>
    );
}

//  Chat bar button 

function InfiniteStickersButton({ channel }: { channel: { id: string } }) {
    return (
        <>
            {/* Staged sticker indicator — shows when a sticker is staged to this channel */}
            <StagedStickerIndicator channel={channel} />

            <Tooltip text="Infinite Stickers">
                {({ onMouseEnter, onMouseLeave }) => (
                    <div
                        role="button"
                        aria-label="Infinite Stickers"
                        style={{ cursor: "pointer", padding: "0 4px", display: "flex", alignItems: "center", color: "#b5bac1" }}
                        onMouseEnter={e => { onMouseEnter(); }}
                        onMouseLeave={e => { onMouseLeave(); }}
                        onClick={() => openModal(props => <StickerPickerModal modalProps={props} channelId={channel.id} />)}
                    >
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M18.5 2h-13A3.5 3.5 0 0 0 2 5.5v13A3.5 3.5 0 0 0 5.5 22H12a.5.5 0 0 0 .354-.146l9.5-9.5A.5.5 0 0 0 22 12V5.5A3.5 3.5 0 0 0 18.5 2ZM13 20.293V14.5a1.5 1.5 0 0 1 1.5-1.5h5.793L13 20.293ZM21 12h-6.5A2.5 2.5 0 0 0 12 14.5V21H5.5A2.5 2.5 0 0 1 3 18.5v-13A2.5 2.5 0 0 1 5.5 3h13A2.5 2.5 0 0 1 21 5.5V12Z" />
                            <circle cx="8.5" cy="8.5" r="1.5" />
                            <circle cx="14" cy="7" r="1.5" />
                            <path d="M7 13.5c.6 1.8 2.2 3 4 3s3.4-1.2 4-3" stroke="currentColor" strokeWidth="1.3" fill="none" strokeLinecap="round" />
                        </svg>
                    </div>
                )}
            </Tooltip>
        </>
    );
}

//  Plugin 

export default definePlugin({
    name:        "InfiniteStickers",
    description: "Send stickers from a GitHub-hosted collection. Stickers are briefly uploaded to a transit server and sent as real sticker messages.",
    authors:     [{ name: "DogeTennant", id: 0n }],

    dependencies: ["ChatInputButtonAPI"],
    settings,

    patches: [
        {
            find: "canUseSticker",
            replacement: {
                match:   /canUseSticker\((\i),(\i)\)\{/,
                replace: "canUseSticker($1,$2){if($2?.guild_id&&$1?.getGuild?.($2.guild_id))return true;",
            },
        },
    ],

    start() {
        addChatBarButton("InfiniteStickers", InfiniteStickersButton, () => null);
        // Capture phase so we fire before Discord's Slate editor handles Enter
        document.addEventListener("keydown", handleStagedEnter, true);
        if (settings.store.manifestUrl) {
            fetchManifest().catch(console.error);
        }
    },

    stop() {
        removeChatBarButton("InfiniteStickers");
        document.removeEventListener("keydown", handleStagedEnter, true);
        // Clear any staged sticker on disable
        _stagedSticker = null;
        _stagedChannel = "";
        notifyStaged();
    },
});
