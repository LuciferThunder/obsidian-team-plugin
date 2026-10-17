import { App, requestUrl } from 'obsidian';
import { Team, TeamMember, TeamRole, TeamInvitation, TeamSettings } from '../types/team';
import { TeamPluginSettings } from '../types';
import { DocumentHistoryEntry, DocumentHistorySnapshot, TeamDocument } from '../types/document';
import { extractApiError, getErrorMessage, readResponseJson } from '../utils/api';

export interface TeamMention {
    id: string;
    actorName: string;
    fileId: string;
    filePath: string;
    kind: string;
    excerpt: string;
    createdAt: number;
}

export class TeamManager {
    private app: App;
    private settings: TeamPluginSettings;
    private currentTeam: Team | null = null;

    constructor(app: App, settings: TeamPluginSettings) {
        this.app = app;
        this.settings = settings;
    }

    updateSettings(settings: TeamPluginSettings): void {
        this.settings = settings;
    }

    private getApiUrl(path: string): string {
        return `${this.settings.serverUrl}${path}`;
    }

    private async request<T>(path: string, method: string, body?: unknown): Promise<T> {
        const url = this.getApiUrl(path);
        console.debug(`[TeamManager] ${method} ${url}`, {
            hasToken: !!this.settings.apiKey,
            userId: this.settings.userId,
        });

        try {
            const headers: Record<string, string> = {
                'Authorization': `Bearer ${this.settings.apiKey}`,
                'X-User-Id': this.settings.userId || '',
            };

            if (body) {
                headers['Content-Type'] = 'application/json';
            }

            const response = await requestUrl({
                url,
                method,
                headers,
                body: body ? JSON.stringify(body) : undefined,
                throw: false, // 不自动抛错，自行解析 4xx 响应体中的 error 信息
            });

            if (response.status >= 400) {
                const apiError = extractApiError(response.json);
                throw new Error(apiError ?? `请求失败 (${response.status})`);
            }

            // 如果服务端返回 204 No Content，或者响应体本身为空，则不必尝试解析 JSON
            if (response.status === 204 || !response.text) {
                return {} as T;
            }

            return readResponseJson<T>(response);
        } catch (error: unknown) {
            console.error(`[TeamManager] ${method} ${url} failed:`, error);
            throw new Error(getErrorMessage(error));
        }
    }

    // ========== Team Operations ==========

    /**
     * Create a new team
     */
    async createTeam(name: string, description: string): Promise<Team> {
        const team = await this.request<Team>('/api/teams', 'POST', {
            name,
            description,
        });
        this.currentTeam = team;
        return team;
    }

    /**
     * Get team by ID
     */
    async getTeam(teamId: string): Promise<Team> {
        return await this.request<Team>(`/api/teams/${teamId}`, 'GET');
    }

    /**
     * Get all teams for current user
     */
    async getMyTeams(): Promise<Team[]> {
        return await this.request<Team[]>('/api/teams', 'GET');
    }

    /**
     * Update team settings
     */
    async updateTeamProfile(teamId: string, profile: { name: string; description: string }): Promise<Team> {
        const team = await this.request<Team>(`/api/teams/${teamId}`, 'PATCH', profile);
        if (this.currentTeam?.id === teamId) {
            this.currentTeam = team;
        }
        return team;
    }

    async updateTeamSettings(teamId: string, settings: Partial<TeamSettings>): Promise<Team> {
        return await this.request<Team>(`/api/teams/${teamId}/settings`, 'PATCH', settings);
    }

    /**
     * Delete a team (owner only)
     */
    async deleteTeam(teamId: string): Promise<void> {
        await this.request<void>(`/api/teams/${teamId}`, 'DELETE');
        if (this.currentTeam?.id === teamId) {
            this.currentTeam = null;
        }
    }

    // ========== Member Operations ==========

    /**
     * Invite a member to team
     */
    async inviteMember(teamId: string, email: string, role: TeamRole = 'member'): Promise<TeamInvitation> {
        return await this.request<TeamInvitation>(`/api/teams/${teamId}/invitations`, 'POST', {
            email,
            role,
        });
    }

    /**
     * Accept team invitation
     */
    async acceptInvitation(invitationId: string): Promise<Team> {
        return await this.request<Team>(`/api/invitations/${invitationId}/accept`, 'POST');
    }

    /**
     * Reject team invitation
     */
    async rejectInvitation(invitationId: string): Promise<void> {
        await this.request<void>(`/api/invitations/${invitationId}/reject`, 'POST');
    }

    /**
     * Get pending invitations for current user
     */
    async getMyInvitations(): Promise<TeamInvitation[]> {
        return await this.request<TeamInvitation[]>('/api/invitations', 'GET');
    }

