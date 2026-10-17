import { App, Modal, Notice, Setting } from 'obsidian';
import type TeamPlugin from '../main';
import { TeamDocument } from '../types/document';
import { TeamMember } from '../types/team';
import { getErrorMessage } from '../utils/api';

interface DocComment {
    id: string;
    authorName: string;
    quote: string;
    body: string;
    mentions?: string[];
    createdAt: number;
}

export class CommentModal extends Modal {
    private readonly plugin: TeamPlugin;
    private readonly teamId: string;
    private readonly teamDoc: TeamDocument;
    private quote = '';
    private body = '';
    private bodyEl: HTMLTextAreaElement | null = null;
    private members: TeamMember[] = [];
    private listEl: HTMLElement | null = null;

    constructor(app: App, plugin: TeamPlugin, teamId: string, doc: TeamDocument, quote = '') {
        super(app);
        this.plugin = plugin;
        this.teamId = teamId;
        this.teamDoc = doc;
        this.quote = quote;
    }

    onOpen(): void {
        this.modalEl.addClass('team-comment-modal');
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h3', { text: '文档评论' });
        contentEl.createEl('p', { text: this.teamDoc.path.split('/').pop() || this.teamDoc.path });

        this.listEl = contentEl.createDiv('comment-list');
        this.listEl.createEl('p', { text: '正在加载评论...' });

        if (this.quote) {
            contentEl.createEl('blockquote', { text: this.quote });
        }

        const mentionRow = contentEl.createDiv('comment-mentions');
        mentionRow.createSpan({ text: '提及', cls: 'comment-hint' });

        contentEl.createEl('p', { text: '点成员名字插入 @，对方会收到通知。', cls: 'comment-hint' });

        new Setting(contentEl)
            .setName('评论')
            .addTextArea(text => {
                this.bodyEl = text.inputEl;
                text.setPlaceholder('写下评论，或点上面的成员插入 @')
                    .onChange(value => {
                        this.body = value;
                    });
            });
        new Setting(contentEl)
            .addButton(button => button
                .setButtonText('发表')
                .setCta()
                .onClick(() => {
                    void this.publish();
                }));

        void this.load(mentionRow);
    }

    onClose(): void {
        this.contentEl.empty();
    }

    private async load(mentionRow: HTMLElement): Promise<void> {
        try {
            const team = await this.plugin.teamManager.getTeam(this.teamId);
            this.members = team.members;
        } catch (error: unknown) {
            mentionRow.createSpan({ text: getErrorMessage(error) || '成员加载失败', cls: 'comment-hint' });
        }
        this.renderMentionChips(mentionRow);
        await this.reloadComments();
    }

    private renderMentionChips(mentionRow: HTMLElement): void {
        const others = this.members.filter(member => member.userId !== this.plugin.settings.userId);
        if (others.length === 0) {
            mentionRow.createSpan({ text: '团队里还没有其他成员', cls: 'comment-hint' });
            return;
        }
        for (const member of others) {
            const chip = mentionRow.createEl('button', {
                text: `@${member.username}`,
                cls: 'comment-mention-btn',
            });
            chip.type = 'button';
            chip.addEventListener('click', () => this.insertMention(member.username));
        }
    }

    private insertMention(username: string): void {
        const token = `@${username} `;
        const input = this.bodyEl;
        if (!input) {
            this.body += token;
            return;
        }
        const start = input.selectionStart ?? input.value.length;
        const end = input.selectionEnd ?? start;
        const next = input.value.slice(0, start) + token + input.value.slice(end);
        input.value = next;
        this.body = next;
        const cursor = start + token.length;
        input.setSelectionRange(cursor, cursor);
        input.focus();
    }

    private async reloadComments(): Promise<void> {
        const list = this.listEl;
        if (!list) return;
        try {
            const comments = await this.plugin.teamManager.getComments(this.teamId, this.teamDoc.id);
            list.empty();
            if (comments.length === 0) {
                list.createEl('p', { text: '还没有评论', cls: 'empty-message' });
                return;
            }
            for (const comment of comments) {
                this.renderComment(list, comment);
            }
        } catch (error: unknown) {
            list.empty();
            list.createEl('p', { text: getErrorMessage(error) || '评论加载失败' });
        }
    }

    private renderComment(list: HTMLElement, comment: DocComment): void {
        const item = list.createDiv('comment-item');
        item.createDiv({
            text: `${comment.authorName} · ${new Date(comment.createdAt).toLocaleString()}`,
            cls: 'comment-meta',
        });
        if (comment.quote) {
            item.createEl('blockquote', { text: comment.quote });
        }
        this.renderBody(item, comment.body);
        const mentioned = this.mentionNames(comment);
        if (mentioned.length > 0) {
            item.createDiv({ text: `提及了 ${mentioned.join('、')}`, cls: 'comment-mentioned' });
        }
    }

    private mentionNames(comment: DocComment): string[] {
        const ids = new Set(comment.mentions || []);
        return this.members
            .filter(member => ids.has(member.userId))
            .map(member => member.username);
    }

    private renderBody(parent: HTMLElement, body: string): void {
        const paragraph = parent.createEl('p');
        const known = new Set(this.members.map(member => member.username));
        const pattern = /@([^\s@]{1,20})/g;
        let last = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(body)) !== null) {
            if (match.index > last) paragraph.appendText(body.slice(last, match.index));
            const name = match[1];
            if (known.has(name)) {
                paragraph.createSpan({ text: `@${name}`, cls: 'comment-mention' });
            } else {
                paragraph.appendText(match[0]);
            }
            last = match.index + match[0].length;
        }
        if (last < body.length) paragraph.appendText(body.slice(last));
    }

    private async publish(): Promise<void> {
        const body = (this.bodyEl?.value || this.body).trim();
        if (!body) {
            new Notice('评论不能为空');
            return;
        }
        try {
            await this.plugin.teamManager.addComment(this.teamId, this.teamDoc.id, this.quote, body);
            this.body = '';
            if (this.bodyEl) this.bodyEl.value = '';
            new Notice('评论已发表');
            await this.reloadComments();
        } catch (error: unknown) {
            new Notice(getErrorMessage(error) || '发表失败');
        }
    }
}
