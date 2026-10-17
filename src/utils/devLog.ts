let enabled = false;

export function setDevLogEnabled(on: boolean): void {
    enabled = on;
}

/** 生产构建保持空操作。开发构建会由 esbuild 换成真正的控制台输出。 */
export function devLog(_message: string, _detail?: unknown): void {
    void enabled;
}