    /**
     * Remove a member from team
     */
    async removeMember(teamId: string, userId: string): Promise<void> {
        await this.request<void>(`/api/teams/${teamId}/members/${userId}`, 'DELETE');
    }

    /**
     * Update member role
     */
    async updateMemberRole(teamId: string, userId: string, role: TeamRole): Promise<TeamMember> {
        return await this.request<TeamMember>(`/api/teams/${teamId}/members/${userId}`, 'PATCH', {
            role,
        });
    }

    /**
     * Leave a team
     */
    async leaveTeam(teamId: string): Promise<void> {
        await this.request<void>(`/api/teams/${teamId}/leave`, 'POST');
        if (this.currentTeam?.id === teamId) {
            this.currentTeam = null;
        }
    }

    // ========== Getters ==========

    getCurrentTeam(): Team | null {
        return this.currentTeam;
    }

    setCurrentTeam(team: Team | null): void {
        this.currentTeam = team;
    }

    /**
     * Check if current user has permission
     */
    hasPermission(permission: 'manage_members' | 'manage_settings' | 'delete_team'): boolean {
        if (!this.currentTeam) return false;

        const member = this.currentTeam.members.find(m => m.userId === this.settings.userId);
        if (!member) return false;

        switch (permission) {
            case 'manage_members':
                return member.role === 'owner' || member.role === 'admin';
            case 'manage_settings':
                return member.role === 'owner' || member.role === 'admin';
            case 'delete_team':
                return member.role === 'owner';
            default:
                return false;
        }
    }

    // ========== Team Drive (Cloud Documents) Operations ==========

    /**
     * Get all documents in the team drive
     */
    async getTeamDocuments(teamId: string): Promise<TeamDocument[]> {
        return await this.request<TeamDocument[]>(`/api/collab/${teamId}/files`, 'GET');
    }

    /**
     * Create a new document in the team drive
     */
    async createTeamDocument(teamId: string, path: string, content: string = ''): Promise<TeamDocument> {
        return await this.request<TeamDocument>(`/api/collab/${teamId}/files`, 'POST', {
            path,
            content
        });
    }

    /**
     * Rename a document in the team drive
     */
    async renameTeamDocument(teamId: string, documentId: string, newPath: string): Promise<TeamDocument> {
        return await this.request<TeamDocument>(`/api/collab/${teamId}/files/${documentId}`, 'PATCH', {
            path: newPath,
        });
    }

    /**
     * Delete a document from the team drive
     */
    async deleteTeamDocument(teamId: string, documentId: string): Promise<void> {
        await this.request<void>(`/api/collab/${teamId}/files/${documentId}`, 'DELETE');
    }

    /**
     * Get histories of a document
     */
    async getTeamDocumentHistories(teamId: string, documentId: string): Promise<DocumentHistoryEntry[]> {
        return await this.request<DocumentHistoryEntry[]>(`/api/collab/${teamId}/files/${documentId}/history`, 'GET');
    }

    /**
     * Get a specific history snapshot full content
     */
    async getTeamDocumentHistorySnapshot(teamId: string, documentId: string, historyId: string): Promise<DocumentHistorySnapshot> {
        return await this.request<DocumentHistorySnapshot>(`/api/collab/${teamId}/files/${documentId}/history/${historyId}`, 'GET');
    }

    async searchDocuments(teamId: string, query: string): Promise<Array<{ id: string; path: string; permission?: string; lastEditorName?: string }>> {
        return await this.request(`/api/collab/${teamId}/search?q=${encodeURIComponent(query)}`, 'GET');
    }

    async getComments(teamId: string, fileId: string): Promise<Array<{ id: string; authorName: string; quote: string; body: string; mentions?: string[]; createdAt: number }>> {
        return await this.request(`/api/collab/${teamId}/files/${fileId}/comments`, 'GET');
    }

    async addComment(teamId: string, fileId: string, quote: string, body: string): Promise<void> {
        await this.request(`/api/collab/${teamId}/files/${fileId}/comments`, 'POST', { quote, body });
    }

    async notifyMention(teamId: string, fileId: string, username: string, excerpt: string): Promise<void> {
        await this.request(`/api/collab/${teamId}/files/${fileId}/mentions`, 'POST', { username, excerpt });
    }

    async getMentions(teamId: string): Promise<TeamMention[]> {
        return await this.request<TeamMention[]>(`/api/teams/${teamId}/mentions`, 'GET');
    }

    async setDocumentPermission(teamId: string, fileId: string, permission: 'read' | 'write'): Promise<void> {
        await this.request(`/api/collab/${teamId}/files/${fileId}/permission`, 'PATCH', { permission });
    }

    async getActivity(teamId: string): Promise<Array<{ actorName: string; action: string; detail: string; createdAt: number }>> {
        return await this.request(`/api/teams/${teamId}/activity`, 'GET');
    }
}
