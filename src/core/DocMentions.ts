import { Notice } from 'obsidian';
import { Annotation, Facet, StateEffect } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, ViewUpdate, type DecorationSet } from '@codemirror/view';
import { getErrorMessage } from '../utils/api';

interface MentionMember {
    userId: string;
    username: string;
}

export interface MentionHost {
    settings: { userId: string };
    teamManager: {
        getTeam(teamId: string): Promise<{ members: MentionMember[] }>;
        notifyMention(teamId: string, fileId: string, username: string, excerpt: string): Promise<void>;
    };
}

interface MentionOptions {
    teamId: string;
    documentId: string;
    readOnly: boolean;
    host: MentionHost;
}

interface MentionQuery {
    from: number;
    to: number;
    query: string;
}

const mentionConfig = Facet.define<MentionOptions, MentionOptions | null>({
    combine: values => values[0] ?? null,
});

const mentionCommit = Annotation.define<boolean>();
const mentionMembersReady = StateEffect.define<null>();
const nameBoundary = String.raw`[\s，。！？、；：,.!?;:）)\]】]`;
const completedMention = new RegExp(String.raw`@([^\s@]{1,20})(?=${nameBoundary})`, 'g');

class MentionLayer {
    decorations: DecorationSet = Decoration.none;
    private members: MentionMember[] = [];
    private membersLoaded = false;
    private activeIndex = 0;
    private renderedQuery = '';
    private readonly popup: HTMLDivElement;
    private readonly onDocPointerDown: (event: Event) => void;

    constructor(private readonly view: EditorView) {
        const doc = view.dom.ownerDocument;
        this.popup = createDiv({ cls: 'team-mention-popup' });
        this.popup.hidden = true;
        doc.body.appendChild(this.popup);
        this.onDocPointerDown = (event: Event) => {
            const target = event.target as Node | null;
            if (!target || this.popup.contains(target)) return;
            this.closePopup();
        };
        doc.addEventListener('pointerdown', this.onDocPointerDown, true);
        void this.loadMembers();
    }

    destroy(): void {
        this.view.dom.ownerDocument.removeEventListener('pointerdown', this.onDocPointerDown, true);
        this.popup.remove();
    }

    update(update: ViewUpdate): void {
        const membersReady = update.transactions.some(tr => tr.effects.some(effect => effect.is(mentionMembersReady)));
        if (update.docChanged || membersReady) {
            this.rebuildDecorations(update.state.doc.toString());
        }
        if (update.docChanged || update.selectionSet || membersReady) {
            this.placePopup();
        }
        this.scanCompleted(update);
    }

