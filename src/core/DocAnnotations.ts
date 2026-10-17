import { Notice } from 'obsidian';
import { Facet, StateEffect } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, ViewUpdate, type DecorationSet } from '@codemirror/view';
import { getErrorMessage } from '../utils/api';

interface AnnotationComment {
    id: string;
    authorName: string;
    quote: string;
    body: string;
    mentions?: string[];
    createdAt: number;
}

interface AnnotationMember {
    userId: string;
    username: string;
}

export interface AnnotationHost {
    settings: { userId: string };
    teamManager: {
        getComments(teamId: string, fileId: string): Promise<AnnotationComment[]>;
        addComment(teamId: string, fileId: string, quote: string, body: string): Promise<void>;
        getTeam(teamId: string): Promise<{ members: AnnotationMember[] }>;
    };
}

interface AnnotationOptions {
    teamId: string;
    documentId: string;
    host: AnnotationHost;
}

interface QuoteRange {
    from: number;
    to: number;
    quote: string;
}

const annotationConfig = Facet.define<AnnotationOptions, AnnotationOptions | null>({
    combine: values => values[0] ?? null,
});

/** 只刷新高亮，不改文档内容。空 dispatch 会让协同插件去写只读的 doc。 */
const refreshAnnotations = StateEffect.define<null>();

class AnnotationLayer {
    decorations: DecorationSet = Decoration.none;
    private comments: AnnotationComment[] = [];
    private ranges: QuoteRange[] = [];
    private members: AnnotationMember[] = [];
    private readonly button: HTMLButtonElement;
    private popover: HTMLElement | null = null;
    private readonly onDocPointerDown: (event: Event) => void;
    private reloadTimer: number | null = null;

