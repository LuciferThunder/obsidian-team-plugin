function pad2(value: number): string {
    return value < 10 ? `0${value}` : String(value);
}

export function startOfLocalDay(now = new Date()): number {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

export function endOfLocalDay(now = new Date()): number {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999).getTime();
}

export function startOfLocalMonth(now = new Date()): number {
    return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
}

export function endOfLocalMonth(now = new Date()): number {
    return new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999).getTime();
}

export function formatYearMonthDay(timestamp: number): string {
    const date = new Date(timestamp);
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

export function formatYearMonth(timestamp: number): string {
    const date = new Date(timestamp);
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`;
}

export function formatChineseMonth(timestamp: number): string {
    const date = new Date(timestamp);
    return `${date.getFullYear()}年${pad2(date.getMonth() + 1)}月`;
}

export function formatHourMinute(timestamp: number): string {
    const date = new Date(timestamp);
    return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

export function formatDateTime(timestamp: number): string {
    return `${formatYearMonthDay(timestamp)} ${formatHourMinute(timestamp)}`;
}