    handleKey(event: KeyboardEvent): boolean {
        if (this.popup.hidden) return false;
        const items = this.visibleMembers();
        if (event.key === 'Escape') {
            event.preventDefault();
            this.closePopup();
            return true;
        }
        if (items.length === 0) return false;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            const step = event.key === 'ArrowDown' ? 1 : -1;
            this.activeIndex = (this.activeIndex + step + items.length) % items.length;
            this.paintActive();
            return true;
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
            event.preventDefault();
            this.choose(items[this.activeIndex]?.username);
            return true;
        }
        return false;
    }

    private options(): MentionOptions | null {
        return this.view.state.facet(mentionConfig);
    }

    private async loadMembers(): Promise<void> {
        const options = this.options();
        if (!options) return;
        try {
            const team = await options.host.teamManager.getTeam(options.teamId);
            this.members = team.members;
        } catch (error: unknown) {
            console.error('[Mention] 成员加载失败', error);
        }
        this.membersLoaded = true;
        if (!this.view.dom.isConnected) return;
        window.setTimeout(() => {
            if (!this.view.dom.isConnected) return;
            try {
                this.view.dispatch({ effects: mentionMembersReady.of(null) });
            } catch (error) {
                console.error('[Mention] 刷新提及高亮失败', error);
            }
        }, 0);
    }

    private others(): MentionMember[] {
        const selfId = this.options()?.host.settings.userId;
        return this.members.filter(member => member.userId !== selfId);
    }

    private visibleMembers(): MentionMember[] {
        const query = this.activeQuery();
        if (!query) return [];
        const needle = query.query.toLowerCase();
        return this.others()
            .filter(member => !needle || member.username.toLowerCase().startsWith(needle))
            .slice(0, 8);
    }

    private memberByName(name: string): MentionMember | undefined {
        const needle = name.toLowerCase();
        return this.members.find(member => member.username.toLowerCase() === needle);
    }

    private activeQuery(): MentionQuery | null {
        const options = this.options();
        if (!options || options.readOnly) return null;
        const selection = this.view.state.selection.main;
        if (!selection.empty) return null;
        const to = selection.head;
        const fromLimit = Math.max(0, to - 21);
        const before = this.view.state.sliceDoc(fromLimit, to);
        if (!/(^|[\s([{（【])@([^\s@]*)$/.test(before)) return null;
        const at = before.lastIndexOf('@');
        return { from: fromLimit + at, to, query: before.slice(at + 1) };
    }

    private placePopup(): void {
        const query = this.activeQuery();
        const coords = query ? this.view.coordsAtPos(query.to) : null;
        if (!query || !coords) {
            this.closePopup();
            return;
        }
        if (query.query !== this.renderedQuery) {
            this.activeIndex = 0;
            this.renderedQuery = query.query;
        }
        this.popup.hidden = false;
        this.popup.style.left = `${Math.max(8, Math.min(coords.left, window.innerWidth - 220))}px`;
        this.popup.style.top = `${Math.max(8, coords.bottom + 6)}px`;
        this.renderItems(query.query);
    }

    private renderItems(query: string): void {
        const items = this.visibleMembers();
        if (this.activeIndex >= items.length) this.activeIndex = 0;
        this.popup.replaceChildren();
        if (!this.membersLoaded) {
            this.popup.createDiv({ cls: 'team-mention-empty', text: '正在加载成员' });
            return;
        }
        if (items.length === 0) {
            this.popup.createDiv({
                cls: 'team-mention-empty',
                text: query ? '没有匹配的成员' : '团队里还没有其他成员',
            });
            return;
        }
        items.forEach((member, index) => {
            const button = createEl('button', {
                cls: index === this.activeIndex ? 'team-mention-item is-active' : 'team-mention-item',
                text: `@${member.username}`,
            });
            button.type = 'button';
            button.addEventListener('mousedown', event => {
                event.preventDefault();
                event.stopPropagation();
            });
            button.addEventListener('click', event => {
                event.preventDefault();
                event.stopPropagation();
                this.choose(member.username);
            });
            this.popup.appendChild(button);
        });
    }

    private paintActive(): void {
        const buttons = this.popup.querySelectorAll<HTMLButtonElement>('.team-mention-item');
        buttons.forEach((button, index) => {
            button.classList.toggle('is-active', index === this.activeIndex);
        });
        buttons[this.activeIndex]?.scrollIntoView({ block: 'nearest' });
    }

    private choose(username: string | undefined): void {
        if (!username) return;
        const query = this.activeQuery();
        if (!query) return;
        const insert = `@${username} `;
        this.view.dispatch({
            changes: { from: query.from, to: query.to, insert },
            selection: { anchor: query.from + insert.length },
            userEvent: 'input',
            annotations: mentionCommit.of(true),
        });
        this.closePopup();
        const excerpt = this.view.state.sliceDoc(
            Math.max(0, query.from - 12),
            Math.min(this.view.state.doc.length, query.from + insert.length + 24),
        ).replace(/\s+/g, ' ').trim();
        void this.notify(username, excerpt);
    }

    private scanCompleted(update: ViewUpdate): void {
        const options = this.options();
        if (!options || options.readOnly || !update.docChanged || !this.membersLoaded) return;
        const local = update.transactions.some(tr => tr.isUserEvent('input') || tr.isUserEvent('delete'));
        const committed = update.transactions.some(tr => tr.annotation(mentionCommit));
        if (!local || committed) return;
        const selfId = options.host.settings.userId;
        const docText = update.state.doc.toString();
        const sent = new Set<string>();
        update.changes.iterChanges((_fromA, _toA, fromB, toB) => {
            const start = Math.max(0, fromB - 21);
            const slice = docText.slice(start, toB);
            const pattern = new RegExp(completedMention.source, 'g');
            let match: RegExpExecArray | null;
            while ((match = pattern.exec(slice)) !== null) {
                const boundaryAt = start + match.index + match[0].length;
                if (boundaryAt < fromB || boundaryAt >= toB) continue;
                const member = this.memberByName(match[1]);
                if (!member || member.userId === selfId) continue;
                const excerpt = docText.slice(Math.max(0, start + match.index - 12), Math.min(docText.length, boundaryAt + 24))
                    .replace(/\s+/g, ' ')
                    .trim();
                const key = `${member.userId}:${excerpt}`;
                if (sent.has(key)) continue;
                sent.add(key);
                void this.notify(member.username, excerpt || `@${member.username}`);
            }
        });
    }

    private async notify(username: string, excerpt: string): Promise<void> {
        const options = this.options();
        if (!options) return;
        try {
            await options.host.teamManager.notifyMention(options.teamId, options.documentId, username, excerpt);
        } catch (error: unknown) {
            const message = getErrorMessage(error);
            new Notice(message.includes('404') ? '提及已写上，请重启团队服务后再通知对方' : (message || '通知对方失败'));
        }
    }

    private rebuildDecorations(text: string): void {
        const known = new Set(this.members.map(member => member.username.toLowerCase()));
        const marks = [];
        const pattern = new RegExp(completedMention.source, 'g');
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(text)) !== null) {
            if (!known.has(match[1].toLowerCase())) continue;
            marks.push(Decoration.mark({ class: 'team-mention' }).range(match.index, match.index + match[0].length));
        }
        this.decorations = marks.length > 0 ? Decoration.set(marks) : Decoration.none;
    }

    private closePopup(): void {
        this.popup.hidden = true;
        this.popup.replaceChildren();
        this.activeIndex = 0;
        this.renderedQuery = '';
    }
}

const mentionPlugin = ViewPlugin.fromClass(MentionLayer, {
    decorations: value => value.decorations,
});

export function teamMentionExtension(options: MentionOptions) {
    return [
        mentionConfig.of(options),
        mentionPlugin,
        EditorView.domEventHandlers({
            keydown(event, view) {
                return view.plugin(mentionPlugin)?.handleKey(event) ?? false;
            },
        }),
    ];
}