    constructor(private readonly view: EditorView) {
        const doc = view.dom.ownerDocument;
        this.button = createEl('button', { cls: 'team-annotate-btn', text: '标注' });
        this.button.type = 'button';
        this.button.hidden = true;
        this.button.addEventListener('mousedown', event => {
            event.preventDefault();
            event.stopPropagation();
        });
        this.button.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            this.openForSelection();
        });
        doc.body.appendChild(this.button);
        window.setTimeout(() => {
            void this.reload();
        }, 0);

        this.onDocPointerDown = (event: Event) => {
            const target = event.target as Node | null;
            if (!target) return;
            if (this.popover?.contains(target) || this.button.contains(target)) return;
            this.closePopover();
        };
        doc.addEventListener('pointerdown', this.onDocPointerDown, true);
        void this.reload();
        this.reloadTimer = window.setInterval(() => {
            void this.reload();
        }, 20000);
    }

    destroy(): void {
        if (this.reloadTimer !== null) window.clearInterval(this.reloadTimer);
        this.view.dom.ownerDocument.removeEventListener('pointerdown', this.onDocPointerDown, true);
        this.button.remove();
        this.closePopover();
    }

    update(update: ViewUpdate): void {
        const refresh = update.transactions.some(tr => tr.effects.some(effect => effect.is(refreshAnnotations)));
        if (update.docChanged || refresh) {
            this.rebuildDecorations(update.state.doc.toString());
        }
        this.placeButton();
    }

    handleClick(event: MouseEvent): boolean {
        if (!this.view.state.selection.main.empty) return false;
        const target = event.target as HTMLElement | null;
        if (!target?.closest('.team-annotation')) return false;
        const pos = this.view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (pos == null) return false;
        const hit = this.ranges.find(range => pos >= range.from && pos <= range.to);
        if (!hit) return false;
        event.preventDefault();
        const coords = this.view.coordsAtPos(hit.to);
        this.openPopover(hit.quote, coords ? { left: coords.left, top: coords.bottom + 8 } : null);
        return true;
    }

    private options(): AnnotationOptions | null {
        return this.view.state.facet(annotationConfig);
    }

    private async reload(): Promise<void> {
        const options = this.options();
        if (!options) return;
        try {
            this.comments = await options.host.teamManager.getComments(options.teamId, options.documentId);
            if (!this.view.dom.isConnected) return;
            this.rebuildDecorations(this.view.state.doc.toString());
            // 不在协同更新过程中改文档。只发一个不影响正文的刷新。
            window.setTimeout(() => {
                if (!this.view.dom.isConnected) return;
                try {
                    this.view.dispatch({ effects: refreshAnnotations.of(null) });
                } catch (error) {
                    console.error('[Annotation] 刷新高亮失败', error);
                }
            }, 0);
        } catch (error: unknown) {
            console.error('[Annotation] 加载标注失败', error);
        }
    }

    private rebuildDecorations(text: string): void {
        const ranges: QuoteRange[] = [];
        const seen = new Set<string>();
        for (const comment of this.comments) {
            const quote = comment.quote.trim();
            if (!quote || seen.has(quote)) continue;
            seen.add(quote);
            let start = 0;
            while (start < text.length) {
                const index = text.indexOf(quote, start);
                if (index < 0) break;
                ranges.push({ from: index, to: index + quote.length, quote });
                start = index + quote.length;
            }
        }
        ranges.sort((a, b) => a.from - b.from || a.to - b.to);
        const kept: QuoteRange[] = [];
        let last = -1;
        for (const range of ranges) {
            if (range.from < last) continue;
            kept.push(range);
            last = range.to;
        }
        this.ranges = kept;
        this.decorations = Decoration.set(kept.map(range => {
            const related = this.comments.filter(comment => comment.quote.trim() === range.quote);
            const preview = related.map(comment => `${comment.authorName}: ${comment.body}`).join('\n');
            return Decoration.mark({
                class: 'team-annotation',
                attributes: { title: preview },
            }).range(range.from, range.to);
        }));
    }

    private placeButton(): void {
        if (this.popover) {
            this.button.hidden = true;
            return;
        }
        const selection = this.view.state.selection.main;
        const quote = selection.empty ? '' : this.view.state.sliceDoc(selection.from, selection.to).trim();
        if (!quote) {
            this.button.hidden = true;
            return;
        }
        const coords = this.view.coordsAtPos(selection.to);
        if (!coords) {
            this.button.hidden = true;
            return;
        }
        this.button.hidden = false;
        this.button.style.left = `${coords.left}px`;
        this.button.style.top = `${coords.bottom + 6}px`;
    }

    private openForSelection(): void {
        const selection = this.view.state.selection.main;
        const quote = this.view.state.sliceDoc(selection.from, selection.to).trim();
        if (!quote) return;
        const clipped = quote.length > 300 ? quote.slice(0, 300) : quote;
        const coords = this.view.coordsAtPos(selection.to);
        this.openPopover(clipped, coords ? { left: coords.left, top: coords.bottom + 8 } : null);
    }

    private openPopover(quote: string, anchor: { left: number; top: number } | null): void {
        this.closePopover();
        const doc = this.view.dom.ownerDocument;
        const popover = createDiv({ cls: 'team-annotation-popover' });
        popover.appendChild(createEl('blockquote', { text: quote }));

        const list = popover.createDiv({ cls: 'comment-list' });
        this.renderThread(list, quote);

        const mentionRow = popover.createDiv({ cls: 'comment-mentions' });

        const input = popover.createEl('textarea', { cls: 'team-annotation-input' });
        input.placeholder = '写下标注，点成员或输入 @名字，对方会收到通知';

        const actions = popover.createDiv({ cls: 'team-annotation-actions' });
        const submit = actions.createEl('button', { cls: 'mod-cta', text: '发表' });
        submit.type = 'button';
        submit.addEventListener('click', () => {
            void this.publish(quote, input, submit, list);
        });

        const left = Math.max(8, Math.min(anchor?.left ?? 24, window.innerWidth - 340));
        const top = Math.max(8, Math.min(anchor?.top ?? 24, window.innerHeight - 280));
        popover.style.left = `${left}px`;
        popover.style.top = `${top}px`;
        doc.body.appendChild(popover);
        this.popover = popover;
        this.button.hidden = true;
        void this.fillMembers(mentionRow, input);
        input.focus();
    }

    private renderThread(list: HTMLElement, quote: string): void {
        list.replaceChildren();
        const related = this.comments.filter(comment => comment.quote.trim() === quote);
        if (related.length === 0) {
            list.createEl('p', { cls: 'comment-hint', text: '这段还没有标注' });
            return;
        }
        for (const comment of related) {
            const item = list.createDiv({ cls: 'comment-item' });
            item.createDiv({
                cls: 'comment-meta',
                text: `${comment.authorName} · ${new Date(comment.createdAt).toLocaleString()}`,
            });
            item.createEl('p', { text: comment.body });
            const names = this.members
                .filter(member => (comment.mentions || []).includes(member.userId))
                .map(member => member.username);
            if (names.length > 0) {
                item.createDiv({ cls: 'comment-mentioned', text: `提及了 ${names.join('、')}` });
            }
        }
    }

    private async fillMembers(row: HTMLElement, input: HTMLTextAreaElement): Promise<void> {
        const options = this.options();
        if (!options) return;
        try {
            if (this.members.length === 0) {
                const team = await options.host.teamManager.getTeam(options.teamId);
                this.members = team.members;
            }
        } catch (error: unknown) {
            row.appendChild(createSpan({ cls: 'comment-hint', text: getErrorMessage(error) || '成员加载失败' }));
            return;
        }
        const others = this.members.filter(member => member.userId !== options.host.settings.userId);
        for (const member of others) {
            const chip = createEl('button', { cls: 'comment-mention-btn', text: `@${member.username}` });
            chip.type = 'button';
            chip.addEventListener('click', () => {
                const token = `@${member.username} `;
                const start = input.selectionStart ?? input.value.length;
                const end = input.selectionEnd ?? start;
                input.value = input.value.slice(0, start) + token + input.value.slice(end);
                const cursor = start + token.length;
                input.setSelectionRange(cursor, cursor);
                input.focus();
            });
            row.appendChild(chip);
        }
    }

    private async publish(quote: string, input: HTMLTextAreaElement, submit: HTMLButtonElement, list: HTMLElement): Promise<void> {
        const options = this.options();
        const body = input.value.trim();
        if (!options || !body) {
            new Notice('标注不能为空');
            return;
        }
        submit.disabled = true;
        try {
            await options.host.teamManager.addComment(options.teamId, options.documentId, quote, body);
            input.value = '';
            await this.reload();
            this.renderThread(list, quote);
            new Notice('标注已加在这段文字上');
        } catch (error: unknown) {
            new Notice(getErrorMessage(error) || '发表失败');
        } finally {
            submit.disabled = false;
        }
    }

    private closePopover(): void {
        this.popover?.remove();
        this.popover = null;
    }
}

const annotationPlugin = ViewPlugin.fromClass(AnnotationLayer, {
    decorations: value => value.decorations,
});

export function teamAnnotationExtension(options: AnnotationOptions) {
    return [
        annotationConfig.of(options),
        annotationPlugin,
        EditorView.domEventHandlers({
            click(event, view) {
                return view.plugin(annotationPlugin)?.handleClick(event) ?? false;
            },
        }),
    ];
}
